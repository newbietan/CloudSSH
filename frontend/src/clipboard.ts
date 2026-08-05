export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export type LegacyClipboardWriter = (text: string) => boolean;

function getClipboardWriter(): ClipboardWriter | null {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return null;
  }
  return navigator.clipboard;
}

/**
 * 将文本写入系统剪贴板，并在 Clipboard API 不可用或被拒绝时回退到
 * `document.execCommand('copy')`。只有浏览器明确报告成功时才返回 true。
 */
export async function copyTextToClipboard(
  text: string,
  clipboard: ClipboardWriter | null = getClipboardWriter(),
  legacyCopy: LegacyClipboardWriter = copyTextWithExecCommand,
): Promise<boolean> {
  if (!text) return false;

  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 继续尝试兼容旧浏览器或权限受限环境的回退方案。
    }
  }

  try {
    return legacyCopy(text);
  } catch {
    return false;
  }
}

/**
 * 兼容不支持 Clipboard API 的浏览器。临时输入框会抢占焦点，因此复制结束后
 * 必须把焦点还给原元素，避免终端选中并复制后无法继续输入。
 */
export function copyTextWithExecCommand(
  text: string,
  targetDocument: Document | null = typeof document === 'undefined' ? null : document,
): boolean {
  if (!text || !targetDocument?.body || typeof targetDocument.execCommand !== 'function') {
    return false;
  }

  const previousFocus = targetDocument.activeElement;
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = targetDocument.createElement('textarea');
    textarea.value = text;
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
    targetDocument.body.appendChild(textarea);
    try {
      textarea.focus({ preventScroll: true });
    } catch {
      textarea.focus();
    }
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return targetDocument.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea?.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {
        previousFocus.focus();
      }
    }
  }
}
