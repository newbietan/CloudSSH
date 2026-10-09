// Tool call execution engine — dispatches tool calls to their implementations

import { isBlockedCommand, needsConfirmation } from './safety';
import { validateBaseUrlWithDNS } from './ssrf';
import type { TerminalContext } from './terminal-context';
import type { ExecutionStatus, ExecResult } from './types';

const STATUSES: ExecutionStatus[] = ['succeeded', 'failed', 'blocked', 'rejected', 'cancelled', 'invalid_arguments', 'unknown'];

export function executionOutcome(tool: string, output: string): { status: ExecutionStatus; executed: boolean } {
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(output); } catch { /* Text-only observations/confirmation. */ }
  const status: ExecutionStatus = STATUSES.includes(value?.status as ExecutionStatus) ? value.status as ExecutionStatus
    : value?.blocked ? 'blocked' : value?.user_rejected || output.startsWith('User rejected') ? 'rejected'
      : typeof value?.exit_code === 'number' && value.exit_code !== 0 ? 'failed' : 'succeeded';
  const executed = typeof value?.executed === 'boolean' ? value.executed
    : !['blocked', 'rejected', 'cancelled', 'invalid_arguments'].includes(status) &&
      !['read_terminal_context', 'ask_user_confirmation', 'fetch_web_content'].includes(tool);
  return { status, executed };
}

// 工具结果进入 LLM 上下文的硬边界：head/tail 式截断（保留头尾、省略中间），
// 防止 docker logs 等大输出把后续每轮 LLM 请求体撑到数 MB（弱网下直接拖垮 Agent）。
const MAX_TOOL_RESULT_CHARS = 64_000;
const KEEP_HEAD_CHARS = 16_000;

function truncateForLLM(text: string): { text: string; omittedChars: number } {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return { text, omittedChars: 0 };
  const head = text.slice(0, KEEP_HEAD_CHARS);
  const tail = text.slice(-(MAX_TOOL_RESULT_CHARS - KEEP_HEAD_CHARS));
  const omittedChars = text.length - head.length - tail.length;
  const note = `\n[... 输出过长已截断：省略中间 ${omittedChars} 字符 ...]\n`;
  return { text: `${head}${note}${tail}`, omittedChars };
}

export type ExecCommandFn = (
  command: string,
  timeout: number,
  signal?: AbortSignal
) => Promise<ExecResult>;

export class ToolExecutor {
  constructor(
    private terminalContext: TerminalContext,
    private execCommand: ExecCommandFn,
    private askConfirmation: (command: string, reason: string) => Promise<boolean>,
    private resetTimeout?: () => void
  ) {}

  async execute(toolName: string, args: any, signal?: AbortSignal): Promise<string> {
    const output = await this.executeRaw(toolName, args, signal);
    const outcome = executionOutcome(toolName, output);
    try {
      const value = JSON.parse(output);
      if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify({ ...value, ...outcome });
    } catch { /* Text-only tools still receive explicit, non-authorizing outcomes. */ }
    return JSON.stringify({ ...outcome, result: output });
  }

  private async executeRaw(toolName: string, args: any, signal?: AbortSignal): Promise<string> {
    switch (toolName) {
      case 'execute_command':
        return this.handleExec(args.command, args.timeout_ms ?? 10000, signal);
      case 'read_terminal_context':
        return this.terminalContext.snapshot(args.last_lines ?? 200);
      case 'list_processes':
        return this.handleListProcesses(signal);
      case 'service_manage':
        return this.handleServiceManage(args.action, args.service, signal);
      case 'docker_manage':
        return this.handleDockerManage(args.action, args.target, args.options, signal);
      case 'detect_environment':
        return this.handleDetectEnvironment(signal);
      case 'ask_user_confirmation':
        return this.handleConfirmation(args.command, args.reason, signal);
      case 'fetch_web_content':
        return this.handleFetchWebContent(args.url, signal);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  private async handleExec(
    command: string,
    timeout: number,
    signal?: AbortSignal
  ): Promise<string> {
    // Check if this command is blocked (never execute)
    const blocked = isBlockedCommand(command);
    if (blocked.blocked) {
      return JSON.stringify({
        stdout: '',
        stderr: `命令被安全策略拦截：${blocked.reason}`,
        exit_code: -1,
        blocked: true,
      });
    }

    // Check if this command needs user confirmation
    const confirm = needsConfirmation(command);
    if (confirm.required) {
      const approved = await this.askConfirmationWithAbort(command, confirm.reason!, signal);
      if (!approved) {
        return JSON.stringify({
          stdout: '',
          stderr: '用户拒绝执行此命令',
          exit_code: -1,
          user_rejected: true,
        });
      }
    }

    const clampedTimeout = Math.min(Math.max(timeout, 1000), 180000);

    // 对于长时间命令（>60秒），定期重置看门狗计时器
    let watchdogInterval: ReturnType<typeof setInterval> | null = null;
    if (clampedTimeout > 60000 && this.resetTimeout) {
      watchdogInterval = setInterval(() => {
        this.resetTimeout?.();
      }, 60000); // 每60秒重置一次看门狗
    }

    try {
      const result = await this.execCommand(command, clampedTimeout, signal);
      const stdout = truncateForLLM(result.stdout);
      const stderr = truncateForLLM(result.stderr);
      return JSON.stringify({
        stdout: stdout.text,
        stderr: stderr.text,
        exit_code: result.exitCode,
        ...(stdout.omittedChars > 0 || stderr.omittedChars > 0
          ? { truncated: true, omitted_chars: stdout.omittedChars + stderr.omittedChars }
          : {}),
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return JSON.stringify({
        stdout: '',
        stderr: errMsg,
        exit_code: -1,
        status: 'unknown',
        executed: true,
        instruction: 'Dispatch did not return a verified result; inspect remote state before retrying.',
      });
    } finally {
      if (watchdogInterval) {
        clearInterval(watchdogInterval);
      }
    }
  }

  private async handleListProcesses(signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.execCommand('ps aux --sort=-%mem | head -30', 10000, signal);
      return JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return JSON.stringify({ stdout: '', stderr: errMsg, exit_code: -1, status: 'unknown', executed: true });
    }
  }

  private async handleServiceManage(
    action: string,
    service: string,
    signal?: AbortSignal
  ): Promise<string> {
    // Shell-safe whitelist: service names are typically [a-zA-Z0-9_-] with optional '@' instance
    if (service && !/^[a-zA-Z0-9_\-@.]+$/.test(service)) {
      return JSON.stringify({ stdout: '', stderr: '非法的服务名称', exit_code: -1, status: 'invalid_arguments', executed: false });
    }

    const VALID_ACTIONS = ['status', 'start', 'stop', 'restart', 'enable', 'disable'];
    const safeActions = ['status', 'start', 'restart', 'enable'];

    // 非白名单 action 需要用户确认
    if (!VALID_ACTIONS.includes(action)) {
      const cmd = `systemctl ${action} ${service}`;
      const approved = await this.askConfirmationWithAbort(
        cmd,
        `非标准服务操作 "${action}"，即将执行: ${cmd}，请确认`,
        signal
      );
      if (!approved) {
        return JSON.stringify({
          stdout: '',
          stderr: '用户拒绝执行此操作',
          exit_code: -1,
          user_rejected: true,
        });
      }
    } else if (!safeActions.includes(action)) {
      // 白名单内的危险操作（stop/disable）也需要确认
      const reason =
        action === 'stop' ? `即将停止服务 ${service}，请确认` : `即将禁用服务 ${service}，请确认`;
      const approved = await this.askConfirmationWithAbort(
        `systemctl ${action} ${service}`,
        reason,
        signal
      );
      if (!approved) {
        return JSON.stringify({
          stdout: '',
          stderr: '用户拒绝执行此操作',
          exit_code: -1,
          user_rejected: true,
        });
      }
    }
    return this.handleExec(`systemctl ${action} ${service}`, 15000, signal);
  }

  private async handleDockerManage(
    action: string,
    target?: string,
    options?: string,
    signal?: AbortSignal
  ): Promise<string> {
    // Shell-safe whitelist: docker args may not contain shell metacharacters
    const safeArgRe = /^[a-zA-Z0-9_\-.\s=:+/@,]*$/;
    const safeTarget = target && !safeArgRe.test(target) ? '' : target;
    const safeOptions = options && !safeArgRe.test(options) ? '' : options;

    const VALID_ACTIONS = ['ps', 'logs', 'inspect', 'images', 'stop', 'rm', 'rmi', 'restart'];
    const safeActions = ['ps', 'logs', 'inspect', 'images'];

    // docker logs 的输出必须是有界的：拒绝无限流式 -f（弱网 + 大日志流会打爆 DO 内存），
    // 未显式指定 --tail 时由 buildDockerCommand 强制追加。
    if (action === 'logs') {
      const trimmedOpts = safeOptions?.trim() ?? '';
      if (/(^|\s)(-f|--follow)(\s|$)/.test(trimmedOpts)) {
        return JSON.stringify({
          stdout: '',
          stderr:
            'docker logs 不允许 -f/--follow（无限流式输出会耗尽会话资源），请使用 --tail N 查看最近日志',
          exit_code: -1,
          blocked: true,
        });
      }
    }

    const cmd = this.buildDockerCommand(action, safeTarget, safeOptions);

    // 非白名单 action 需要用户确认
    if (!VALID_ACTIONS.includes(action)) {
      const approved = await this.askConfirmationWithAbort(
        cmd,
        `非标准 Docker 操作 "${action}"，即将执行: ${cmd}，请确认`,
        signal
      );
      if (!approved) {
        return JSON.stringify({
          stdout: '',
          stderr: '用户拒绝执行此操作',
          exit_code: -1,
          user_rejected: true,
        });
      }
    } else if (!safeActions.includes(action)) {
      // 白名单内的危险操作（stop/rm/rmi/restart）也需要确认
      const reasons: Record<string, string> = {
        stop: `即将停止容器 ${safeTarget}，请确认`,
        rm: `即将删除容器 ${safeTarget}，此操作不可逆，请确认`,
        rmi: `即将删除镜像 ${safeTarget}，此操作不可逆，请确认`,
        restart: `即将重启容器 ${safeTarget}，请确认`,
      };
      const approved = await this.askConfirmationWithAbort(
        cmd,
        reasons[action] || `即将执行: ${cmd}`,
        signal
      );
      if (!approved) {
        return JSON.stringify({
          stdout: '',
          stderr: '用户拒绝执行此操作',
          exit_code: -1,
          user_rejected: true,
        });
      }
    }

    return this.handleExec(cmd, action === 'logs' ? 15000 : 10000, signal);
  }

  private buildDockerCommand(action: string, target?: string, options?: string): string {
    const opts = options ? ` ${options.trim()}` : '';
    switch (action) {
      case 'ps':
        return `docker ps${opts || ' -a'}`;
      case 'logs': {
        // 日志查看必须是有界的：未显式指定 --tail 时强制最近 200 行
        const hasTail = /(^|\s)--tail(\s|=|$)/.test(opts.trim());
        const safeOpts = hasTail ? opts : `${opts} --tail 200`;
        return `docker logs${safeOpts} ${target || ''}`.trim();
      }
      case 'inspect':
        return `docker inspect ${target || ''}`.trim();
      case 'images':
        return `docker images${opts}`;
      case 'stop':
        return `docker stop ${target}`;
      case 'rm':
        return `docker rm ${target}`;
      case 'rmi':
        return `docker rmi ${target}`;
      case 'restart':
        return `docker restart ${target}`;
      default:
        return `docker ${action}`;
    }
  }

  private async handleConfirmation(
    command: string,
    reason: string,
    signal?: AbortSignal
  ): Promise<string> {
    const approved = await this.askConfirmationWithAbort(command, reason, signal);
    return approved
      ? 'User approved'
      : 'User rejected the command. Do not retry without user approval.';
  }

  /**
   * 将 askConfirmation 与 abort signal 竞争，防止超时后 runLoop 永久挂起。
   * 当 signal 被 abort 时，视为用户拒绝。
   */
  private askConfirmationWithAbort(
    command: string,
    reason: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return Promise.race([
      this.askConfirmation(command, reason),
      new Promise<boolean>((resolve) => {
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }),
    ]);
  }

  private async handleDetectEnvironment(signal?: AbortSignal): Promise<string> {
    const cmd = [
      'echo "PWD:$(pwd)"',
      'echo "USER:$(whoami)"',
      'echo "HOME:$HOME"',
      'echo "SHELL:$SHELL"',
      'echo "LANG:${LANG:-not set}"',
      'echo "PATH:$PATH"',
      'echo "HOSTNAME:$(hostname 2>/dev/null || echo unknown)"',
      'echo "KERNEL:$(uname -sr 2>/dev/null || echo unknown)"',
    ].join('; ');

    try {
      const result = await this.execCommand(cmd, 10000, signal);
      return JSON.stringify({
        environment: result.stdout.trim(),
        exit_code: result.exitCode,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return JSON.stringify({ environment: '', stderr: errMsg, exit_code: -1, status: 'unknown', executed: true });
    }
  }

  private async handleFetchWebContent(rawUrl: string, signal?: AbortSignal): Promise<string> {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return JSON.stringify({ status: 'invalid_arguments', error: 'URL 不能为空' });
    }
    const cleanUrl = rawUrl.trim();
    let currentUrl = cleanUrl;
    const maxRedirects = 3;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (signal?.aborted) {
        return JSON.stringify({ status: 'cancelled', error: '操作已取消' });
      }

      const validation = await validateBaseUrlWithDNS(currentUrl);
      if (!validation.valid) {
        return JSON.stringify({
          status: 'blocked',
          blocked: true,
          error: `URL 安全检查未通过：${validation.reason ?? '禁止访问的目标地址'}`,
          url: currentUrl,
        });
      }

      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        return JSON.stringify({ status: 'invalid_arguments', error: '无效的 URL 格式', url: currentUrl });
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return JSON.stringify({ status: 'blocked', blocked: true, error: '仅支持 HTTP/HTTPS 协议', url: currentUrl });
      }

      try {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), 15000);
        const combinedAbort = () => timeoutController.abort();
        signal?.addEventListener('abort', combinedAbort, { once: true });

        let response: Response;
        try {
          response = await fetch(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: timeoutController.signal,
            headers: {
              'User-Agent': 'CloudSSH-Agent/2.6 (compatible; Linux x86_64)',
              Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
            },
          });
        } finally {
          clearTimeout(timeoutId);
          signal?.removeEventListener('abort', combinedAbort);
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('Location');
          if (!location) {
            return JSON.stringify({ status: 'failed', error: `重定向缺少 Location 头 (HTTP ${response.status})`, url: currentUrl });
          }
          if (hop === maxRedirects) {
            return JSON.stringify({ status: 'failed', error: '重定向次数过多（已达上限 3 次）', url: currentUrl });
          }
          try {
            currentUrl = new URL(location, currentUrl).toString();
          } catch {
            return JSON.stringify({ status: 'failed', error: '无效的重定向目标地址', location });
          }
          continue;
        }

        if (!response.ok) {
          return JSON.stringify({ status: 'failed', error: `请求失败 (HTTP ${response.status} ${response.statusText})`, url: currentUrl });
        }

        const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
        if (
          contentType &&
          !contentType.includes('text/') &&
          !contentType.includes('application/json') &&
          !contentType.includes('application/xml') &&
          !contentType.includes('application/xhtml+xml') &&
          !contentType.includes('application/javascript')
        ) {
          return JSON.stringify({
            status: 'failed',
            error: `不支持读取二进制内容 (Content-Type: ${contentType})`,
            url: currentUrl,
          });
        }

        const reader = response.body?.getReader();
        if (!reader) {
          return JSON.stringify({ status: 'failed', error: '无法读取响应流', url: currentUrl });
        }

        let rawText = '';
        const decoder = new TextDecoder();
        let totalBytes = 0;
        const maxBytes = 512 * 1024;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            rawText += decoder.decode(value, { stream: true });
            if (totalBytes > maxBytes) {
              await reader.cancel();
              break;
            }
          }
          rawText += decoder.decode();
        } finally {
          reader.releaseLock();
        }

        const cleanedText = extractReadableText(rawText, contentType);
        const MAX_OUTPUT_CHARS = 16_000;
        let result = cleanedText;
        let truncated = false;
        if (result.length > MAX_OUTPUT_CHARS) {
          result = `${result.slice(0, MAX_OUTPUT_CHARS)}\n\n[... 内容过长已截断：仅显示前 16,000 字符 ...]`;
          truncated = true;
        }

        return JSON.stringify({
          status: 'succeeded',
          url: currentUrl,
          content_type: contentType || 'unknown',
          length: result.length,
          truncated,
          content: result,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ status: 'failed', error: `网络请求失败: ${message}`, url: currentUrl });
      }
    }

    return JSON.stringify({ status: 'failed', error: '未知请求错误', url: currentUrl });
  }
}

export function extractReadableText(raw: string, contentType: string): string {
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  }

  let text = raw;
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|svg|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|article|section|header|footer)>/gi, '\n');
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return text.trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number.parseInt(code, 10);
      return !Number.isNaN(n) && n > 0 && n < 65536 ? String.fromCharCode(n) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const n = Number.parseInt(hex, 16);
      return !Number.isNaN(n) && n > 0 && n < 65536 ? String.fromCharCode(n) : '';
    });
}
