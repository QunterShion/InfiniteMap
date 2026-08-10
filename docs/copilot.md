
我把你当前设计稿中 **VS Code Copilot 相关的所有集成假设**，按截至 **2026-08-10** 的 VS Code 官方 API、GitHub Copilot SDK、VS Code 当前 Proposed API 和 Agent Host 实现重新核了一遍。

先给结论：

> **你当前设计对“VS Code Stable API 无法直接 CRUD Copilot 原生会话”的判断仍然成立；但“只有等 `github.copilot-chat` 导出 Bridge 才能获得 Copilot 原生 Session 能力”已经过时。**
>
> 现在 GitHub 已正式提供 **GitHub Copilot SDK**，并且已经 GA。它真实支持 `createSession / resumeSession / listSessions / getEvents / send / steer / abort / deleteSession / lifecycle events` 等能力。VS Code 自己现在的 **Copilot harness 也是由这个 Copilot SDK 驱动的**。([GitHub][1])
>
> 但必须再区分一点：**Copilot SDK Session ≠ 可以直接控制 VS Code 内置 Copilot Chat Session UI。** 后者目前仍没有面向普通第三方扩展的 Stable CRUD API。

所以我建议你把现在的：

```text
CopilotPublicAdapter
CopilotBridgeAdapter
```

改成三层：

```text
CopilotLanguageModelAdapter        // VS Code Stable
CopilotSdkAdapter                  // GitHub 官方 Copilot SDK，推荐主路径
CopilotChatSessionUiAdapter        // VS Code proposed API，可选实验层
```

而原来的 `CopilotBridgeAdapter` 可以直接取消，或者仅保留成未来兼容层。

---

# 一、你设计里涉及的 Copilot 接口，逐项核验

| 设计需要的能力                               | 当前真实接口                                                      |   是否存在 | 稳定性              | 能否正式集成       |
| -------------------------------------------- | ----------------------------------------------------------------- | ---------: | ------------------- | ------------------ |
| 找到 Copilot 模型                            | `vscode.lm.selectChatModels({ vendor:'copilot' })`              |         ✅ | VS Code Stable      | ✅                 |
| 调用 Copilot 模型                            | `LanguageModelChat.sendRequest()`                               |         ✅ | Stable              | ✅                 |
| 注册 Chat Participant                        | `vscode.chat.createChatParticipant()`                           |         ✅ | Stable              | ✅                 |
| 获取当前 Participant 历史                    | `ChatContext.history`                                           |         ✅ | Stable              | ✅，但范围受限     |
| 给 Copilot Agent 增加工具                    | `contributes.languageModelTools` + `vscode.lm.registerTool()` |         ✅ | Stable              | ✅                 |
| 创建真正 Copilot Agent Session               | `CopilotClient.createSession()`                                 |         ✅ | Copilot SDK GA      | ✅                 |
| 恢复 Session                                 | `resumeSession()`                                               |         ✅ | GA                  | ✅                 |
| 查询所有 Session                             | `listSessions()`                                                |         ✅ | GA                  | ✅                 |
| 获取 Session 历史                            | `session.getEvents()`                                           |         ✅ | GA                  | ✅                 |
| 提交任务                                     | `session.send()` / `sendAndWait()`                            |         ✅ | GA                  | ✅                 |
| 运行中追加/steer                             | `send({mode:"immediate"})`                                      |         ✅ | GA                  | ✅                 |
| 排队下一条消息                               | `send({mode:"enqueue"})`                                        |         ✅ | GA                  | ✅                 |
| 取消当前执行                                 | `session.abort()`                                               |         ✅ | GA                  | ✅                 |
| 删除 Session                                 | `client.deleteSession()`                                        |         ✅ | GA                  | ✅                 |
| 监听 Session 事件                            | `session.on()`                                                  |         ✅ | GA                  | ✅                 |
| 监听生命周期                                 | `client.onLifecycle()`                                          |         ✅ | GA                  | ✅                 |
| 查询模型                                     | `client.listModels()`                                           |         ✅ | GA                  | ✅                 |
| 查询认证状态                                 | `getAuthStatus()`                                               |         ✅ | GA                  | ✅                 |
| 修改当前模型                                 | `session.setModel()`                                            |         ✅ | GA                  | ✅                 |
| 任意更新 Session metadata                    | 无通用 API                                                        |         ❌ | —                  | ❌                 |
| rename Session                               | SDK 没有正式 rename API                                           |         ❌ | CLI`/rename` only | ❌                 |
| 打开 VS Code 内置 Copilot Session            | 无 Stable API                                                     |         ❌ | —                  | ❌                 |
| 查询 VS Code 内置 Copilot 的全部历史 Session | 无 Stable API                                                     |         ❌ | —                  | ❌                 |
| 把自己的 Session 接入 VS Code Session UI     | `chatSessionsProvider`                                          |         ✅ | **Proposed**  | ⚠️ 开发/实验可用 |
| 读取 Copilot 私有 storage/SQLite             | 私有实现                                                          | 有内部数据 | 非 API              | ❌ 禁止依赖        |

这意味着你的统一 Adapter **绝大多数能力已经可以直接用正式接口实现，不需要等待 Copilot 扩展 Bridge**。

---

# 二、`vscode.lm.selectChatModels()`：真实存在，但它只是“模型 API”

你设计稿写：

> 公开的 VS Code Chat/Language Model API 可以选择模型和发送请求。

这是完全正确的。

现在的正式接口：

```ts
const models = await vscode.lm.selectChatModels({
  vendor: 'copilot'
});

const model = models[0];

const response = await model.sendRequest(
  messages,
  {},
  cancellationToken
);
```

官方明确支持通过：

```text
vendor
id
family
version
```

筛选模型；Copilot 模型在第三方扩展首次使用时还需要用户授权。([Visual Studio Code][2])

因此你可以做：

```text
InfiniteMap
   ↓
VS Code Extension
   ↓
vscode.lm.selectChatModels()
   ↓
Copilot Model
```

### 但它没有 Session

这是关键区别。

Language Model API 本质上相当于：

```text
messages[]
   ↓
LLM
   ↓
response stream
```

它不会给你：

```text
copilotSessionId
resumeSession
listSessions
abortAgent
workspace agent state
```

所以你原来的：

```ts
CopilotPublicAdapter
```

如果继续基于 `vscode.lm`，确实只能：

```text
InfiniteMap 自己生成 sessionId
InfiniteMap 自己保存历史
每轮重新组装 messages
```

这部分原判断没有问题。([Visual Studio Code][2])

---

# 三、`vscode.chat.createChatParticipant()`：真实，但也不是 Copilot Session API

这个接口也是稳定公开 API：

```ts
vscode.chat.createChatParticipant(
  'infinitemap.agent',
  handler
);
```

handler 会收到：

```ts
ChatRequest
ChatContext
ChatResponseStream
CancellationToken
```

并且：

```ts
request.model
```

就是当前用户在 Chat UI 里选择的模型。([Visual Studio Code][3])

它也能读：

```ts
context.history
```

但官方特别说明：

> Participant 只能访问**当前 Chat Session 中提到该 Participant 的消息**。

也就是说：

```text
Copilot Chat Session

用户 → @workspace
Copilot → xxx

用户 → @infinitemap
InfiniteMap → xxx

用户 → Copilot
Copilot → xxx
```

你的 Participant 不会因此获得整个 Copilot Session 数据库。

它主要适合：

```text
用户
 ↓
VS Code Chat
 ↓
@infinitemap
 ↓
InfiniteMap Extension
```

而不是：

```text
InfiniteMap
 ↓
任意查询 Copilot 历史 Session
```

后者没有这个能力。([Visual Studio Code][3])

---

# 四、一个你设计稿没有充分利用的 Stable API：Copilot Tool

这个实际上非常适合 InfiniteMap。

VS Code 正式提供：

```json
{
  "contributes": {
    "languageModelTools": [...]
  }
}
```

并通过：

```ts
vscode.lm.registerTool(...)
```

实现工具。

Copilot Agent Mode 会把：

```text
VS Code built-in tools
+
extension tools
+
MCP tools
```

统一交给模型。([Visual Studio Code][4])

所以 InfiniteMap 完全可以正式注册：

```text
read_km_node
get_km_context
validate_km_change
claim_km_node
renew_km_lease
submit_km_receipt
```

例如：

```ts
vscode.lm.registerTool(
  'infinitemap_get_node',
  new InfiniteMapGetNodeTool()
);
```

然后用户在正常 Copilot Agent Session 中也可能调用：

```text
#infiniteMapNode
```

这一整条链路是 **VS Code Stable API**，不是 hack。

这和你当前的 MCP 设计甚至可以并存：

```text
                InfiniteMap Core
                    ↑
          ┌─────────┴─────────┐
          │                   │
VS Code LM Tool          InfiniteMap MCP
          │                   │
 VS Code Copilot        Codex / Copilot SDK
```

这会比单纯依赖 MCP 更适合 VS Code 本地 Copilot Agent。

---

# 五、最大变化：GitHub Copilot SDK 已经正式存在

这是你这份方案现在最需要修改的地方。

GitHub 当前已经公开：

```text
@github/copilot-sdk
```

而且 GitHub 官方目前明确说明：

> GitHub Copilot SDK 已 GA，并遵循 Semantic Versioning。

Node/TypeScript：

```bash
npm install @github/copilot-sdk
```

而且 **Node.js 版本已经自动捆绑 Copilot CLI/runtime，不要求用户另装 `copilot` CLI**。SDK 与 runtime 之间使用 JSON-RPC。([GitHub][1])

基本架构：

```text
InfiniteMap VS Code Extension
          │
          ▼
   @github/copilot-sdk
          │
       JSON-RPC
          │
          ▼
 Copilot CLI Runtime
```

这跟你对 Codex 的：

```text
Extension
 ↓
codex app-server
```

其实已经非常相似。

---

# 六、`createSession()`：真实存在

正式接口：

```ts
const client = new CopilotClient();

await client.start();

const session = await client.createSession({
  model: '...',
  workingDirectory: cwd
});
```

官方定义：

```ts
createSession(
  config?: SessionConfig
): Promise<CopilotSession>
```

并且支持：

```text
sessionId
model
reasoningEffort
workingDirectory
tools
systemMessage
availableTools
excludedTools
provider
streaming
infiniteSessions
permission handler
custom agents
...
```

([GitHub][5])

所以你设计里的：

```ts
createSession(input)
```

现在可以直接映射：

```text
CopilotClient.createSession()
```

无需假想 Bridge。

---

# 七、`submitTurn()`：可以直接映射 `session.send()`

Copilot SDK：

```ts
await session.send({
  prompt: 'Implement this task'
});
```

或者：

```ts
await session.sendAndWait({
  prompt: 'Implement this task'
});
```

都是正式 API。([GitHub][6])

所以：

```ts
submitTurn(input)
```

可以映射：

```text
session.send()
```

这里甚至比你原设计假设得更完整。

---

# 八、Copilot 现在甚至有真正的 `steer`

这一点特别适合你现在的统一 Provider 抽象。

官方 SDK 明确区分：

```ts
session.send({
  prompt: "...",
  mode: "immediate"
})
```

与：

```ts
session.send({
  prompt: "...",
  mode: "enqueue"
})
```

其中：

```text
immediate
```

官方直接称作：

> Steering，运行中注入，不需要 abort 当前 Turn。

而：

```text
enqueue
```

是排队等待当前消息处理完毕。([GitHub][6])

于是你的统一接口完全可以：

```ts
steerSession(...)
```

映射为：

```text
Codex
→ turn/steer + expectedTurnId

Copilot
→ session.send({ mode: "immediate" })
```

这是非常漂亮的一层统一。

---

# 九、`querySessions()`：现在真实存在

你的 Bridge 原设计：

```ts
querySessions(
  input: QuerySessionInput
): Promise<SessionPage>
```

现在可以直接基于：

```ts
client.listSessions()
```

实现。

官方 SessionMetadata 包含：

```text
sessionId
startTime
modifiedTime
summary
isRemote
context
```

其中 context 又可以包含 working directory 等信息。([GitHub][5])

因此：

```text
InfiniteMap
 ↓
listSessions()
 ↓
按 cwd 过滤
 ↓
找到历史 Copilot SDK Sessions
```

是真的。

这已经不是：

> InfiniteMap-managed fake history

而是真正的 Copilot Runtime Session。

---

# 十、读取完整历史：`getEvents()` 真实存在

Session 恢复：

```ts
const session =
  await client.resumeSession(sessionId);
```

然后：

```ts
const events =
  await session.getEvents();
```

正式支持。([GitHub][6])

Event 不只是文本，包括：

```text
user message
assistant message
tool execution
session start
session idle
error
usage
stream delta
...
```

SDK 当前文档称有 40+ event types。([GitHub][6])

所以你原来：

```text
Copilot Public
只能恢复 InfiniteMap 摘要
```

可以保留作为 **LM API fallback**。

但主路径应该升级为：

```text
Copilot SDK
 ↓
resumeSession
 ↓
getEvents
 ↓
真正恢复 Agent Session
```

---

# 十一、`cancelTurn()`：完全可实现

正式 API：

```ts
await session.abort();
```

语义：

> abort currently processing message。

([GitHub][5])

因此统一映射：

```text
Codex:
turn/interrupt

Copilot:
session.abort()
```

没有问题。

---

# 十二、`onDidChangeSession()`：也可以实现

SDK 有两个层次。

Session 内：

```ts
session.on(event => ...)
```

Client 生命周期：

```text
session.created
session.deleted
session.updated
session.foreground
session.background
```

官方文档明确提供 Session lifecycle subscriptions。([GitHub][6])

所以：

```ts
onDidChangeSession(...)
```

可以映射为：

```text
session.on(...)
+
client.onLifecycle(...)
```

这比当前设计的 Bridge 假设更扎实。

---

# 十三、但是 `updateSession()` 设计得太宽了

你现在 Bridge：

```ts
updateSession(
  input: UpdateSessionInput
): Promise<SessionSnapshot>
```

这里需要改。

Copilot SDK 有：

```text
session.setModel()
```

以及一些：

```text
plan
mode
agent
history
```

相关 API。([GitHub][6])

但是目前**没有一个任意 Session metadata update API**。

尤其是：

```text
rename
```

官方 compatibility 表明确把：

```text
/session
/resume
/rename
```

列在 CLI/TUI workflow，而不是 SDK programmatic API 中。([GitHub][6])

所以不要设计：

```ts
updateSession({
  title,
  pinned,
  arbitraryMetadata
})
```

然后假定 Copilot 一定支持。

应该 capability 化：

```ts
canRenameSession: false
canPinSession: false
canChangeModel: true
```

---

# 十四、`openSession()`：目前仍然不能按你想要的方式实现

这是最需要保持谨慎的地方。

Copilot SDK 确实有：

```text
getForegroundSessionId()
setForegroundSessionId()
```

但是官方明确限定：

> only available when connecting to a server running in **TUI + server mode (`--ui-server`)**。

它控制的是 Copilot CLI TUI，不是 VS Code Chat UI。([GitHub][7])

所以不能：

```ts
openSession(sessionId)
```

然后假定：

```text
VS Code
自动打开 Copilot Chat
并显示这个 session
```

目前没有这种 Stable VS Code API。

所以你的：

```ts
canOpenNative
```

对于 Stable VS Code 仍应为：

```ts
false
```

---

# 十五、VS Code 确实已经有“真正 Session API”，但它仍是 Proposed

现在 VS Code 源码中确实存在：

```ts
vscode.chat.createChatSessionItemController(...)
```

以及：

```ts
vscode.chat.registerChatSessionContentProvider(...)
```

还可以：

```ts
provideChatSessionContent(...)
```

返回一个真正的：

```text
ChatSession
```

给 VS Code 原生 Chat UI 展示。([GitHub][8])

`ChatSessionItem` 自身甚至有：

```text
resource
label
status
archived
metadata
...
```

而 `resource` 是唯一 Session 地址，并用于打开 Session。([GitHub][9])

也就是说从架构角度，现在已经能够：

```text
Copilot SDK Session
       ↓
InfiniteMap Extension
       ↓
ChatSessionContentProvider
       ↓
VS Code Agents / Chat Session UI
```

这非常接近你的理想方案。

### 但现在不能作为正式发行依赖

因为它仍位于：

```text
vscode.proposed.chatSessionsProvider.d.ts
```

而 VS Code 官方明确规定 Proposed API：

* 不稳定；
* 可能发生 breaking change；
* 主要面向 Insiders 测试；
* **不应该被普通 Marketplace Extension 作为正式依赖发布。** ([Visual Studio Code][10])

所以它适合：

```ts
experimentalNativeSessionUi = true
```

不适合：

```text
InfiniteMap V1 mandatory dependency
```

---

# 十六、更加重要：Chat Session Provider 也不能读取 Copilot 自己的 Session

它的语义是：

```text
“我是一个 Session Provider，
这些 Session 是我提供给 VS Code 的。”
```

而不是：

```text
“把 VS Code/Copilot 已有的所有 Session 给我。”
```

微软自己的 API 设计说明也是：

> extensions contribute a chat session controller / provider，由 provider 列出并 resolve **其提供的 session**。([GitHub][11])

因此即便用了 proposed API，也不要尝试：

```text
query VS Code built-in Copilot sessions
```

比较合理的是：

```text
CopilotSdkAdapter
       ↓
InfiniteMap-owned Copilot SDK sessions
       ↓
ChatSessionItemController
       ↓
VS Code 原生 Session UI
```

这两者在 UI 上看起来很原生，但所有权是 InfiniteMap。

---

# 十七、为什么说 Copilot SDK 是正确的新主路径

VS Code 本身现在已经验证了这个架构。

2026 年当前 VS Code 官方文档明确写道：

> Copilot harness is powered by the Copilot SDK and runs on the Agent Host.

而且 VS Code 的 Agent Host：

```text
独立拥有 Session
Session 可以在窗口关闭后继续运行
可以出现在多个窗口
一个 Session 可以包含多个 Chat
```

([Visual Studio Code][12])

所以现在 VS Code 内部实际上就是：

```text
VS Code UI
    │
Agent Host
    │
Copilot SDK
    │
Copilot Agent Runtime
```

这也是为什么我认为 InfiniteMap 不应该再把：

```text
github.copilot-chat extension Bridge
```

作为架构前提。

官方 SDK 已经把真正需要的 Agent runtime surface 暴露出来了。

---

# 十八、但“VS Code 内置 Agent Host”目前不能直接被第三方扩展操控

这里不要把两个事情混起来：

```text
VS Code 自己
→ 可以使用内部 Agent Host
→ 它的 Copilot harness 使用 SDK
```

不等于：

```text
InfiniteMap Extension
→ 有公开 vscode.agentHost API
→ 随便取得 VS Code Copilot session
```

截至目前，没有对应的 Stable Extension API。

因此 InfiniteMap 自己使用：

```ts
new CopilotClient()
```

得到的应该理解成：

> **官方 Copilot Agent Session**

而不是：

> **VS Code 内置 Copilot Chat 自己创建的那个 Session 对象**

这是架构边界。

---

# 十九、认证也需要修改你设计稿的一句话

你当前写：

> Copilot 授权由 Copilot/VS Code 管理。

对 `vscode.lm` 是正确的。

但如果改用 `@github/copilot-sdk`，需要更精确。

SDK 官方支持：

```text
copilot CLI 已保存 OAuth
OAuth GitHub App Token
COPILOT_GITHUB_TOKEN
GH_TOKEN
GITHUB_TOKEN
BYOK
```

Node SDK 自带 runtime，但普通 SDK Client 默认使用的是 **Copilot CLI 的 stored OAuth credentials**，不是一个公开的：

```text
vscode.getCopilotToken()
```

接口。([GitHub][1])

有意思的是 VS Code 自己的内置 Copilot harness 可以共享 VS Code Chat 的 GitHub authentication context，但这是 VS Code/Agent Host 自己的集成能力。([Visual Studio Code][12])

所以设计最好区分：

```text
CopilotLanguageModelAdapter
auth = VS Code/Copilot consent

CopilotSdkAdapter
auth = Copilot SDK auth context
```

不要假定二者一定完全共享登录状态。

---

# 二十、你的 Receipt 设计仍需保持降级

Codex 有：

```text
turn/start.outputSchema
```

严格约束最终输出。

目前我没有在 Copilot SDK 正式 surface 里找到完全等价的：

```ts
outputSchema
```

Session API。

Copilot SDK 确实支持：

```text
custom tools
JSON Schema tool parameters
```

([GitHub][6])

因此可以把：

```text
submit_execution_receipt
```

做成一个 JSON Schema Tool，让模型最后调用它，这会比纯文本 JSON 更可靠。

但它仍不能简单宣称等价于 Codex 的 server-side structured output。

所以你现在设计的：

```text
解析失败
→ awaiting_review
→ 禁止自动回写
```

应该保留。

---

# 二十一、我建议重新定义 Copilot 三层 Adapter

最终架构建议变成：

```text
                     AgentSessionAdapter
                           │
           ┌───────────────┼────────────────┐
           │               │                │
           ▼               ▼                ▼
CopilotLanguageModel   CopilotSdk       CopilotSessionUI
Adapter                Adapter           Adapter
           │               │                │
           ▼               ▼                ▼
vscode.lm           @github/          VS Code proposed
                   copilot-sdk        chatSessionsProvider
           │               │                │
      Stable LM       Real Agent        Native UI
      no session       Session          experimental
```

其中 **真正建议作为主执行链路的是中间的 `CopilotSdkAdapter`**。

---

# 二十二、你原来的 Bridge 接口，可以这样映射

| 你的接口                      | Copilot SDK 映射                                         | 判断               |
| ----------------------------- | -------------------------------------------------------- | ------------------ |
| `getCapabilities()`         | `getStatus()` + `getAuthStatus()` + `listModels()` | ✅                 |
| `createSession()`           | `client.createSession()`                               | ✅                 |
| `submitTurn()`              | `session.send()`                                       | ✅                 |
| `querySessions()`           | `client.listSessions()`                                | ✅                 |
| `resumeSession()`           | `client.resumeSession()`                               | ✅                 |
| `getHistory()`              | `session.getEvents()`                                  | ✅                 |
| `steer()`                   | `send({mode:'immediate'})`                             | ✅                 |
| `cancelTurn()`              | `session.abort()`                                      | ✅                 |
| `deleteSession()`           | `client.deleteSession()`                               | ✅                 |
| `onDidChangeSession()`      | `session.on()` + lifecycle                             | ✅                 |
| `updateSession()`           | 无 generic API                                           | ⚠️ 拆能力        |
| `renameSession()`           | 无正式 SDK API                                           | ❌                 |
| `openSession()`             | 无 VS Code Stable API                                    | ❌                 |
| `openSessionInCopilotTui()` | `setForegroundSessionId()`                             | ⚠️ 仅 TUI server |

因此你原设计里那个假设中的 `InfiniteMapSessionBridgeV1`，**现在约 70–80% 已经可以直接由官方 SDK 实现**。

---

# 二十三、我建议直接修改你设计稿的 §12.3

原来的核心逻辑：

```text
Copilot
├─ Bridge available
│    └─ native session CRUD
│
└─ No Bridge
     └─ Language Model API
          └─ InfiniteMap-managed session
```

应升级成：

```text
Copilot
│
├─ CopilotSdkAdapter                 ← 主路径
│    │
│    ├─ createSession
│    ├─ resumeSession
│    ├─ listSessions
│    ├─ getEvents
│    ├─ send
│    ├─ steer
│    ├─ abort
│    ├─ deleteSession
│    ├─ tools
│    └─ lifecycle
│
├─ CopilotLanguageModelAdapter       ← fallback
│    │
│    ├─ vscode.lm.selectChatModels
│    ├─ sendRequest
│    └─ InfiniteMap-managed history
│
└─ CopilotChatSessionUiAdapter       ← optional / experimental
     │
     ├─ ChatSessionItemController
     └─ ChatSessionContentProvider
```

并继续保留一条硬边界：

```text
禁止：

读取 github.copilot-chat 私有 storage
读取 SQLite
import 私有模块
依赖内部 command 参数
假设可以 CRUD VS Code built-in Copilot sessions
```

---

# 最终判断

和刚才 Codex App Server 的结果类似，这次甚至有一个更积极的结论：

**Copilot 侧已经存在一套真实、官方、GA、足以支撑 InfiniteMap Agent Session 核心生命周期的接口。** GitHub Copilot SDK 已经可以承担你原设计中 `CopilotBridgeAdapter` 的绝大多数职责，而且 VS Code 自己当前的 Copilot harness 也采用 Copilot SDK，说明这个技术路线并不是外围 hack。([GitHub][1])

但需要严格区分两个概念：

**“原生 Copilot Agent Session”——可以，通过官方 Copilot SDK。**

**“直接 CRUD / 打开 VS Code 内置 Copilot Chat 自己拥有的 Session”——目前仍不可以通过 Stable Extension API。**

因此对 InfiniteMap，我会把 Copilot 集成可行性从你设计稿隐含的“**依赖未来 Bridge，中等风险**”，调整为：

> **Copilot Agent 执行层：高可行性。**
> **Session CRUD：高可行性，走 Copilot SDK。**
> **运行中 steer/cancel/history：高可行性。**
> **VS Code 原生 Session UI 深度融合：中等可行性，目前 Proposed。**
> **操控 VS Code 内置 Copilot 自身历史会话：不可作为正式能力承诺。**

也就是说，**现在已经没有必要把 Copilot 放到“等 Bridge 才做”的 Phase 4 末端了；`CopilotSdkAdapter` 已经可以和 `CodexAppServerAdapter` 作为两个对等的一等 Provider 来设计。**

[1]: https://github.com/github/copilot-sdk?utm_source=chatgpt.com
[2]: https://code.visualstudio.com/api/extension-guides/ai/language-model?utm_source=chatgpt.com
[3]: https://code.visualstudio.com/api/extension-guides/ai/chat?utm_source=chatgpt.com
[4]: https://code.visualstudio.com/api/extension-guides/ai/tools
[5]: https://github.com/github/copilot-sdk/blob/main/nodejs/README.md
[6]: https://github.com/github/copilot-sdk/blob/main/docs/troubleshooting/compatibility.md
[7]: https://github.com/github/copilot-sdk/blob/main/dotnet/README.md?utm_source=chatgpt.com
[8]: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts
[9]: https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/vscode.proposed.chatSessionsProvider.d.ts?utm_source=chatgpt.com
[10]: https://code.visualstudio.com/api/advanced-topics/using-proposed-api?utm_source=chatgpt.com
[11]: https://github.com/microsoft/vscode/issues/268063
[12]: https://code.visualstudio.com/docs/agents/run/agent-harnesses
