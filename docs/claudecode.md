可以，而且按你现在 Codex App Server 的集成边界来重新审视，**Claude Code 可以作为第三个一等 Vendor 接入**。不过它和 Codex 有一个根本差异：

> **Codex 的公开集成面是 `codex app-server`；Claude Code 的公开集成面不是一个 `claude server`，而是 `@anthropic-ai/claude-agent-sdk`。**

截至 **2026-08-10**，Anthropic 官方明确把 Claude Agent SDK 定义为“把 Claude Code 的 agent loop 作为 library 嵌入自己的应用”，TypeScript SDK 会启动其内置的 Claude Code native subprocess；官方部署文档也明确说明这个 subprocess **自己不监听 HTTP/WebSocket 端口**，如果需要 Server，是你的应用在外层提供 HTTP/WS。因此不要尝试逆向 Claude Code 内部 stdio 协议来仿造一个 `ClaudeCodeServerAdapter`。([Claude][1])

我建议新增的正式实现叫：

```ts
ClaudeAgentSdkAdapter
```

Provider ID 可以保持你想要的：

```ts
type AgentProvider =
  | 'codex'
  | 'copilot'
  | 'claudecode';
```

但从 Anthropic 当前 branding 指引来说，产品 UI 更适合显示 **Claude Agent**，因为你实际集成的是 Agent SDK，而不是操控 Claude Code IDE 私有对象。([Claude][1])

## 一、接口真实性盘点

| InfiniteMap 需求                        | Claude 官方接口                                               | 存在性      | 集成判断                          |
| ------------------------------------- | --------------------------------------------------------- | -------- | ----------------------------- |
| 启动 Runtime                            | `query()` / `startup()`                                   | ✅ 官方     | 可集成                           |
| 指定新 Session ID                        | `Options.sessionId`                                       | ✅ 官方     | 可集成                           |
| 创建 Session                            | **当前没有独立 `createSession()`**                              | ⚠️       | 通过 `sessionId + query()` 实现语义 |
| 恢复 Session                            | `Options.resume`                                          | ✅ 官方     | 可集成                           |
| Continue 最近 Session                   | `continue: true`                                          | ✅ 官方     | 可集成，但 InfiniteMap 不建议依赖       |
| Fork Session                          | `forkSession()` / `forkSession` option                    | ✅ 官方     | 可集成                           |
| 提交任务                                  | `query()`                                                 | ✅ 官方     | 可集成                           |
| 长连接多轮输入                               | Streaming Input / `streamInput()`                         | ✅ 官方     | 可集成                           |
| Codex 式即时 `steer`                     | 无完全等价 API                                                 | ❌        | 不应宣称支持                        |
| 排队追加消息                                | Streaming Input                                           | ✅ 官方     | 可集成                           |
| 中断运行                                  | `Query.interrupt()` / `AbortController`                   | ✅ 官方     | 可集成                           |
| 查询 Session                            | `getSessionInfo()`                                        | ✅ 官方     | 可集成                           |
| Session 列表                            | `listSessions()`                                          | ✅ 官方     | 可集成                           |
| 历史消息                                  | `getSessionMessages()`                                    | ✅ 官方     | 可集成                           |
| Rename                                | `renameSession()`                                         | ✅ 官方     | 可集成                           |
| Tag                                   | `tagSession()`                                            | ✅ 官方     | 可集成                           |
| 删除                                    | `deleteSession()`                                         | ✅ 官方     | 可集成                           |
| Archive                               | 没有明确等价物                                                   | ❌        | 不要拿 delete 代替                 |
| 流式文本                                  | `includePartialMessages` + `SDKPartialAssistantMessage`   | ✅ 官方     | 可集成                           |
| 工具生命周期                                | SDK messages + Hooks                                      | ✅ 官方     | 可集成                           |
| 权限审批                                  | `canUseTool` / `PermissionRequest` Hook                   | ✅ 官方     | 可集成                           |
| 用户澄清                                  | `AskUserQuestion` → `canUseTool`                          | ✅ 官方     | 可集成                           |
| MCP                                   | `mcpServers` / `createSdkMcpServer()` / `setMcpServers()` | ✅ 官方     | 可集成                           |
| 动态模型切换                                | `Query.setModel()`                                        | ✅ 官方     | 可集成                           |
| 动态权限模式                                | `Query.setPermissionMode()`                               | ✅ 官方     | 可集成                           |
| JSON Schema 回执                        | `outputFormat: {type:"json_schema"}`                      | ✅ 官方     | **非常适合你的 Receipt**            |
| 外部 SessionStore                       | `SessionStore`                                            | ✅ 官方     | 可集成                           |
| 打开 Claude Code CLI Session            | `claude --resume <id>`                                    | ✅ 官方 CLI | 条件可集成                         |
| 打开 Claude Code VS Code 原生面板指定 Session | 未找到公开 Stable API                                          | ❌        | 不承诺                           |
| 复用 Claude Max/Pro 登录给第三方产品            | 官方明确限制                                                    | ⚠️/❌     | **重要商业边界**                    |

当前 TypeScript SDK 已正式提供 `listSessions()`、`getSessionMessages()`、`getSessionInfo()`、`renameSession()`、`tagSession()` 等 API；`SessionStore` 模式还支持 `deleteSession()`、`forkSession()` 等操作。([Claude][2])

---

# 二、不要照搬 Codex 的 `thread/start`

这是 Claude 集成最重要的设计差异。

Codex 是：

```text
thread/start
    ↓
thread.id
    ↓
turn/start
```

你可以在真正提交任务之前创建 Provider Thread。

Claude 当前正式 TypeScript SDK **已经删除**早期实验性的：

```ts
unstable_v2_createSession()
unstable_v2_resumeSession()
session.send()
session.stream()
```

Anthropic 在 Agent SDK `0.3.142` 中正式移除了这套 V2 Session API，现在要求使用：

```ts
query()
+
options.sessionId
+
options.resume
+
Streaming Input
```

官方文档专门把旧 V2 页面标记为 **removed / no longer supported**。([Claude][3])

所以千万不要按网上旧文章实现：

```ts
unstable_v2_createSession()
```

这在当前版本已经是错误方案。

---

# 三、但你的 `createSession()` 抽象仍然可以保留

因为当前 SDK 正式提供：

```ts
options: {
  sessionId: string
}
```

而且要求是 UUID。([Claude][2])

因此 InfiniteMap 可以自己先分配：

```ts
const sessionId = crypto.randomUUID();
```

返回：

```ts
{
  provider: 'claudecode',
  sessionId
}
```

第一次提交时：

```ts
query({
  prompt,
  options: {
    sessionId,
    cwd,
    ...
  }
})
```

收到：

```text
SystemMessage
subtype = init
session_id = xxx
```

以后把这个 `session_id` 视为 Provider canonical ID。SDK 官方说明 session ID 同样存在于 `SystemMessage init` 和 Result message 中。([Claude][4])

因此你现有：

```ts
createSession()
↓
km_record_session()
↓
submit()
```

可以继续存在。

只是它对 Claude 的含义应该定义为：

```text
createSession()
=
allocate Claude session identity
```

而不是：

```text
已经在远程 Claude 服务创建持久化会话
```

Provider Session 真正 materialize 是第一次 `query()` 启动之后。

---

# 四、这意味着 Session 状态最好新增一个 `allocated`

例如：

```text
allocated
   ↓
starting
   ↓
running
   ↓
idle/completed
```

Claude：

```text
createSession()
→ allocated

query()
→ starting

system:init
→ running
```

Codex 则可以：

```text
thread/start
→ starting/materialized
```

这样统一模型不会强行假设所有 Vendor 都存在“远程 createSession RPC”。

---

# 五、提交任务：`query()` 是正式主接口

当前核心函数就是：

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt,
  options
});
```

它返回：

```ts
Query extends AsyncGenerator<SDKMessage, void>
```

Agent 自己会完成多轮：

```text
Claude
→ tool call
→ tool result
→ Claude
→ tool call
→ ...
→ ResultMessage
```

一次 `query()` 调用就是你在 InfiniteMap 里非常自然的一个“执行 Turn/Task”。Anthropic 自己也把 `query()` call、step、session 分开定义：一个 Session 可以由多个通过 `resume` 连接起来的 `query()` 调用组成。([Claude][2])

因此：

```ts
submit(input)
```

可以正式映射到：

```text
query()
```

---

# 六、Claude 没有 Codex 那种 Provider `turnId`

这里建议不要制造假 ID。

Codex 有：

```text
threadId
turnId
itemId
```

Claude Agent SDK 主要是：

```text
session_id
message uuid
Anthropic message.id
query() invocation
tool_use_id
```

而不是暴露一个对应：

```text
turn_123
```

的 Session-level Provider Turn ID。SDK 消息都有 message/session identifiers，但一个 `query()` 才是更适合 InfiniteMap 的执行单位。([Claude][2])

所以当前：

```ts
submit(): Promise<{ turnId?: string }>
```

对于 Claude 应保持：

```ts
turnId: undefined
```

不要拿：

```text
assistant message ID
tool_use_id
ResultMessage.uuid
```

冒充 Provider Turn ID。

你已经有：

```text
executionId
```

它才应该作为跨 Vendor 的执行主键。

---

# 七、恢复能力是真实存在的

Claude 的恢复非常成熟：

```ts
query({
  prompt: "...",
  options: {
    resume: sessionId
  }
})
```

会恢复之前的完整 Session context，包括之前读取的文件、分析、对话和 tool interactions。官方把 `resume` 明确定义为恢复指定 Session ID。([Claude][5])

所以 Extension Host 重启：

```text
.sessions.json
      ↓
sessionId
      ↓
getSessionInfo(sessionId)
      ↓
需要继续执行？
      ↓
query({ resume: sessionId })
```

是完全正式的恢复链路。

---

# 八、Claude 的历史查询现在已经比早期版本完整很多

当前 TypeScript SDK 正式有：

```ts
listSessions(...)
getSessionInfo(...)
getSessionMessages(...)
```

其中：

```ts
listSessions({
  dir: "/workspace",
  limit: 100
})
```

返回：

```text
sessionId
summary
lastModified
customTitle
firstPrompt
gitBranch
cwd
tag
createdAt
...
```

`getSessionInfo(sessionId)` 可以直接查询单个 Session，而不用扫描整个目录。([Claude][2])

因此你的：

```ts
query(input: QuerySessionInput)
```

可以非常干净地实现：

```text
getSessionInfo(sessionId)
+
按需 getSessionMessages(sessionId)
```

---

# 九、但不要再直接解析 `~/.claude/projects/*.jsonl`

这一点和你禁止读 Copilot 私有 SQLite 的原则完全一致。

Claude Code 官方虽然公开说明默认 transcript 位于：

```text
~/.claude/projects/<project>/<session-id>.jsonl
```

但紧接着明确警告：

> entry format 属于 Claude Code internal format，版本间会变化，脚本直接解析可能随任意 release 失效。

官方要求脚本使用 Agent SDK、`claude -p` 或其他公开接口。([Claude][6])

因此设计里应明确禁止：

```text
解析 ~/.claude/projects/**.jsonl
读取 Claude Code 私有 JSON entry schema
通过日志反推 Session 状态
```

而应该：

```text
listSessions()
getSessionInfo()
getSessionMessages()
SessionStore
SDK events
```

---

# 十、`SessionStore` 非常适合你的架构

Claude Agent SDK 现在甚至正式允许你提供：

```ts
interface SessionStore {
  append(...)
  load(...)
  listSessions?(...)
  listSessionSummaries?(...)
  delete?(...)
  listSubkeys?(...)
}
```

可以把 Session transcript mirror 到：

```text
S3
Redis
Postgres
自己的数据库
```

然后另一台机器仍然能够：

```ts
query({
  prompt,
  options: {
    resume: sessionId,
    sessionStore
  }
})
```

恢复。([Claude][7])

不过我**不建议用它替代 `<km>.sessions.json`**。

两者责任不同：

```text
Claude SessionStore
=
Claude conversation state

<km>.sessions.json
=
InfiniteMap node ↔ execution ↔ provider relationship
```

这个边界和你现在设计是一致的。

---

# 十一、还有一个坑：`getSessionMessages()` 不是完整审计日志

官方明确说明，Session 经历 compaction 后：

```ts
getSessionMessages()
```

返回的是 Agent resume 时看到的 **post-compaction message chain**。

例如底层 Store 可能保存 503 条 raw entries，但 `getSessionMessages()` 可能只返回压缩后的 18 条。([Claude][7])

所以 InfiniteMap 如果需要：

> 执行过程完整 tool timeline

不要期望以后从：

```text
getSessionMessages()
```

100% 重建。

应该在运行时：

```text
SDK events
       ↓
AgentSessionEvent
       ↓
.sessions.json / execution timeline
```

保存你真正需要的事件摘要。

---

# 十二、流事件能力非常强

设置：

```ts
includePartialMessages: true
```

会收到：

```text
message_start
content_block_start
content_block_delta
content_block_stop
message_delta
message_stop
```

SDK 最后还会提供完整：

```text
AssistantMessage
ResultMessage
```

工具调用也会通过 `tool_use` content block 和对应生命周期表现出来。([Claude][8])

所以你现有：

```text
session.delta
session.tool.started
session.tool.completed
```

都可以可靠实现。

---

# 十三、Hooks 可以比单纯流消息更准确地映射工具状态

TypeScript SDK 当前正式支持大量 hooks：

```text
PreToolUse
PostToolUse
PostToolUseFailure
PermissionRequest
SessionStart
SessionEnd
Stop
StopFailure
SubagentStart
SubagentStop
PreCompact
PostCompact
TaskCreated
TaskCompleted
Elicitation
...
```

这不是内部接口，是正式 Agent SDK feature。([Claude][9])

因此建议：

```text
PreToolUse
→ session.tool.started

PostToolUse
→ session.tool.completed

PostToolUseFailure
→ session.tool.failed

SessionStart
→ session.started

Stop / ResultMessage
→ execution finished
```

比单纯解析 assistant text 稳定得多。

---

# 十四、权限审批也有正式 API

这一点正好对应 Codex App Server 的：

```text
item/commandExecution/requestApproval
item/fileChange/requestApproval
```

Claude 不使用 JSON-RPC Server Request，而是：

```ts
canUseTool(...)
```

以及：

```text
PermissionRequest hook
```

Claude 请求：

```text
Bash
Write
Edit
MCP tool
AskUserQuestion
```

时，InfiniteMap 可以收到请求、展示到 Webview，再返回 allow/deny。([Claude][10])

架构可以统一成：

```text
Claude canUseTool
        ↓
ClaudeAgentSdkAdapter
        ↓
AgentPermissionRequest
        ↓
Coordinator
        ↓
Webview
        ↓
allow / deny
```

这与 Codex 的 approval flow 在领域层完全可以统一。

---

# 十五、`AskUserQuestion` 也应该接进 UI

Claude Agent SDK 的 `canUseTool` 不只是权限审批。

官方明确说明 callback 还会处理：

```text
AskUserQuestion
```

也就是 Agent 在任务过程中需要用户补充信息。([Claude][10])

因此你的 AgentSessionEvent 最好增加类似：

```ts
type AgentSessionEvent =
  | ...
  | {
      type: 'session.input.required';
      requestId: string;
      kind: 'approval' | 'question' | 'elicitation';
      ...
    };
```

这能同时承载：

```text
Codex approval
Claude permission
Claude AskUserQuestion
MCP elicitation
```

---

# 十六、MCP 完全可正式集成

Agent SDK 支持：

```ts
mcpServers: {
  infiniteMap: {
    ...
  }
}
```

还正式提供：

```ts
createSdkMcpServer()
setMcpServers()
mcpServerStatus()
```

等能力。([Claude][11])

因此：

```text
Claude Agent
      ↓
InfiniteMap MCP
```

是官方支持路线。

不过继续保持你现在的安全边界：

```text
Claude Agent
不得直接获得 KM 状态写权限
```

比较合适。

如果需要让 Claude 读取节点上下文，可以只暴露：

```text
read-only MCP tools
```

而：

```text
km_complete_task
km_record_session
km_release_claim
...
```

继续只让 Coordinator 调。

---

# 十七、Structured Receipt：Claude 这里甚至不用降级成“提示模型输出 JSON”

这是 Claude 集成最适合你当前设计的能力之一。

正式接口：

```ts
query({
  prompt,
  options: {
    outputFormat: {
      type: "json_schema",
      schema: receiptSchema
    }
  }
})
```

SDK 会对最终结果做 schema validation，并在不匹配时重新要求 Agent 修正；重试仍不能符合 schema 时，会返回 structured-output error。成功时：

```text
ResultMessage.structured_output
```

就是验证后的对象。([Claude][12])

所以你的：

```ts
AgentExecutionReceipt
```

可以直接成为：

```text
Codex:
turn/start.outputSchema

Claude:
query.options.outputFormat.json_schema
```

这两个 Provider 都可以归类成：

```ts
canStructuredOutput: true
```

而不是：

````text
让 Claude 最后打印 ```json
再自己 parse
````

---

# 十八、但 Claude Structured Output 和 Codex 不应在协议层假装完全相同

领域语义可以统一：

```text
validated AgentExecutionReceipt
```

实现机制不同。

Codex：

```text
turn/start.outputSchema
```

Claude Agent SDK：

```text
outputFormat json_schema
→ validate
→ mismatch 时 retry
```

而且 Claude 官方明确说明 structured output **只在最终 ResultMessage 提供，不能流式输出 structured JSON**。([Claude][12])

所以：

```ts
canStructuredOutput = true
canStreamStructuredOutput = false
```

会更准确。

---

# 十九、运行中“补充指令”不能直接标成 `canSteer=true`

这里和 Codex 明显不一样。

Codex 有明确：

```text
turn/steer
```

修改**正在运行的 Turn**。

Claude Streaming Input 支持：

```text
persistent interactive session
queued messages
interrupt
```

也支持 `streamInput()` 向 active session 继续写消息，但官方把这种行为描述成 **queued messages / streaming input**，而不是一个具有 `expectedTurnId` 语义的即时 steer RPC。([Claude][13])

所以我建议 Claude：

```ts
canSteer = false;
canEnqueue = true;
```

不要为了统一 UI 把：

```text
enqueue
```

冒充：

```text
steer
```

这是很重要的语义边界。

---

# 二十、Cancel 可以正式支持

对于 Streaming Input：

```ts
await queryHandle.interrupt();
```

是正式方法。当前 `Query` interface 也提供 `AbortController` 作为取消控制。([Claude][2])

因此：

```text
Codex:
turn/interrupt

Claude:
Query.interrupt()
```

可以统一成：

```ts
cancel()
```

我建议 Claude Adapter 默认采用 Streaming Input 长连接模式，而不是每个任务只调用 single-string `query()`，这样 interrupt、approval、多轮输入等能力最完整。官方也明确推荐 Streaming Input 用于 interactive long-lived applications。([Claude][13])

---

# 二十一、Rename 和 Tag 都是真的

这个地方比很多旧资料先进。

当前正式有：

```ts
renameSession(sessionId, title)
tagSession(sessionId, tag)
```

`listSessions()` 还会返回：

```text
customTitle
tag
```

等字段。([Claude][2])

所以：

```ts
canRename = true
canTag = true
```

没问题。

但没有：

```text
arbitrary metadata map
nodeId
executionId
pinned
InfiniteMap object
```

这样的通用 metadata API。

因此仍不要企图把：

```text
nodeId
executionId
kmFile
```

塞进 Claude Session。

继续放：

```text
<km>.sessions.json
```

是正确的。

---

# 二十二、Session list 和 Codex 的 `sourceKinds` 不一样

Codex 可以：

```text
thread/list
sourceKinds=["appServer"]
```

区分是谁创建的 Thread。

Claude 的：

```ts
listSessions({ dir })
```

是按目录查 Session，它没有对应：

```text
sourceKinds=["infiniteMap"]
```

这样的 Provider source filter。返回的是这个目录相关的 Claude sessions。([Claude][2])

因此不要：

```text
扫描 cwd 下所有 Claude Session
→ 全部认定为 InfiniteMap Session
```

正确做法仍然是：

```text
.sessions.json
↓
保存明确 sessionId

getSessionInfo(sessionId)
↓
验证 Provider Session 是否还存在
```

Provider list 只用于发现/恢复辅助，而不是 InfiniteMap Session ownership 的唯一事实来源。

---

# 二十三、原生打开能力有一个好消息

Claude CLI 正式支持：

```bash
claude --resume <session-id>
```

而且当前文档明确支持：

```text
ID
或者
Session name
```

恢复。([Claude][14])

因此如果用户机器上**真的安装了外部 Claude Code CLI**，InfiniteMap 可以：

```text
openSession
      ↓
VS Code integrated terminal
      ↓
claude --resume <validated-uuid>
```

这个不像调用 Claude VS Code 扩展内部 command，它是**公开 CLI contract**。

所以可以动态：

```ts
canOpenNativeCli = true;
```

---

# 二十四、但不要承诺“按 Session ID 打开 Claude Code VS Code 原生面板”

我目前没有在公开 Claude Code/Agent SDK surface 中找到类似：

```text
claudeCode.openSession(sessionId)
```

或者稳定 VS Code command 参数契约。

所以应该区分：

```text
canOpenNativeCli
```

和：

```text
canOpenNativeIde
```

Claude 当前建议：

```text
CLI = conditional true
IDE panel = false
```

也就是说 `openUri` 点开后可以让 InfiniteMap 自己展示历史，或者在安装系统 Claude CLI 时提供：

> 在 Claude Code Terminal 中继续

而不要通过未文档化 VS Code command 强行跳转。

---

# 二十五、最大的集成边界其实是认证，不是技术

这一点必须写进设计。

Anthropic 当前 Agent SDK 官方文档明确写道：

> 除非事先获得 Anthropic 批准，第三方开发者不能在自己的产品中提供 claude.ai 登录或使用 claude.ai rate limits，包括基于 Claude Agent SDK 的产品。

官方要求第三方 Agent SDK 集成使用 API key 类型的认证路径，例如 Anthropic API Key，以及官方支持的 Bedrock、Claude Platform on AWS、Google Cloud Agent Platform、Microsoft Foundry 等。([Claude][1])

所以你当前设计中的：

```text
Claude Code 复用用户已有 Max / Pro 登录
```

**不能像 Codex 那样默认作为正式产品集成方案。**

这是这次盘点中最需要提前确认的非技术风险。

---

# 二十六、所以不要设计成“复用 ~/.claude 登录凭据”

正式实现不要：

```text
读取 ~/.claude OAuth token
解析 Claude auth 文件
复制 Claude Code Max credential
调用内部 auth endpoint
```

这既违反你的安全边界，也不是 Anthropic 推荐的第三方认证方案。([Claude][1])

InfiniteMap 应该：

```text
VS Code SecretStorage
        ↓
ANTHROPIC_API_KEY
        ↓
ClaudeAgentSdkAdapter
        ↓
Claude Code subprocess
```

Webview 仍然永远拿不到 key。

也可以支持：

```text
Bedrock
Vertex
Foundry
Anthropic AWS
```

通过官方定义的环境变量/credential chain。([Claude][15])

---

# 二十七、这意味着“Provider 未登录”的 UI 也需要调整

Codex：

```text
Provider not logged in
→ 打开 Codex 登录
```

Claude Agent SDK：

```text
Provider credential unavailable
→ 配置 Anthropic API Key
或选择 Enterprise Cloud Provider
```

不要默认：

```text
打开 claude auth login
→ 用户登录 Max
→ InfiniteMap 自动吃这个订阅
```

除非你以后获得 Anthropic 对第三方 claude.ai authentication 的明确批准。([Claude][1])

---

# 二十八、`claude gateway` 也不是你要找的 Claude App Server

当前 CLI 的确已经有：

```text
claude gateway
```

但官方定义它用于企业管理员给 Bedrock、Google Cloud Agent Platform、Microsoft Foundry 部署 **SSO / policy gateway**。

它不是：

```text
Claude Session CRUD Server
Claude Agent JSON-RPC Server
```

不能拿来对应：

```text
codex app-server
```

。([Claude][14])

所以架构不要产生：

```ts
ClaudeGatewayServerAdapter
```

这个误判。

---

# 二十九、我建议 Claude Adapter 的真实映射

你现有：

```ts
interface AgentSessionAdapter {
  detectCapabilities();
  createSession();
  submit();
  query();
  update();
  cancel();
  open();
  onDidEvent();
}
```

Claude 可以这样落地：

```text
ClaudeAgentSdkAdapter

detectCapabilities
 ├─ SDK native binary availability
 ├─ startup()
 ├─ initializationResult()
 └─ credential/provider configuration

createSession
 └─ allocate UUID
    ※ 尚未 materialize provider transcript

submit (new)
 └─ query({
      sessionId,
      outputFormat,
      ...
    })

submit (existing)
 └─ query({
      resume: sessionId,
      ...
    })

submit (active)
 └─ streamInput(...)
    ※ enqueue semantics

query
 ├─ getSessionInfo()
 └─ getSessionMessages()

list
 └─ listSessions({ dir })

rename
 └─ renameSession()

tag
 └─ tagSession()

fork
 └─ forkSession()

cancel
 └─ Query.interrupt()

structuredReceipt
 └─ outputFormat:
      { type: "json_schema", schema }

stream
 ├─ SDKPartialAssistantMessage
 ├─ SDKAssistantMessage
 ├─ SDKStatusMessage
 ├─ SDKTask*
 └─ SDKResultMessage

approval
 ├─ canUseTool()
 ├─ PermissionRequest Hook
 └─ AskUserQuestion

tool lifecycle
 ├─ PreToolUse
 ├─ PostToolUse
 └─ PostToolUseFailure

mcp
 ├─ mcpServers
 ├─ createSdkMcpServer
 ├─ setMcpServers
 └─ mcpServerStatus

open
 └─ claude --resume <sessionId>
    ※ only when external CLI available
```

这些核心能力都有当前官方 API 支撑。([Claude][2])

---

# 三十、建议顺便升级 `SessionCapabilities`

你现在的：

```ts
interface SessionCapabilities {
  canCreate: boolean;
  canSubmit: boolean;
  canSteer: boolean;
  canQueryRemote: boolean;
  canUpdateRemote: boolean;
  canCancel: boolean;
  canStream: boolean;
  canOpenNative: boolean;
  sessionOwnership: 'native' | 'infinite-map';
}
```

已经不足以准确描述三个 Vendor。

我建议改成：

```ts
interface SessionCapabilities {
  canCreate: boolean;
  canResume: boolean;
  canSubmit: boolean;

  canSteer: boolean;
  canEnqueue: boolean;

  canListSessions: boolean;
  canReadSession: boolean;
  canReadHistory: boolean;

  canRename: boolean;
  canTag: boolean;
  canFork: boolean;
  canDelete: boolean;
  canArchive: boolean;

  canCancel: boolean;
  canStream: boolean;

  canStructuredOutput: boolean;
  canPermissionRequest: boolean;
  canUseMcp: boolean;

  canOpenNativeCli: boolean;
  canOpenNativeIde: boolean;

  sessionOwnership: 'native' | 'infinite-map';
}
```

Claude 典型能力就是：

```ts
{
  canCreate: true,
  canResume: true,
  canSubmit: true,

  canSteer: false,
  canEnqueue: true,

  canListSessions: true,
  canReadSession: true,
  canReadHistory: true,

  canRename: true,
  canTag: true,
  canFork: true,
  canDelete: true,
  canArchive: false,

  canCancel: true,
  canStream: true,

  canStructuredOutput: true,
  canPermissionRequest: true,
  canUseMcp: true,

  canOpenNativeCli: externalClaudeCliAvailable,
  canOpenNativeIde: false,

  sessionOwnership: 'native'
}
```

这样就不会为了迁就 Codex 的能力模型而错误描述 Claude。

---

# 三十一、三个 Vendor 现在可以形成真正的一等抽象

最终架构可以变成：

```text
                    AgentSessionAdapter
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
 CodexAppServer      CopilotSdk       ClaudeAgentSdk
    Adapter            Adapter            Adapter
          │                │                │
          ▼                ▼                ▼
 codex app-server    Copilot runtime    Claude Code
 JSON-RPC/JSONL      via SDK            runtime via SDK
          │                │                │
          └────────────────┼────────────────┘
                           │
                           ▼
                KmTaskSessionCoordinator
                           │
                      InfiniteMap MCP
```

这里 **Claude 不需要私有 Bridge，也不需要逆向 Claude Code**。官方 Agent SDK 本身就是为这种“把 Claude Code agent loop 嵌入自己的应用”设计的。([Claude][1])

## 最终结论

我会把 Claude Code/Claude Agent 这一 Vendor 评估为：

**Agent 执行：高可行性。**

**Session 创建/恢复/历史/list：高可行性。**

**结构化 Receipt：高可行性，而且可以与 Codex `outputSchema` 处于同一级别的领域能力。**

**流式状态、Tool 生命周期、Approval：高可行性。**

**MCP：高可行性。**

**Cancel：高可行性。**

**Codex 式即时 steer：当前不应承诺，只能可靠承诺 enqueue + interrupt。**

**原生 CLI Session 打开：条件可行，使用公开 `claude --resume <id>`。**

**Claude Code VS Code 面板指定 Session 打开：目前不能作为稳定能力。**

**最大的风险不是接口，而是认证：如果 InfiniteMap 是第三方产品，不能默认复用用户 Claude Max/Pro 的 claude.ai 登录和配额；正式方案应走 Anthropic API Key 或官方支持的云 Provider，除非获得 Anthropic 批准。** ([Claude][1])

因此，**我建议现在就把 `claudecode` 加入设计，而不是放到未来实验 Provider；但实现类应该是 `ClaudeAgentSdkAdapter`，而不是 `ClaudeCodeServerAdapter`。** 另外你现有设计文档的 §6.2 `AgentProvider`、§12 Provider Adapter、Capability model、认证章节、恢复章节和 Receipt 章节都需要同步扩展 Claude 这条正式路径。

[1]: https://code.claude.com/docs/en/agent-sdk/overview?utm_source=chatgpt.com "Agent SDK overview - Claude Code Docs"
[2]: https://code.claude.com/docs/en/agent-sdk/typescript?utm_source=chatgpt.com "Agent SDK reference - TypeScript - Claude Code Docs"
[3]: https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview?utm_source=chatgpt.com "TypeScript SDK V2 session API (removed) - Claude Code Docs"
[4]: https://code.claude.com/docs/en/agent-sdk/agent-loop?utm_source=chatgpt.com "How the agent loop works - Claude Code Docs"
[5]: https://code.claude.com/docs/en/agent-sdk/sessions?utm_source=chatgpt.com "Work with sessions - Claude Code Docs"
[6]: https://code.claude.com/docs/en/sessions "Manage sessions - Claude Code Docs"
[7]: https://code.claude.com/docs/en/agent-sdk/session-storage?utm_source=chatgpt.com "Persist sessions to external storage - Claude Code Docs"
[8]: https://code.claude.com/docs/en/agent-sdk/streaming-output?utm_source=chatgpt.com "Stream responses in real-time - Claude Code Docs"
[9]: https://code.claude.com/docs/en/agent-sdk/hooks?utm_source=chatgpt.com "Intercept and control agent behavior with hooks"
[10]: https://code.claude.com/docs/en/agent-sdk/user-input?utm_source=chatgpt.com "Handle approvals and user input - Claude Code Docs"
[11]: https://code.claude.com/docs/en/agent-sdk/mcp?utm_source=chatgpt.com "Connect to external tools with MCP - Claude Code Docs"
[12]: https://code.claude.com/docs/en/agent-sdk/structured-outputs "Get structured output from agents - Claude Code Docs"
[13]: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode?utm_source=chatgpt.com "Streaming Input - Claude Code Docs"
[14]: https://code.claude.com/docs/en/cli-reference "CLI reference - Claude Code Docs"
[15]: https://code.claude.com/docs/en/agent-sdk/quickstart?utm_source=chatgpt.com "Quickstart - Claude Code Docs"
