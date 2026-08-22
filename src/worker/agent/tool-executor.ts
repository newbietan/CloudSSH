// Tool call execution engine — dispatches tool calls to their implementations

import { isBlockedCommand, needsConfirmation } from './safety';
import type { TerminalContext } from './terminal-context';
import type { ExecResult } from './types';

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
      return JSON.stringify({ stdout: '', stderr: errMsg, exit_code: -1 });
    }
  }

  private async handleServiceManage(
    action: string,
    service: string,
    signal?: AbortSignal
  ): Promise<string> {
    // Shell-safe whitelist: service names are typically [a-zA-Z0-9_-] with optional '@' instance
    if (service && !/^[a-zA-Z0-9_\-@.]+$/.test(service)) {
      return JSON.stringify({ stdout: '', stderr: '非法的服务名称', exit_code: -1 });
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
      return JSON.stringify({ environment: '', stderr: errMsg, exit_code: -1 });
    }
  }
}
