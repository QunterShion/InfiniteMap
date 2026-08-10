
我按你这份 `editor-agent-session-task-execution-design.md` 中**所有涉及 Codex App Server 的调用点**，对照了当前官方 App Server 文档和 OpenAI Codex 官方仓库。

结论很明确：

**整体技术路线成立，设计中列出的 Codex 核心接口基本都真实存在，而且是官方公开的可集成接口。** `codex app-server` 本身就是 OpenAI 给 VS Code 等 rich client 使用的集成层，官方明确把它定位为“用于在自己的产品中做深度集成，包括认证、会话历史、审批、流式 Agent 事件”。默认通信方式是启动 `codex app-server` 子进程，通过 stdio 传输 JSONL/JSON-RPC，而不是调用某个私有 HTTP API。 ([OpenAI Developers][1])

但你的设计稿里有 **5 个需要修改的地方**，其中两个会直接导致实现后出现“接口明明存在但查不到/恢复错会话”的问题。

## 一、设计中涉及的 Codex Server 接口盘点

| 设计中的能力      | 实际 App Server 接口                  | 是否真实存在 | API 状态               | 结论                           |
| ----------------- | ------------------------------------- | -----------: | ---------------------- | ------------------------------ |
| App Server 初始化 | `initialize` + `initialized`      |           ✅ | Stable                 | 可直接集成                     |
| 创建会话          | `thread/start`                      |           ✅ | Stable                 | 可直接集成                     |
| 恢复会话          | `thread/resume`                     |           ✅ | Stable                 | 可直接集成                     |
| 查询单会话        | `thread/read`                       |           ✅ | Stable                 | **优先用于恢复探测**     |
| 查询历史          | `thread/list`                       |           ✅ | Stable                 | 可集成，但注意`sourceKinds`  |
| 提交任务          | `turn/start`                        |           ✅ | Stable                 | 核心执行接口                   |
| 结构化回执        | `turn/start.outputSchema`           |           ✅ | Stable                 | **你的用法正确**         |
| 运行中补充指令    | `turn/steer`                        |           ✅ | Stable                 | 可直接集成                     |
| Steer 并发保护    | `expectedTurnId`                    |           ✅ | Stable                 | **你的设计正确**         |
| 取消执行          | `turn/interrupt`                    |           ✅ | Stable                 | 可直接集成                     |
| 设置会话名称      | `thread/name/set`                   |           ✅ | Stable                 | 可集成，但有调用时序坑         |
| 修改 pin          | `thread/metadata/update`            |           ✅ | Stable                 | 可直接集成                     |
| 修改 Git metadata | `thread/metadata/update`            |           ✅ | Stable                 | 可直接集成                     |
| 归档会话          | `thread/archive`                    |           ✅ | Stable                 | 可集成，但不应用于普通任务结束 |
| 运行状态事件      | `thread/status/changed`             |           ✅ | Stable                 | 可直接集成                     |
| Turn 开始/结束    | `turn/started`, `turn/completed`  |           ✅ | Stable                 | 核心状态机事件                 |
| Item 开始/结束    | `item/started`, `item/completed`  |           ✅ | Stable                 | 核心流事件                     |
| 文本流            | `item/agentMessage/delta`           |           ✅ | Stable                 | 可直接展示                     |
| 命令输出流        | `item/commandExecution/outputDelta` |           ✅ | Stable                 | 可直接展示                     |
| Turn diff         | `turn/diff/updated`                 |           ✅ | Stable                 | 建议纳入审核 UI                |
| 分页查询 turns    | `thread/turns/list`                 |           ✅ | **Experimental** | 你的 feature flag 设计正确     |
| 分页查询 items    | `thread/items/list`                 |           ✅ | **Experimental** | 同上                           |
| TS schema 生成    | `codex app-server generate-ts`      |           ✅ | 官方 CLI               | 强烈建议使用                   |
| JSON Schema 生成  | `generate-json-schema`              |           ✅ | 官方 CLI               | 强烈建议使用                   |

官方目前明确区分 stable / experimental surface：初始化时不传 `experimentalApi:true`，实验字段和方法会直接被 App Server 拒绝；schema 生成默认也只生成 stable surface。这与你设计里的 `experimentalCodexApi=false` 完全一致。 ([developers.openai.com][1])

---

# 二、`thread/start`：真实存在，而且正适合 InfiniteMap

你的：

```text
createSession()
    ↓
thread/start
```

完全成立。

官方返回的结构包含：

```json
{
  "thread": {
    "id": "thr_123",
    "sessionId": "thr_123",
    "ephemeral": false,
    "modelProvider": "openai"
  }
}
```

并同时发送：

```text
thread/started
```

`cwd`、model、approvalPolicy、sandbox 等也都可以在启动线程时传入。 ([OpenAI Developers][1])

所以：

```ts
createSession(input)
```

映射：

```text
thread/start
```

没有问题。

---

# 三、最需要修改的问题：不要把 `sessionId` 当 Codex 会话 ID

这是目前设计里最危险的地方。

你现在定义：

```ts
interface AgentSessionRef {
  provider: AgentProvider;
  sessionId: string;
  threadId?: string;
}
```

然后设计又要求：

> 记录 thread.id 和 thread.sessionId

这两个字段在 Codex 里**不是同一种东西**。

官方定义：

```text
thread.id
```

是具体 Thread 的唯一 ID。

而：

```text
thread.sessionId
```

表示：

> 当前 live session tree 的 root。

例如：

```text
Thread A
id = thr_A
sessionId = thr_A
```

fork：

```text
Thread B
id = thr_B
sessionId = thr_A
```

再 fork：

```text
Thread C
id = thr_C
sessionId = thr_A
```

也就是说：

```text
thr_A
 ├─ thr_B
 └─ thr_C
```

三个不同会话可能共享：

```text
sessionId = thr_A
```

官方甚至明确要求客户端**读取 `thread.sessionId`，不要自行从 threadId 推断它**。 ([OpenAI Developers][1])

所以你的模型应该改成类似：

```ts
interface AgentSessionRef {
  provider: AgentProvider;

  // InfiniteMap 语义上的唯一 Provider 会话 ID
  sessionId: string;

  // Codex 唯一 Thread ID
  threadId?: string;

  // Codex live session tree root
  sessionTreeId?: string;

  turnId?: string;

  surface:
    | 'app-server'
    | 'native-bridge'
    | 'infinite-map-managed';

  openUri: string;
}
```

对于 Codex：

```ts
sessionId = thread.id;
threadId = thread.id;
sessionTreeId = thread.sessionId;
```

而不是：

```ts
sessionId = thread.sessionId; // 不推荐
```

否则未来一旦你使用：

```text
thread/fork
```

两个执行记录可能出现相同 `sessionId`。

---

# 四、`turn/start + outputSchema`：这部分设计是正确的

你设计中非常关键的一句：

> Codex `turn/start` 使用 `outputSchema` 强制 AgentExecutionReceipt。

这个能力是真实存在的，而且目前在官方 stable API 示例中直接出现：

```json
{
  "method": "turn/start",
  "params": {
    "threadId": "thr_123",
    "input": [
      {
        "type": "text",
        "text": "..."
      }
    ],
    "outputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  }
}
```

`outputSchema` 只影响当前 turn，不会永久修改 thread。 ([OpenAI Developers][1])

因此 InfiniteMap 的：

```ts
interface AgentExecutionReceipt {
  executionId: string;
  status: 'succeeded' | 'failed' | 'blocked';
  summary: string;
  artifacts: ...;
  validations: ...;
  collaborationChildren?: string[];
}
```

完全可以直接转换成 JSON Schema 给 Codex。

这比：

````text
让模型最后输出 ```json
````

可靠得多。

这部分不用改架构。

---

# 五、`turn/steer + expectedTurnId` 也是真实接口

你的：

```text
turn/steer + expectedTurnId
```

完全准确。

官方要求：

```json
{
  "method": "turn/steer",
  "params": {
    "threadId": "thr_123",
    "input": [...],
    "expectedTurnId": "turn_456"
  }
}
```

`expectedTurnId` 必须匹配当前 active turn，否则调用失败。

而且 `turn/steer`：

* 不创建新 Turn；
* 不发送新的 `turn/started`；
* 不能重新指定 `model/cwd/sandboxPolicy/outputSchema`。 ([OpenAI Developers][1])

所以你的：

```ts
canSteer
```

可以可靠实现。

---

# 六、`thread/read`：比你的设计中更重要

你目前恢复流程写的是：

```text
App Server 重连
    ↓
thread/read / thread/resume
```

方向正确，但最好明确区分：

```text
query()
→ thread/read
```

和：

```text
resume()
→ thread/resume
```

因为：

```text
thread/read
```

不会把 Thread 加载进内存，不会订阅事件，也不会触发 `thread/started`。

它就是专门给“查询历史/恢复状态探测”用的。 ([OpenAI Developers][1])

因此 Extension Host 重启后最好：

```text
.sessions.json
      ↓
拿到 threadId
      ↓
thread/read
      ↓
┌ status = notLoaded
├ status = idle
├ status = active
└ thread 不存在
```

只有用户真正要继续：

```text
thread/resume
```

这样比直接 resume 所有历史执行干净得多。

---

# 七、第二个非常重要的问题：`thread/list` 默认会漏掉 App Server 会话

这是非常容易踩的坑。

你的设计：

> `thread/list`，按 `cwd` 和 `sourceKinds` 过滤

这个接口存在，而且确实支持：

```text
cwd
sourceKinds
modelProviders
archived
isPinned
searchTerm
...
```

但官方有一个很关键的默认行为：

如果：

```text
sourceKinds
```

未传或者：

```json
[]
```

默认只查询：

```text
cli
vscode
```

而支持的完整 SourceKind 包括：

```text
cli
vscode
exec
appServer
subAgent
subAgentReview
subAgentCompact
subAgentThreadSpawn
subAgentOther
unknown
```

([OpenAI Developers][1])

所以 InfiniteMap 的历史查询不能简单：

```json
{
  "cwd": "/InfiniteMap"
}
```

应该显式：

```json
{
  "cwd": "/InfiniteMap",
  "sourceKinds": [
    "appServer"
  ]
}
```

如果未来还要显示用户自己在 Codex VS Code 中开的线程：

```json
{
  "sourceKinds": [
    "appServer",
    "vscode"
  ]
}
```

否则就会出现一个很诡异的问题：

> InfiniteMap 创建成功了、threadId 也保存了、`thread/read(threadId)` 也能读，但是历史列表就是没有。

---

# 八、`thread/name/set` 存在，但必须调整调用时序

接口本身是真实且 stable：

```text
thread/name/set
```

并会产生：

```text
thread/name/updated
```

([OpenAI Developers][1])

但这里目前有一个非常现实的兼容性坑。

OpenAI Codex 官方仓库目前仍有一个 open issue，实测 Codex CLI `0.142.5`：

```text
thread/start
↓
thread/name/set
↓
失败
```

报：

```text
no rollout found for thread id ...
```

原因是部分版本直到第一次：

```text
turn/start
```

才把 rollout 持久化。

而：

```text
thread/name/set
```

需要 rollout 已经存在。 ([GitHub][2])

因此不要实现为：

```text
thread/start
↓
thread/name/set
↓
turn/start
```

建议：

```text
thread/start
↓
turn/start
↓
收到 turn/started 或首个持久化事件
↓
thread/name/set
```

而且：

```text
thread/name/set
```

必须视为：

```text
best effort
```

命名失败**绝不能让任务执行失败**。

这个建议我认为应该直接写进设计稿。

---

# 九、`thread/metadata/update` 存在，但它不是“任意 metadata API”

你的表：

> 更新 pin/git 元数据 → `thread/metadata/update`

是准确的。

官方目前明确支持：

```json
{
  "threadId": "thr_123",
  "isPinned": true,
  "gitInfo": {
    "branch": "..."
  }
}
```

([OpenAI Developers][1])

但不要把：

```ts
update(input: UpdateSessionInput)
```

设计成未来可以往 Codex Thread 塞：

```text
executionId
nodeId
kmFile
InfiniteMap metadata
```

目前公开契约不是“generic metadata bag”。

也就是说 InfiniteMap 自己的：

```text
executionId
nodeId
taskKind
```

仍然应该存在：

```text
.km.sessions.json
```

而不是尝试写进 Codex Thread metadata。

你当前旁车架构是正确的。

---

# 十、`thread/archive` 存在，但不要把它当 Session close

官方：

```text
thread/archive
```

是真的“归档”：

> 把 persisted JSONL 移入 archived sessions directory。

而且还会尝试递归 archive spawned descendants。 ([OpenAI Developers][1])

因此：

```text
任务执行完成
```

不应该自动：

```text
thread/archive
```

否则用户历史里会话会直接进入 archive。

正常结束应该只是：

```text
turn/completed
```

必要时：

```text
thread/unsubscribe
```

让 App Server 后续自行 unload。

官方明确提供：

```text
thread/unsubscribe
```

用于当前 connection 停止订阅 thread，之后在没有 subscriber 和 activity 时卸载 thread。 ([OpenAI Developers][1])

所以建议 Adapter 再加：

```ts
unsubscribe(...)
```

或者内部生命周期方法：

```ts
releaseSession(...)
```

而：

```ts
archive()
```

只对应用户主动的“归档会话”。

---

# 十一、你的 Adapter 现在还缺一个很重要的接口族：Server Request

目前：

```ts
onDidEvent(...)
```

只考虑了：

```text
Server → Notification
```

但 App Server 不只是 notification。

它还会：

```text
Server → JSON-RPC Request → InfiniteMap
```

例如：

```text
item/commandExecution/requestApproval
item/fileChange/requestApproval
item/permissions/requestApproval
mcpServer/elicitation/request
```

客户端必须返回响应。

官方明确说明，如果命令或文件修改需要 approval，App Server 会向 client 发送 JSON-RPC request，等待客户端回答后才继续执行。 ([OpenAI Developers][1])

如果 InfiniteMap Client 完全不实现这条链路，某些配置下会发生：

```text
Codex 一直 running
没有 turn/completed
InfiniteMap 以为 Agent 卡死
```

实际上是在：

```text
等待 Extension Host 回 approval
```

因此你的：

```ts
CodexAppServerClient
```

至少应该具备：

```ts
onServerRequest(...)
```

然后映射成：

```text
AgentTaskEvent
    ↓
Webview approval UI
    ↓
Extension Host
    ↓
JSON-RPC response
```

即使第一版默认：

```text
approvalPolicy = never
```

我仍建议把 Request Router 做出来，因为 managed policy、network permission、MCP/connector 等场景以后都会使用它。

---

# 十二、Capability Probe 还应该增加 `account/read`

你的 Phase 0 有：

> 缺 Provider、未登录给出正确状态

这件事现在不应该通过：

```text
读 ~/.codex/auth.json
```

你的设计已经正确禁止这么做。

App Server 本身就有正式接口：

```text
account/read
```

可以返回：

```text
account
requiresOpenaiAuth
planType
...
```

而且支持 API Key、ChatGPT 登录等不同 authentication mode。 ([OpenAI Developers][1])

所以 Codex capability probe 推荐：

```text
spawn app-server
     ↓
initialize
     ↓
initialized
     ↓
account/read
     ↓
model/list
```

`model/list` 也是真实 stable API，可以拿到：

```text
model
supportedReasoningEfforts
inputModalities
supportsPersonality
isDefault
```

([OpenAI Developers][1])

因此：

```ts
detectCapabilities()
```

不应该只是：

```text
command -v codex
```

最好是：

```text
codex executable exists
+
initialize success
+
account/read
+
model/list
```

这样才是真正的 Provider Ready。

---

# 十三、“打开 Codex 原生会话”仍然不能当稳定能力

这也是你设计中处理得比较谨慎的一点：

> 若没有公开的按 threadId 跳转能力，则 InfiniteMap 自己展示线程详情。

建议继续坚持。

App Server 的公开稳定契约里有：

```text
start
resume
read
list
rename
archive
...
```

但没有类似：

```text
thread/openInDesktop
```

的正式 RPC。

而且 OpenAI 官方仓库目前还有实际问题：由外部 `codex app-server` 进程创建的 Thread，即使与 Codex Desktop 共用 `CODEX_HOME`，Desktop 在运行期间可能发现它，却无法正常打开，重启 Desktop 后才正常。这说明：

```text
App Server thread
≠
Codex Desktop 当前 UI 会话对象
```

至少不能依赖二者实时同步。 ([GitHub][3])

所以建议保持：

```ts
canOpenNative = false
```

作为默认。

InfiniteMap 自己：

```text
thread/read
↓
展示历史/状态
```

才是可靠路径。

未来如果 Codex 提供正式 deep-link / attach-to-desktop API，再动态开启：

```ts
canOpenNative = true
```

---

# 十四、建议把 Codex Adapter 最终定义成这样

你当前统一接口：

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

对于 Codex，我建议实际内部映射调整为：

```text
detectCapabilities
 ├─ initialize / initialized
 ├─ account/read
 └─ model/list

createSession
 └─ thread/start

query
 └─ thread/read

list
 └─ thread/list
      sourceKinds=["appServer"]

resume
 └─ thread/resume

submit
 └─ turn/start + outputSchema

steer
 └─ turn/steer + expectedTurnId

cancel
 └─ turn/interrupt

rename
 └─ thread/name/set
      ※ first turn 后
      ※ best effort

updateMetadata
 └─ thread/metadata/update
      ※ isPinned / gitInfo only

release
 └─ thread/unsubscribe

archive
 └─ thread/archive
      ※ 用户主动操作

events
 ├─ thread/status/changed
 ├─ turn/started
 ├─ turn/completed
 ├─ item/started
 ├─ item/completed
 ├─ item/agentMessage/delta
 ├─ item/commandExecution/outputDelta
 └─ turn/diff/updated

serverRequests
 ├─ item/commandExecution/requestApproval
 ├─ item/fileChange/requestApproval
 ├─ item/permissions/requestApproval
 └─ mcpServer/elicitation/request
```

---

# 十五、实际最小可运行链路

所以 InfiniteMap 真正实施时，第一版甚至只需要下面这一条闭环：

```text
Extension Host
      │
      ├─ spawn("codex", ["app-server"])
      │
      ▼
 initialize
      │
 initialized
      │
      ├─ account/read
      │
      ▼
 thread/start
      │
      │ ← thread.id
      │ ← thread.sessionId
      ▼
 turn/start
   + input
   + outputSchema
      │
      ├──── item/started
      ├──── item/.../delta
      ├──── item/completed
      │
      ▼
 turn/completed
      │
      ▼
 thread/read
      │
      ▼
 AgentExecutionReceipt
      │
      ▼
 InfiniteMap 审核
      │
      ▼
 KM dry-run / commit
```

这一整条链路全部建立在**当前官方 App Server API**上，不依赖逆向 Codex VS Code 扩展、不读内部 SQLite、不读 auth 文件，也不依赖 Desktop 私有 IPC。官方还明确提供按当前 Codex 版本生成 TypeScript / JSON Schema 的能力，所以协议绑定可以跟随本机安装版本生成，而不是手工维护一套猜测类型。 ([GitHub][4])

## 最终判断

因此我会把这份设计的 Codex 部分评价为：

**可实施性：高，可以进入实现阶段。**

不是需要推翻方案，而是实施前建议完成这些修正：把唯一会话键固定为 `thread.id`、把 `thread.sessionId` 降为 session tree ID；`thread/list` 显式加入 `appServer` source；`thread/name/set` 移到首个 Turn 后并做 best-effort；增加 `account/read`、`model/list` capability probe；增加 App Server server-request/approval 处理；普通任务完成使用 unsubscribe/保留线程，而不是 archive；继续把“按 threadId 打开 Codex Desktop/IDE 原生会话”视为**非稳定能力**。

做完这几项后，**Codex App Server 这一侧已经不存在“核心接口是假想出来、实现时才发现官方没有”的架构风险**。真正剩下的工程风险主要变成了 Codex CLI 版本兼容、App Server 子进程生命周期、approval request 状态机以及外部 Desktop/IDE UI 的互操作性。 ([OpenAI Developers][1])

[1]: https://developers.openai.com/codex/app-server
[2]: https://github.com/openai/codex/issues/31158
[3]: https://github.com/openai/codex/issues/30916
[4]: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
