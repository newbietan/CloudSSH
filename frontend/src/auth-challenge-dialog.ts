import { t } from './i18n';

const MAX_CHALLENGE_ID_LENGTH = 256;
const MAX_CHALLENGE_NAME_LENGTH = 256;
const MAX_CHALLENGE_INSTRUCTION_LENGTH = 64 * 1024;
const MAX_PROMPT_TEXT_LENGTH = 1024;
const MAX_PROMPT_COUNT = 32;
const MAX_RESPONSE_LENGTH = 16 * 1024;

// Keep line feeds for multi-line instructions, but remove terminal controls and
// bidirectional overrides that could make a remote prompt visually deceptive.
const DANGEROUS_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export interface AuthChallengePrompt {
  text: string;
  echo: boolean;
}

export interface AuthChallengeMessage {
  type: 'auth_challenge';
  id: string;
  name: string;
  instruction: string;
  prompts: AuthChallengePrompt[];
  canUseStoredPassword: boolean;
}

export type AuthChallengeSubmission =
  | { type: 'auth_response'; id: string; responses: string[] }
  | { type: 'auth_response'; id: string; useStoredPassword: true };

export interface AuthChallengeDialogOptions {
  host: string;
  port: number;
  onShown: (id: string) => void;
  onSubmit: (submission: AuthChallengeSubmission) => void;
  onCancel: (id: string) => void;
}

interface ActiveChallenge {
  challenge: AuthChallengeMessage;
  options: AuthChallengeDialogOptions;
  previousFocus: HTMLElement | null;
  inputs: HTMLInputElement[];
}

let dialogSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncateCodePoints(value: string, maxLength: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maxLength) return value;
  return `${codePoints.slice(0, maxLength).join('')}…`;
}

/** Sanitize remote-controlled display text without changing submitted responses. */
export function sanitizeAuthChallengeText(
  value: string,
  maxLength: number,
  multiline = false,
): string {
  let sanitized = value
    .replace(/\r\n?/g, '\n')
    .replace(DANGEROUS_CONTROL_CHARACTERS, '');

  sanitized = multiline
    ? sanitized.replace(/\t/g, '  ')
    : sanitized.replace(/[\n\t]+/g, ' ');

  return truncateCodePoints(sanitized, maxLength);
}

/** Validate the WebSocket payload and bound every remote-controlled UI field. */
export function normalizeAuthChallengeMessage(value: unknown): AuthChallengeMessage | null {
  if (!isRecord(value) || value.type !== 'auth_challenge') return null;
  if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > MAX_CHALLENGE_ID_LENGTH) {
    return null;
  }
  if (typeof value.name !== 'string' || typeof value.instruction !== 'string') return null;
  if (!Array.isArray(value.prompts) || value.prompts.length > MAX_PROMPT_COUNT) return null;

  const prompts: AuthChallengePrompt[] = [];
  for (const prompt of value.prompts) {
    if (!isRecord(prompt) || typeof prompt.text !== 'string' || typeof prompt.echo !== 'boolean') {
      return null;
    }
    prompts.push({
      text: sanitizeAuthChallengeText(prompt.text, MAX_PROMPT_TEXT_LENGTH, true),
      echo: prompt.echo,
    });
  }

  return {
    type: 'auth_challenge',
    id: value.id,
    name: sanitizeAuthChallengeText(
      value.name,
      MAX_CHALLENGE_NAME_LENGTH,
    ),
    instruction: sanitizeAuthChallengeText(
      value.instruction,
      MAX_CHALLENGE_INSTRUCTION_LENGTH,
      true,
    ),
    prompts,
    canUseStoredPassword: value.canUseStoredPassword === true,
  };
}

function appendTextElement(
  parent: HTMLElement,
  tagName: keyof HTMLElementTagNameMap,
  className: string,
  text: string,
): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function formatTarget(host: string, port: number): string {
  const safeHost = sanitizeAuthChallengeText(host, 512);
  const displayHost = safeHost.includes(':') && !safeHost.startsWith('[') ? `[${safeHost}]` : safeHost;
  return t('authChallenge.target', { host: displayHost || t('authChallenge.unknownHost'), port });
}

/** Dedicated RFC 4256 challenge dialog. One instance belongs to one terminal tab. */
export class AuthChallengeDialog {
  private dialog: HTMLDialogElement | null = null;
  private active: ActiveChallenge | null = null;

  show(payload: unknown, options: AuthChallengeDialogOptions): boolean {
    const challenge = normalizeAuthChallengeMessage(payload);
    if (!challenge) return false;

    // A new INFO_REQUEST starts the next round. Never retain the previous round's values.
    this.close(false);

    const sequence = ++dialogSequence;
    const titleId = `auth-challenge-title-${sequence}`;
    const descriptionId = `auth-challenge-description-${sequence}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'auth-challenge-dialog';
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-describedby', descriptionId);
    dialog.setAttribute('aria-modal', 'true');

    const form = document.createElement('form');
    form.className = 'auth-challenge-dialog__panel';
    form.method = 'dialog';
    form.noValidate = true;

    const accent = document.createElement('div');
    accent.className = 'auth-challenge-dialog__accent';
    accent.setAttribute('aria-hidden', 'true');

    const header = document.createElement('div');
    header.className = 'auth-challenge-dialog__header';
    const icon = appendTextElement(
      header,
      'span',
      'auth-challenge-dialog__icon material-symbols-outlined',
      'key',
    );
    icon.setAttribute('aria-hidden', 'true');
    const title = appendTextElement(header, 'h2', 'auth-challenge-dialog__title', t('authChallenge.title'));
    title.id = titleId;

    const target = appendTextElement(
      form,
      'p',
      'auth-challenge-dialog__target',
      formatTarget(options.host, options.port),
    );
    target.setAttribute('aria-label', target.textContent ?? '');

    const description = document.createElement('div');
    description.className = 'auth-challenge-dialog__description';
    description.id = descriptionId;
    appendTextElement(description, 'p', 'auth-challenge-dialog__warning', t('authChallenge.remoteRequest'));
    if (challenge.name) {
      appendTextElement(description, 'p', 'auth-challenge-dialog__name', challenge.name);
    }
    if (challenge.instruction) {
      appendTextElement(description, 'p', 'auth-challenge-dialog__instruction', challenge.instruction);
    }

    const promptList = document.createElement('div');
    promptList.className = 'auth-challenge-dialog__prompts';
    const inputs = challenge.prompts.map((prompt, index) => {
      const field = document.createElement('div');
      field.className = 'auth-challenge-dialog__field';

      const inputId = `auth-challenge-input-${sequence}-${index}`;
      const label = document.createElement('label');
      label.className = 'auth-challenge-dialog__label';
      label.htmlFor = inputId;
      label.textContent = prompt.text || t('authChallenge.promptFallback', { index: index + 1 });

      const input = document.createElement('input');
      input.className = 'auth-challenge-dialog__input';
      input.id = inputId;
      input.name = `response-${index}`;
      input.type = prompt.echo ? 'text' : 'password';
      input.autocomplete = 'off';
      input.autocapitalize = 'none';
      input.spellcheck = false;
      input.maxLength = MAX_RESPONSE_LENGTH;
      input.setAttribute('aria-describedby', `auth-challenge-hint-${sequence}`);

      field.append(label, input);
      promptList.appendChild(field);
      return input;
    });

    const sensitiveHint = appendTextElement(
      form,
      'p',
      'auth-challenge-dialog__hint',
      t('authChallenge.sensitiveHint'),
    );
    sensitiveHint.id = `auth-challenge-hint-${sequence}`;

    const actions = document.createElement('div');
    actions.className = 'auth-challenge-dialog__actions';
    const cancelButton = appendTextElement(
      actions,
      'button',
      'auth-challenge-dialog__button auth-challenge-dialog__button--cancel',
      t('common.cancel'),
    ) as HTMLButtonElement;
    cancelButton.type = 'button';

    let storedPasswordButton: HTMLButtonElement | null = null;
    if (
      challenge.canUseStoredPassword
      && challenge.prompts.length === 1
      && !challenge.prompts[0].echo
    ) {
      storedPasswordButton = appendTextElement(
        actions,
        'button',
        'auth-challenge-dialog__button auth-challenge-dialog__button--stored',
        t('authChallenge.useStoredPassword'),
      ) as HTMLButtonElement;
      storedPasswordButton.type = 'button';
    }

    const submitButton = appendTextElement(
      actions,
      'button',
      'auth-challenge-dialog__button auth-challenge-dialog__button--submit',
      t(challenge.prompts.length === 0 ? 'authChallenge.continue' : 'authChallenge.respond'),
    ) as HTMLButtonElement;
    submitButton.type = 'submit';

    form.prepend(accent, header);
    form.append(target, description, promptList, sensitiveHint, actions);
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    this.dialog = dialog;
    this.active = {
      challenge,
      options,
      previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      inputs,
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitResponses(dialog);
    });
    cancelButton.addEventListener('click', () => this.cancel(dialog));
    storedPasswordButton?.addEventListener('click', () => this.submitStoredPassword(dialog));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.cancel(dialog);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) this.cancel(dialog);
    });

    let opened = false;
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
        opened = true;
      } catch {
        // Fall through to fail closed below.
      }
    }
    if (!opened) {
      // A visually modal but behaviorally non-modal fallback could expose
      // credentials to the wrong focus target. Unsupported WebViews fail
      // closed and let the Worker cancel this authentication round normally.
      const onCancel = options.onCancel;
      const challengeId = challenge.id;
      this.close(false);
      onCancel(challengeId);
      return true;
    }

    options.onShown(challenge.id);

    requestAnimationFrame(() => {
      if (this.dialog !== dialog) return;
      (inputs[0] ?? storedPasswordButton ?? submitButton).focus();
    });
    return true;
  }

  dismiss(): void {
    this.close(false);
  }

  destroy(): void {
    this.close(false);
  }

  private submitResponses(expectedDialog: HTMLDialogElement): void {
    if (this.dialog !== expectedDialog) return;
    const active = this.active;
    if (!active) return;
    const responses = active.inputs.map((input) => input.value);
    const submission: AuthChallengeSubmission = {
      type: 'auth_response',
      id: active.challenge.id,
      responses,
    };
    const onSubmit = active.options.onSubmit;
    this.close(true);
    onSubmit(submission);
  }

  private submitStoredPassword(expectedDialog: HTMLDialogElement): void {
    if (this.dialog !== expectedDialog) return;
    const active = this.active;
    if (!active) return;
    const submission: AuthChallengeSubmission = {
      type: 'auth_response',
      id: active.challenge.id,
      useStoredPassword: true,
    };
    const onSubmit = active.options.onSubmit;
    this.close(true);
    onSubmit(submission);
  }

  private cancel(expectedDialog: HTMLDialogElement): void {
    if (this.dialog !== expectedDialog) return;
    const active = this.active;
    if (!active) return;
    const { id } = active.challenge;
    const onCancel = active.options.onCancel;
    this.close(true);
    onCancel(id);
  }

  private close(restoreFocus: boolean): void {
    const active = this.active;
    const dialog = this.dialog;
    this.active = null;
    this.dialog = null;

    if (active) {
      for (const input of active.inputs) {
        input.value = '';
        input.removeAttribute('value');
      }
    }
    if (dialog) {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      dialog.remove();
    }
    if (restoreFocus && active?.previousFocus?.isConnected) {
      active.previousFocus.focus();
    }
  }
}
