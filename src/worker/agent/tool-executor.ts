// Tool call execution engine — dispatches tool calls to their implementations

import { TerminalContext } from './terminal-context';
import { needsConfirmation } from './safety';
import type { ExecResult } from './types';

export type ExecCommandFn = (command: string, timeout: number, signal?: AbortSignal) => Promise<ExecResult>;

export class ToolExecutor {
  constructor(
    private terminalContext: TerminalContext,
    private execCommand: ExecCommandFn,
    private askConfirmation: (command: string, reason: string) => Promise<boolean>,
  ) {}

  async execute(toolName: string, args: any, signal?: AbortSignal): Promise<string> {
    switch (toolName) {
      case 'execute_command':
        return this.handleExec(args.command, args.timeout_ms ?? 10000, signal);
      case 'read_terminal_context':
        return this.terminalContext.snapshot(args.last_lines ?? 200);
      case 'ask_user_confirmation':
        return this.handleConfirmation(args.command, args.reason);
      case 'respond_to_user':
        return `RESPOND:${args.message}`;
      case 'sftp_list':
        return 'SFTP 功能暂未启用（Phase 3 将支持）';
      case 'sftp_read':
        return 'SFTP 功能暂未启用（Phase 3 将支持）';
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  private async handleExec(command: string, timeout: number, signal?: AbortSignal): Promise<string> {
    // Check if this command needs user confirmation
    const confirm = needsConfirmation(command);
    if (confirm.required) {
      const approved = await this.askConfirmation(command, confirm.reason!);
      if (!approved) {
        return JSON.stringify({
          stdout: '',
          stderr: '用户拒绝执行此命令',
          exit_code: -1,
          user_rejected: true,
        });
      }
    }

    const clampedTimeout = Math.min(Math.max(timeout, 1000), 30000);

    try {
      const result = await this.execCommand(command, clampedTimeout, signal);
      return JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return JSON.stringify({
        stdout: '',
        stderr: errMsg,
        exit_code: -1,
      });
    }
  }

  private async handleConfirmation(command: string, reason: string): Promise<string> {
    const approved = await this.askConfirmation(command, reason);
    return approved
      ? 'User approved'
      : 'User rejected the command. Do not retry without user approval.';
  }
}
