// Agent tool definitions (OpenAI tools parameter format)

import type { ToolDefinition } from './types';

export const AGENT_TOOLS: ToolDefinition[] = [
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
            description: '命令超时时间（毫秒），默认 10000ms，最长 180000ms（3分钟）',
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
      name: 'list_processes',
      description: '列出当前服务器进程列表（按内存排序，前 30 条）。返回 PID、用户、CPU%、内存%、命令。用于快速了解系统运行状况。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'service_manage',
      description: '管理 systemd 服务。可执行 status、start、stop、restart、enable、disable 操作。stop/disable 需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: '操作类型',
            enum: ['status', 'start', 'stop', 'restart', 'enable', 'disable'],
          },
          service: {
            type: 'string',
            description: '服务名称，例如 "nginx"、"docker"、"mysql"',
          },
        },
        required: ['action', 'service'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docker_manage',
      description: '管理 Docker 容器和镜像。支持 ps（列出容器）、logs（查看日志）、inspect（详情）、images（列出镜像）、stop（停止容器）、rm（删除容器）、rmi（删除镜像）、restart（重启容器）。stop/rm/rmi 需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: '操作类型',
            enum: ['ps', 'logs', 'inspect', 'images', 'stop', 'rm', 'rmi', 'restart'],
          },
          target: {
            type: 'string',
            description: '容器名/ID 或镜像名/ID（stop/rm/rmi/inspect/logs/restart 必填）',
          },
          options: {
            type: 'string',
            description: '额外参数，例如 logs 的 "-n 50"、ps 的 "-a"',
          },
        },
        required: ['action'],
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


