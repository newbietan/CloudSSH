# Agent 本地上下文、原生压缩与长期记忆

## 方案与兼容要求

CloudSSH 由 SSHSessionDO 本地管理有界会话历史，不使用 `previous_response_id` 或 Conversations 服务端历史。

- 主任务和知识提炼：`POST <base_url>/responses`，强制 `store:false`。
- 长会话：独立 `POST <base_url>/responses/compact`，采用原生无状态 compaction，不使用模型 JSON 摘要或本地保底。
- 模型列表、`/responses` 可用、某个服务商品牌，都不证明当前模型支持 `/responses/compact`。需要在实际端点验证。
- Base URL 仍填写 HTTPS 根地址或完整 `/responses` 地址，不填写 `/responses/compact`。更换服务商/模型/密钥后须新建 Agent 会话，旧加密续接数据不转发到新配置。
- “本地管理”不是本地推理：当前请求内容仍发送给配置的服务商。`store:false` 和无状态接口不能替代对实际留存政策的核查。

## 原生压缩契约

1. 在没有未闭合工具调用的边界，将完整本地 `input` 和同一系统 `instructions` 发送给 compact。
2. 请求只带 `model`、`input`、`instructions`。官方独立 compact 契约没有 `store`、`stream`、`tools`、`text.format`、`reasoning`、`max_output_tokens` 参数。
3. 接收 `object: response.compaction` 对象，验证原生 compaction item、消息和函数工具历史。当前只支持应用已有的文本/函数工具子集，未知类型、特权角色和畸形数据失败关闭。
4. 返回的整个 `output` 是下一段规范上下文，包含不透明加密状态及服务端保留的消息。完整保留其字段、内容和顺序，不只提取加密 item，也不自行裁剪近期消息。
5. 在规范窗口后追加应用拥有的用户请求与 ExecutionJournal 事实守卫，并重新注入当前环境、终端和相关记忆。
6. 完整下一请求（包括工具定义和输出预留）通过预算检查后，才原子替换当前上下文。compact 返回的工具调用只作为历史回传，绝不当成新调用执行。

压缩总 deadline 为 60 秒，包含最多两次瞬时 HTTP 重试；相同载荷沿用本地幂等键。拒绝重定向，错误体有界读取并只保留白名单诊断。成功响应开始消费后不重试解析、不会生成补救摘要。

不支持接口、协议错误、超时或预算不足时，保留旧历史和已结算工具结果，任务安全暂停。不会自动降级成 JSON 摘要、丢弃执行事实或重跑 SSH 命令。停止/抢占/reset 会取消压缩。若替换后首个主请求失败，再次继续仍保留规范窗口和未被接受的事实守卫。

### 预算与有限性

- 默认上下文/普通生成输出预算为 64,000/8,192 Token。普通生成的输出上限包含推理 Token。
- **原生 compact 不支持 `max_output_tokens`，因此该设置不能限制 compact 服务端生成额度或费用。** 本地仍限制请求体、响应读取、等待时间和后续上下文大小。
- 当前 UTF-8 字节预算是保守估算，不是通用 tokenizer；包括加密载荷在内的本地字节上限可能比模型实际 Token 容量更早触发安全暂停。
- 继续保留 2MiB 当前序列化上下文、3MiB 编辑快照预算、96KiB 累计精确用户请求与有界执行账本。不保证无限长会话。
- 会话历史和加密续接 items 仍属于当前 SSHSessionDO 的内存状态；这不是完整会话持久化或跨任意故障恢复。长期记忆与中断检查点另行保存，不应把原生 reasoning/compaction 内容写入长期记忆。

## 三种状态分开管理

| 状态 | 来源与用途 | 生命周期 |
| --- | --- | --- |
| Responses 会话历史 | 原生 items、工具结果、加密续接与当前观察 | 当前 Agent 会话，有界内存 |
| 执行事实/工作记录 | 程序确定性记录状态、调用标识、脱敏命令摘要、退出码与时间 | 每任务记录，最近 10 条工作日志 |
| 长期知识 | 模型提议，程序证据筛选、权限与版本校验 | 用户/服务器隔离的持久键值知识 |

### 确定性工作记录

`execution-log.ts` 只使用真实执行事实生成工作记录，不依赖知识模型返回有效 JSON。未知/失败/取消不能被改写成成功。

UserDBDO 通过内部 `agent-execution` 路由接收任务记录，按 taskId 幂等提交工作日志与 `agent_execution_logs` 的加密事实载荷。完整状态载荷不含模型推理、原生续接 items 或原始终端输出；列表摘要是有界计数与最近操作信息。

任务日志不再由模型自动 `update_latest` 合并，以免新摘要覆盖旧执行状态。日志与加密事实随最近 10 条限制一起清理，手动删除日志也清理对应事实；它不是无限期、防篡改的安全审计库。存储不可用时仍可能无法记录，但会明确通知，不伪装成功；不要因保存失败重跑远端任务。

### 异步知识提炼与合并

模型输出只允许 `{"knowledge":[...]}`，不生成工作记录。每个任务后台处理：

1. 入队不复制整份旧记忆/凭据库，执行时读取最新 revision。
2. 按任务相关性提供有限知识；已存凭据在辅助输入中脱敏。用户当前明确提供的值可用于提炼新凭据。
3. 采用低推理提示，首次输出最多 8,192、第二次最多 16,384 Token，并始终受用户普通生成上限约束。Schema 同时写入 instructions，以兼容忽略结构化提示的网关。
4. 本地严格验证整个批次；精确重复项去重，同一 key 的冲突提议整批拒绝，不“取最后一条”。
5. 非敏感新事实必须在用户原文或成功工具结果中出现；凭据只能来自用户原文，不能从失败/未知操作或工具输出猜测。用户手动知识只有在明确要求修改该 key 与新值时才允许更新，来源仍保留为 user；删除必须有明确的忘记/删除记忆意图。
6. 跳过未变化的有效事实。写入本地证据引用（`user` 或 callId）与 taskId，而不是让模型填写证据、时间或有效期。
7. 按预期 revision 原子写入；只对白名单 `memory_revision_conflict` 刷新状态并重新推导，不重发旧批次。普通 409、stale session、HTTP/协议错误不触发冲突恢复。

每个任务最多两次生成，共享一个 25 秒 deadline。第二次机会由“完整结果 JSON/业务格式失败”“明确输出额度耗尽”或“明确 revision 冲突重算”共用，不叠加成多轮重试。内容过滤、未知未完成原因不允许绕过。失败保留旧知识，工作事实记录与主任务不受模型提炼失败影响。

能力学习只在同一 memory manager 和相同配置内复用，不跨用户/服务商共享；reset 清除。队列满、最终冲突和保存失败会显示简短通知，不移除新任务正文。

### 来源与过期

`agent_knowledge_meta` 通过幂等 ALTER 增加 `evidence`、`task_id`、`verified_at`、`expires_at`，不重建现有用户表。

- 有本地证据的自动 config/note：写入后 30 天过期，之后不再自动注入；数据不自动删除，可以经新证据重新确认。
- 用户手动知识、rule、credential：不自动过期。
- 旧知识没有这组时间元数据时，不凭空推断过期时间。
- 检索使用规范键、关键词、有限中文别名、来源与有效性筛选；当前每服务器最多 500 条知识，不引入向量服务。

证据引用表示可追溯的观察来源，不代表远端配置永远有效，也不是执行授权。模型仍需在风险操作前确认，并在未知状态下先验证。

## 存储与诊断边界

内部存储适配器有独立 10 秒 deadline，检查 HTTP 状态；失败读取不能伪装成空记忆，写入失败不能报告成功。加密 await 后重新检查所有权、session/epoch、revision，再在同步事务中提交。客户端取消不能保证已经发出的存储操作绝对没有提交，因此超时提示使用“更新未能确认”，不得盲目重复副作用。

敏感知识和执行事实使用现有 AES-GCM 行级加密。根密钥仍位于同一 UserDBDO SQLite 的 `system_config.encryption_secret`，不是独立 KMS，不能抵御包含根密钥的整库泄露或 Worker 代码执行权限失陷。

普通聊天/通知仅显示简短错误及必要的安全暂停状态。阶段、白名单参数/错误码、本地请求 UUID 和 Token 明细仅在 `DEBUG_MODE=true` 时通过 `type: debug` 输出网页 SSH 终端。任何模式都不输出原始上游错误正文、头部或密钥。

## 原生压缩兼容性主动测试与开发者联调

由于并非所有 Responses 服务商或中转网关都支持 `/responses/compact`，系统提供了两级验证手段：

### 1. 网页前端设置面板（用户显式触发）
- 在「AI Agent 设置」中提供「测试原生压缩」按钮与费用知情复选框。
- 必须用户显式勾选知情同意后方可触发，严禁页面加载或输入变化时自动发请求计费。
- 采用合成验证 Token 进行独立 `POST /responses/compact` 与无工具续接往返测试，验证通过方报告 supported。
- 表单地址、模型、密钥、预算任何一项变动立即在前端注销测试结论，避免陈旧结果误导。

### 2. 开发者真实服务商测试（默认跳过）
- 测试用例位于 `tests/worker/agent/capability-live.test.ts`。
- 默认测试套件及 CI 门禁不会向外部发送任何付费网络请求（自动跳过）。
- 开发者或运维若需验证某一中转网关或官方模型，可显式传入环境变量运行：
  ```bash
  CLOUDSSH_LIVE_AI_TEST=1 \
  CLOUDSSH_LIVE_AI_KEY="sk-..." \
  CLOUDSSH_LIVE_AI_BASE_URL="https://api.openai.com/v1" \
  CLOUDSSH_LIVE_AI_MODEL="gpt-4o-mini" \
  pnpm exec vitest run tests/worker/agent/capability-live.test.ts
  ```
- 仅使用纯合成数据验证契约完整性，绝不接触真实服务器环境或生产数据。

## 参考

- [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI Compact API](https://developers.openai.com/api/reference/resources/responses/methods/compact)
- [OpenAI Agents SDK Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
- [OpenAI Long-Term Memory Notes](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization)
