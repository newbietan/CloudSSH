// Agent tool definitions (OpenAI tools parameter format)

import type { ToolDefinition } from './types';

export const AGENT_TOOLS_PHASE1: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: '通过 SSH exec channel 执行一条命令。会返回干净的 stdout、stderr 和 exit_code。这是 Agent 与服务器交互的主要方式。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令，例如 "df -h" 或 "cat /etc/nginx/nginx.conf"',
          },
          timeout_ms: {
            type: 'number',
            description: '命令超时时间（毫秒），默认 10000ms，最长 30000ms',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_terminal_context',
      description: '读取交互式终端当前显示的最近 N 行内容。用于了解用户当前在终端里看到什么（如当前 prompt、上次命令的部分输出）。注意：此函数不执行命令，只读取已有输出。',
      parameters: {
        type: 'object',
        properties: {
          last_lines: {
            type: 'number',
            description: '读取最近 N 行（默认 200）',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user_confirmation',
      description: '在执行可能有风险的操作前，向用户请求确认。Agent 应主动在不确定时调用此工具，而不是盲目执行。调用后 Agent 将暂停，等待用户在前端点击确认。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '待执行的命令',
          },
          reason: {
            type: 'string',
            description: '为什么需要用户确认（用简洁中文描述风险）',
          },
        },
        required: ['command', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detect_environment',
      description: '探测当前服务器环境信息：工作目录、用户、Shell、PATH、关键环境变量（JAVA_HOME/NODE_ENV 等）、alias、主机名、内核版本。Agent 启动时已自动探测一次，如需刷新可再次调用。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'respond_to_user',
      description: '当任务完成或需要向用户报告结果时调用此工具。只有在你已经收集了足够信息并准备好最终回复时才调用。',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: '发送给用户的最终回复内容（Markdown 格式）',
          },
        },
        required: ['message'],
      },
    },
  },
];


