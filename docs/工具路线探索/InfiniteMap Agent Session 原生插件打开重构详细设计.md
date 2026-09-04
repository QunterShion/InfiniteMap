# InfiniteMap Agent Session 原生插件打开重构详细设计

> 文档状态：可实施设计（Implementation Ready）
> 适用工程：`Workspace/openSource/InfiniteMap`
> 设计对象：会话历史/活动列表点击后，拉起 VS Code 中对应智能体应用并定位到同一会话
> 证据基线：仓库当前源码、测试、现有审计文档，以及本机已安装的 Codex/Claude VS Code 扩展包；外部官方网页在本次核验环境不可访问，因此凡涉及私有扩展协议均必须在 CI/人工回归中再次验证。

## 1. 结论摘要

当前 InfiniteMap 的会话历史和活动列表点击后，会在 Webview 内打开居中的 `agent-session-detail` 弹窗。该弹窗通过 `querySessionDetail` 回查 Provider transcript，由 InfiniteMap 自己承担结果摘要、工具调用、命令输出、diff 和时间线查看器职责。它不是 Provider 原生会话打开能力。

本次重构的目标链路是：

```text
节点卡片 / 活动列表 / 历史列表
        ↓
Webview openSession(executionId, nodeId)
        ↓
Extension Host 读取唯一历史记录
        ↓
NativeOpenResolver 做 Provider 能力和版本探测
        ↓
Provider Adapter 按 canonical sessionId/threadId 打开对应 VS Code 应用
        ↓
返回打开结果；必要时按策略回退到 CLI 或 InfiniteMap 详情
```

必须坚持以下边界：

1. `executionId` 只用于 InfiniteMap 追踪和历史记录定位；Provider 原生 `sessionId`/`threadId` 才是打开目标的 canonical identity。
2. 现有 `openUri` 是 InfiniteMap 自有深链，继续保留，不改成 Provider 私有 URI。
3. 原生 URI、命令和 custom editor 视图信息放入新增的可选 `nativeOpen` 字段，不污染或绕过 `openUri` 校验。
4. 历史打开必须传递选中的历史 `AgentSessionRef`，不能再调用只依赖当前活动会话的 `orchestrator.open(documentKey, target)`。
5. Copilot 原生 UI 打开目前没有被证实为稳定公共能力；Codex 原生打开依赖本机 Codex 扩展的私有 URI/custom editor 契约；Claude 原生打开依赖本机扩展命令/URI 契约。三者都必须能力探测和失败回退。
6. ownership/handoff 是目标架构，不是当前实现事实。没有完成租约和写入仲裁前，不得宣称 InfiniteMap 与原生客户端可以安全并行写同一 Session。

## 2. 范围、非目标和成功标准

### 2.1 本次范围

- 历史抽屉、活动抽屉、节点卡片中的会话入口改为“打开对应 Provider 应用会话”。
- Host 端按 `executionId` 精确读取历史记录，并把 Provider session identity 交给原生打开适配器。
- 新增 Provider 原生打开能力探测、结果 DTO、错误码、fallback 策略和审计日志。
- 兼容现有 `.sessions.json`、KM 节点 `latestSession` 和 InfiniteMap 深链。
- 为 Codex、Claude、Copilot 分别定义可落地的首期能力边界。

### 2.2 非目标

- 不导入用户在 Provider 应用中创建的全部历史会话。
- 不读取 VS Code/Copilot/Codex/Claude 私有 SQLite 或 storage 文件作为正式数据源。
- 不实现 Codex Desktop deep link、桌面客户端 handoff。
- 不在本次改造中改变 KM 任务标签、claim、lease 或协同节点业务规则。
- 不承诺第三方 Provider 的私有协议永久兼容；私有协议必须有版本门控和回退。

### 2.3 成功标准

1. 点击任意历史记录时，打开目标始终由该记录的 `sessionId`/`threadId` 决定，不受当前活动会话影响。
2. 原生 Provider 能力可用时，VS Code 显示对应 Provider 应用并定位到目标会话。
3. Provider 未安装、版本不匹配、Session 不存在或原生打开失败时，用户得到可理解的反馈，并按策略进入 CLI 或 InfiniteMap 详情回退。
4. 原有 `openUri`、历史数据校验、KM MCP 写入和恢复流程不被破坏。
5. 类型检查、Lint、现有测试和新增打开链路测试全部通过；手工回归覆盖至少三种 Provider、历史/活动两个入口和原生不可用场景。

## 3. 现状审计

### 3.1 现有交互链路

| 层               | 入口/文件                                                                                 | 当前行为                                                                            | 改造判断                                                           |
| ---------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 节点卡片         | `webui/ui/directive/nodeCard/nodeCard.directive.js:161-168`                             | 点击最新会话或历史，派发`agent-session-history-open`，携带 `nodeId/executionId` | 保留入口，历史项改为原生打开                                       |
| 活动列表         | `webui/ui/directive/agentActivityOverview/agentActivityOverview.directive.js:136-139`   | 点击活动项派发`agent-session-detail-open`                                         | 改派发`agent-session-native-open` 或调用统一打开控制器           |
| 历史列表         | `webui/ui/directive/agentSessionHistory/agentSessionHistory.directive.js:106-109`       | 点击条目只派发`agent-session-detail-open`                                         | 改为调用`openSession`，不得直接渲染详情                          |
| 历史模板         | `webui/ui/directive/agentSessionHistory/agentSessionHistory.html:15-45`                 | 展示 Provider、状态、配置、摘要、产物并提供复制 ID                                  | 保留列表和复制 ID；增加原生打开状态/回退操作                       |
| 居中详情         | `webui/ui/directive/agentSessionDetail/agentSessionDetail.directive.js:184-231`         | 合并 live/历史快照，调用`querySessionDetail`，组装 transcript                     | 从主路径移除；短期保留为 fallback                                  |
| 详情模板         | `webui/ui/directive/agentSessionDetail/agentSessionDetail.html:1-159`                   | `role=dialog`，展示 outcome、reasoning、命令、工具、diff、时间线                  | 进入兼容/诊断边界；稳定原生打开后可删除                            |
| Webview Service  | `webui/ui/service/agentSession.service.js:313-342`                                      | 同时暴露`querySessionDetail` 和 `openSession`                                   | `openSession` 改为唯一主操作；详情 API 保留过渡期                |
| Host 协议        | `src/sessions/protocol.ts:9-49`                                                         | 已有`querySessionDetail`、`openSession`，请求仅带 node/execution/target         | 扩展 mode/fallbackPolicy/result DTO                                |
| Host Coordinator | `src/sessions/agentControlBarCoordinator.ts:312-390`                                    | 详情能按 executionId 找记录；`openSession` 只查节点历史，随后打开活动会话         | 必须将匹配记录传入 Orchestrator/Adapter                            |
| Orchestrator     | `src/sessions/sessionOrchestrator.ts:346-386`                                           | `readSessionDetail` 可查询指定记录；`open` 依赖 `requireSession(documentKey)` | 新增`openHistoricalSession(input)`，保留 `open` 仅服务活动会话 |
| Provider Adapter | Copilot`:262-264` 空实现；Codex `:429-431` 明确不支持；Claude `:243-253` 仅支持 CLI | 分 Provider 实现 native resolver 和 fallback                                        |                                                                    |
| KM 持久化        | `src/mcp/services/kmSessionState.ts:436-486`                                            | 强制`session.openUri` 为 InfiniteMap `/session/open` 深链                       | 保持约束，新增可选 native 元数据                                   |
| InfiniteMap 深链 | `src/deepLinks/sessionUriHandler.ts:11-79`                                              | 校验 map/node/execution 后打开`.km` 并恢复历史上下文                              | 保留为追踪/回跳/fallback，不承担 Provider 打开                     |

### 3.2 当前 `openSession` 的实质缺陷

`agentControlBarCoordinator.ts:378-389` 虽然接收 `request.executionId`，但只用 `nodeId` 查询历史；当 target 不是 `infinite-map` 时调用 `this.orchestrator.open(documentKey, request.target)`。`sessionOrchestrator.open()` 再通过 `requireSession(documentKey)` 取得当前活动会话。因此：

- 点击旧历史记录可能打开当前活动 Session；
- 传入的 `executionId` 没有参与 Provider 打开；
- Adapter 没有收到用户点选记录的 `sessionId/threadId`；
- 结果中的 `executionId` 只是原样返回，不能证明已打开目标 Session。

这是本次必须修复的 P0 行为问题。

### 3.3 当前数据和身份边界

`AgentSessionRef`（`src/sessions/types.ts:114-123`）和 KM `SessionReference`（`src/mcp/services/kmSessionState.ts:21-30`）当前包含：

- `provider`
- `sessionId`
- 可选 `threadId`、`turnId`
- `surface`
- 可选模型/推理强度
- `openUri`

其中 `openUri` 由 `sessionOrchestrator.buildOpenUri()` 生成（`src/sessions/sessionOrchestrator.ts:582-592`），必须是 `vscode://chanterxiao.infinite-map/session/open`。`kmSessionState.validateOpenUri()`（`:461-486`）会拒绝其他 scheme、host、路径或未知 query 参数。因此不能把 `openai-codex://...` 直接写入 `openUri`。

### 3.4 当前运行时事实与设计稿差异

现有设计稿 `docs/InfiniteMap Agent Session 集成方案设计.md` 的方向有价值，但以下内容在当前仓库中尚未实现或缺少证据：

| 设计假设                                                   | 现状/证据                                                                                                                          | 处理结论                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Copilot SDK Session 可被 VS Code Copilot 直接发现并打开    | 本机扩展存在 proposed`chatSessionsProvider`，但没有证据证明它与 InfiniteMap 使用的 SDK `baseDirectory`/Session store 相同      | 首期标记`experimental/unsupported`，不得承诺原生打开；优先保留 InfiniteMap 详情或 CLI fallback |
| Codex 可通过`openai-codex://route/local/<threadId>` 打开 | 本机`openai.chat` 扩展 manifest 声明 `chatgpt.conversationEditor` 和 `openai-codex`，bundle 解析 `/local/<conversationId>` | 可实现兼容适配器，但属于私有扩展契约，必须版本 allowlist、探测和回归                             |
| Claude 有稳定的按 Session ID 打开 VS Code 面板 API         | 本机 2.1.239 bundle 有`claude-vscode.primaryEditor.open` 命令和 `/open?session=` handler，未证明为公开稳定 API                 | 以版本探测的 experimental native 命令为主，`claude --resume` 为稳定 fallback                   |
| 所有权转移已具备                                           | 当前`SessionReference` 没有 owner/lease/handoff 字段，代码无双写仲裁                                                             | 作为后续 Phase，首期只读打开，禁止隐式接管                                                       |
| 每个新 Codex Session 一个独立 App Server                   | 当前 Registry 为共享组件运行时：`src/providers/providerComponentRegistry.ts:79-115,224-249` 创建一个 `CodexRuntimeManager`     | 需作架构决策；见第 11 节，不得把设计稿描述当作当前实现                                           |

## 4. 目标架构

### 4.1 模块分层

```text
Webview Page/Directive
  └─ agentSession.service.js
       └─ AgentSessionRequest(openSession)
            ↓
Extension Host Adapter (agentControlBarCoordinator)
  ├─ resolveHistoricalSession(executionId, nodeId)
  ├─ NativeOpenResolver
  └─ SessionOpenResult → Webview
            ↓
SessionOrchestrator.openHistoricalSession()
  └─ ProviderComponentRegistry.load(provider)
       └─ AgentSessionAdapter.open({ session, target, nativeOpen })
            ├─ CodexNativeOpenAdapter
            ├─ ClaudeNativeOpenAdapter
            ├─ CopilotNativeOpenAdapter (experimental)
            └─ Cli/InfiniteMap fallback
```

职责边界：

- Webview 只负责展示列表、发起打开请求和展示结果，不解析 Provider URI，不读取本地文件。
- Coordinator 负责协议适配、可信文档校验、历史记录精确匹配和结果回传，不包含 Provider 私有协议。
- Orchestrator 负责 Provider 选择、能力门控、活动/历史 Session 区分和统一错误编码。
- NativeOpenResolver 负责 VS Code 扩展存在性、版本、命令、custom editor 和 URI 合法性探测。
- Provider Adapter 负责把 canonical identity 映射到 Provider 应用的打开方式。
- MCP/KM 服务只负责 execution 与节点历史的持久化，不负责拉起外部 UI。

### 4.2 历史打开时序

```text
用户点击历史记录
  ↓
Webview request(openSession, nodeId, executionId, mode=native)
  ↓
Coordinator 校验 document/trusted workspace
  ↓
按 nodeId 分页查询 km_list_node_sessions
  ↓
精确匹配 executionId；不存在则 SESSION_NOT_FOUND
  ↓
检查记录 session.provider/sessionId/threadId
  ↓
NativeOpenResolver 探测 Provider 扩展和契约
  ├─ 可用：Adapter.open(记录中的 AgentSessionRef)
  ├─ 不可用且 fallback=cli：Adapter.open(provider-cli)
  ├─ 不可用且 fallback=infinite-map：返回 deep link/打开详情
  └─ 失败：返回结构化错误和可选 fallback
  ↓
Webview 关闭/隐藏详情层，显示非阻塞结果提示
```

### 4.3 活动 Session 与历史 Session 分离

新增两个明确的 Orchestrator API：

```ts
openActiveSession(documentKey: string, target?: OpenTarget): Promise<SessionOpenResult>

openHistoricalSession(input: {
  executionId: string;
  session: AgentSessionRef;
  target?: OpenTarget;
  fallbackPolicy?: OpenFallbackPolicy;
}): Promise<SessionOpenResult>
```

旧 `open(documentKey, target)` 在过渡期保留并标记 deprecated，仅允许控制条打开当前活动会话；历史入口禁止调用它。

## 5. 数据模型和协议设计

### 5.1 原生打开描述

在 `AgentSessionRef` 和 KM `SessionReference` 中新增可选字段，采用向后兼容的 additive 方式：

```ts
export type OpenTarget =
  | 'infinite-map'
  | 'provider-cli'
  | 'provider-tui'
  | 'provider-ide';

export interface NativeOpenDescriptor {
  target: 'provider-ide' | 'provider-cli' | 'provider-tui';
  contract: 'codex-vscode-private-uri-v1'
    | 'claude-vscode-command-v1'
    | 'claude-vscode-uri-v1'
    | 'copilot-chat-sessions-proposed-v1';
  uri?: string;
  command?: string;
  viewType?: string;
  minExtensionVersion?: string;
  detectedExtensionVersion?: string;
  verifiedAt?: string;
}

export interface AgentSessionRef {
  // existing fields unchanged
  openUri: string;                 // InfiniteMap trace/backlink only
  nativeOpen?: NativeOpenDescriptor;
}
```

设计规则：

- `nativeOpen` 是缓存提示，不是安全边界；每次真正打开仍需重新探测扩展和 allowlist。
- 不在 URI 中携带 prompt、transcript、token、绝对路径或工作区机密。
- `uri` 中只允许 Provider 已验证的 canonical ID；所有 ID 必须 `encodeURIComponent`。
- 若 `nativeOpen` 缺失，可根据 `provider + sessionId/threadId` 进行只读派生，但成功后再按迁移策略决定是否回写。

### 5.2 打开请求

扩展 `AgentSessionRequest` 增加：

```ts
operation: 'openSession';
nodeId?: string;
executionId: string;
target?: OpenTarget;
mode?: 'native' | 'fallback-only';
fallbackPolicy?: 'none' | 'infinite-map-detail' | 'provider-cli' | 'prompt';
```

默认值：`mode=native`、`target=provider-ide`、`fallbackPolicy=prompt`。历史列表不允许省略 `executionId`；只带 `nodeId` 的请求直接返回参数错误。

### 5.3 打开结果

```ts
export interface SessionOpenResult {
  opened: boolean;
  executionId: string;
  provider: string;
  sessionId: string;
  target: OpenTarget;
  method: 'provider-command' | 'provider-uri' | 'provider-cli' | 'infinite-map' | 'detail-fallback';
  capability: 'native' | 'experimental' | 'emulated' | 'unsupported';
  extensionId?: string;
  extensionVersion?: string;
  fallbackAvailable: boolean;
  warning?: string;
}
```

Webview 不根据 `opened=true` 猜测窗口是否真的定位成功；Host 只能确认命令/URI 调用未抛错。需要在日志中记录 `attempted`、`accepted`、`verified` 三个阶段，后续可扩展 Provider 回执。

### 5.4 错误码

在 `AgentSessionErrorCode` 增加：

| 错误码                         | 含义                                   | 可重试 | UI 建议                 |
| ------------------------------ | -------------------------------------- | -----: | ----------------------- |
| `SESSION_NOT_FOUND`          | executionId 不在指定节点/文件历史中    |     否 | 刷新历史                |
| `SESSION_ID_MISSING`         | 历史记录缺少 Provider canonical ID     |     否 | 打开 InfiniteMap 详情   |
| `NATIVE_CLIENT_MISSING`      | Provider VS Code 扩展未安装/未激活     |     否 | 安装或选择 fallback     |
| `NATIVE_CLIENT_INCOMPATIBLE` | 版本不在支持范围                       |     否 | 提示升级，保留 fallback |
| `NATIVE_SESSION_NOT_FOUND`   | Provider 应用无法找到该 session/thread |     否 | 检查共享存储/选择详情   |
| `NATIVE_OPEN_UNSUPPORTED`    | Provider 没有可用原生打开契约          |     否 | 使用 CLI/详情           |
| `NATIVE_OPEN_FAILED`         | 命令或 URI 执行失败                    |     是 | 重试或 fallback         |
| `SESSION_OWNERSHIP_CONFLICT` | 目标 Session 被其他 owner 写入         |     否 | 只读查看或等待释放      |

## 6. Provider 落地方案

### 6.1 Codex

#### 已验证能力

本机 `openai.chatgpt-26.5825.51511-darwin-arm64` manifest 声明：

- custom editor viewType：`chatgpt.conversationEditor`
- selector filename pattern：`openai-codex:/**/*`
- URI scheme：`openai-codex`
- URI authority：`route`

扩展 bundle 中的解析逻辑接受 `/local/<conversationId>` 和 `/remote/<conversationId>`，并把 local conversation ID 作为目标会话 ID。当前实现可采用：

```ts
const uri = vscode.Uri.from({
  scheme: 'openai-codex',
  authority: 'route',
  path: `/local/${encodeURIComponent(session.threadId || session.sessionId)}`,
});
await vscode.commands.executeCommand(
  'vscode.openWith',
  uri,
  'chatgpt.conversationEditor',
);
```

#### 前置条件

- `openai.chat` 扩展存在且版本在 allowlist；
- `session.threadId || session.sessionId` 与 Codex App Server thread ID 一致；
- Codex Server 和 VS Code Codex 使用同一可发现的 Session 存储/账号上下文；
- `vscode.openWith` 调用未抛错。

#### 风险和 fallback

这是私有兼容协议，不是已核实的稳定第三方 API。版本变化可能导致 scheme、authority、路径或 viewType 变化。失败时按顺序：

1. 若用户选择 `provider-cli`，调用现有 Codex CLI/Server 兼容入口（需单独确认 CLI 是否支持按 thread 恢复）；
2. 打开 InfiniteMap `openUri` 上下文；
3. 在历史列表显示 `NATIVE_OPEN_FAILED` 及扩展版本。

Codex Adapter 的 `open()` 当前明确抛出不支持（`src/providers/codex/CodexAgentSessionAdapter.ts:429-431`），应改为接收指定 `AgentSessionRef`，禁止从运行时 map 推断活动线程。

### 6.2 Claude

#### 已验证能力

本机 `anthropic.claude-code-2.1.239` bundle 注册：

- `claude-vscode.primaryEditor.open`：接受 session/prompt 参数并创建 Primary Editor；
- URI handler `/open?session=<id>`：转发到上述命令；
- 现有仓库 Adapter 已支持 `claude --resume <sessionId>`（`src/providers/claude/ClaudeAgentSessionAdapter.ts:243-253`）。

#### 实施顺序

1. 首选检测扩展 ID `anthropic.claude-code`、命令 `claude-vscode.primaryEditor.open` 和版本 allowlist。
2. 调用命令时只传 canonical `sessionId`，不传入用户 prompt，避免误启动新任务。
3. 命令不存在或调用失败时，使用现有 `provider-cli` 路径 `claude --resume <sessionId>`。
4. 如未来确认公开 URI scheme，再新增 URI 契约；在此之前不硬编码未知 scheme。

Claude 原生命令和 URI handler 同样应标记为 experimental；稳定承诺只对 CLI fallback 做出。`openTargets` 在能力探测成功后才包含 `provider-ide`，否则保留 `provider-cli`。

### 6.3 Copilot

#### 当前可行性结论

InfiniteMap 使用 `@github/copilot-sdk`，运行时通过 `CopilotRuntimeManager` 设置 `baseDirectory` 为扩展自己的 `globalStorage/copilot-state`（`src/providers/copilot/CopilotRuntimeManager.ts:60-69`）。这与 VS Code Copilot 内置应用的会话目录不等价。

本机 Copilot 扩展存在 proposed `chatSessionsProvider` 声明，但当前没有证据证明：

- 第三方扩展可以稳定调用其 provider；
- SDK session 能被 Copilot 原生 UI 发现；
- SDK 的 session ID 能映射到 Copilot UI 的 conversation ID。

因此首期能力为：

- `provider-ide`：`unsupported` 或显式 `experimental`，不展示为无条件可用；
- `infinite-map-detail`：保留当前详情查看器作为默认 fallback；
- 未来若获得公开 Bridge/Proposed API 且完成跨目录验证，再实现 `copilot-chat-sessions-proposed-v1`。

不得通过复制/改写 Copilot 私有 storage、SQLite 或未声明文件格式伪造“原生可见”。

### 6.4 Provider 能力矩阵（首期）

| Provider | 原生 IDE 打开 | 首选机制                                        | 稳定性                   | fallback                 |
| -------- | ------------- | ----------------------------------------------- | ------------------------ | ------------------------ |
| Codex    | 条件支持      | 私有 URI +`chatgpt.conversationEditor`        | experimental             | CLI/InfiniteMap 详情     |
| Claude   | 条件支持      | `claude-vscode.primaryEditor.open(sessionId)` | experimental             | `claude --resume`/详情 |
| Copilot  | 不承诺        | proposed Chat Sessions（待验证）                | unsupported/experimental | InfiniteMap 详情         |

## 7. NativeOpenResolver 设计

### 7.1 探测输入和缓存

```ts
interface NativeOpenProbeInput {
  provider: string;
  session: AgentSessionRef;
  requestedTarget: OpenTarget;
}

interface NativeOpenCapability {
  available: boolean;
  level: 'native' | 'experimental' | 'unsupported';
  extensionId?: string;
  extensionVersion?: string;
  contract?: NativeOpenDescriptor['contract'];
  reason?: string;
  expiresAt?: string;
}
```

探测顺序：

1. `vscode.extensions.getExtension(extensionId)` 判断安装；
2. 检查扩展版本是否满足 allowlist；
3. 对命令契约检查 `vscode.commands.getCommands(true)`；
4. 对 custom editor 契约检查已知 `viewType` 和 URI scheme；
5. 校验 session identity 非空、长度和字符范围；
6. 缓存结果 5 分钟或直到 `extensions.onDidChange`，命令执行失败立即失效。

### 7.2 不做破坏性探测

探测阶段不自动打开窗口、不创建新 Session、不恢复 turn、不修改 Provider storage。真正打开只在用户点击后发生。命令/URI 调用失败必须捕获并返回结构化错误。

### 7.3 安全校验

- 只允许固定 Provider 扩展 ID、固定 URI scheme/authority、固定 custom editor viewType。
- 禁止把 `openUri` 当成 native URI 直接透传。
- 所有历史记录必须先由 `km_list_node_sessions` 校验 execution 与 node 的绑定关系。
- 工作区必须 trusted；文件路径沿用 `SessionUriHandler` 的相对路径和 `.km` 校验。
- 日志记录 provider、executionId、sessionId 哈希、扩展版本和结果，不记录 token、prompt 或完整 transcript。

## 8. Webview 交互改造

### 8.1 主交互

历史/活动条目点击后不再直接打开居中详情；改为：

1. 立即将条目标记为 `opening`，防止重复点击。
2. 调用 `agentSessionService.openSession(nodeId, executionId, 'provider-ide')`。
3. Host 返回成功后关闭历史/活动抽屉的详情层（若存在），显示短暂状态提示。
4. 返回 fallback 时显示一次可操作提示：`在 InfiniteMap 查看`、`在 CLI 恢复`、`重试`。
5. 返回错误时保留列表位置和焦点，不丢失用户上下文。

### 8.2 详情弹窗的过渡策略

采用“两阶段清理”：

- Phase A：详情弹窗从主入口移除，但保留 `agentSessionDetail` 作为 fallback 和诊断入口；`querySessionDetail` 不删除。
- Phase B：当 Codex/Claude 原生打开回归稳定、Copilot fallback 体验完成、使用率和错误率满足验收阈值后，再删除详情模板、指令和 `querySessionDetail` 协议。

这样可避免 Provider 私有协议短期不稳定时完全失去历史可读性。

### 8.3 UI 状态模型

```text
idle → opening → opened
              ├→ fallback_available
              ├→ failed_retryable
              └→ failed_terminal
```

同一 `executionId` 在 `opening` 状态下不得并发发送请求。按钮文案和状态不得承诺“已打开并定位”，只能显示 Host 已接受或 fallback 原因。

## 9. 工程清理方案

### 9.1 保留

- `agentSessionHistory`：历史列表、分页、复制 executionId、空/错误状态。
- `agentActivityOverview`：活动会话列表和状态刷新。
- `nodeCard` 的历史入口和 session metadata 展示。
- `agentSession.service.js` 的统一 request、历史查询、事件缓存。
- `querySessionDetail`、`agentSessionDetail`（过渡期 fallback）。
- `SessionUriHandler` 和 `openUri` 严格校验。
- KM sidecar 的 execution、nodeIndex、latestSession 和恢复逻辑。

### 9.2 修改

| 文件/模块                                                                       | 修改内容                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `webui/ui/directive/agentSessionHistory/agentSessionHistory.directive.js`     | 条目点击统一调用 openSession；维护 opening/error/fallback 状态                |
| `webui/ui/directive/agentActivityOverview/agentActivityOverview.directive.js` | 活动项也传递 nodeId/executionId/session，复用统一打开事件                     |
| `webui/ui/service/agentSession.service.js`                                    | 扩展 openSession 参数和返回结果；保留 detail API 过渡                         |
| `src/sessions/protocol.ts`                                                    | 增加 mode、fallbackPolicy 和结果类型                                          |
| `src/sessions/types.ts`                                                       | 增加`NativeOpenDescriptor`、`SessionOpenResult`；扩展 `AgentSessionRef` |
| `src/sessions/agentControlBarCoordinator.ts`                                  | 精确读取历史记录；调用`openHistoricalSession`；错误编码和审计日志           |
| `src/sessions/sessionOrchestrator.ts`                                         | 新增历史打开 API，活动打开 API 与历史打开 API 解耦                            |
| `src/providers/providerComponentRegistry.ts`                                  | 注入 NativeOpenResolver 或 Provider native adapter 工厂                       |
| `src/providers/*/*AgentSessionAdapter.ts`                                     | 接收具体历史 Session；实现各 Provider 原生/CLI/fallback                       |
| `src/mcp/services/kmSessionState.ts`                                          | additive 读取/写入 nativeOpen，保留 openUri 校验；增加 v1→v2 迁移            |
| `src/mcp/tools/kmRecordSession.ts`                                            | 扩展 session schema 的可选 nativeOpen 字段                                    |
| `webui/ui/templates.js`                                                       | Webview 构建时同步新的 history/activity 模板                                  |
| `tests/*.test.cjs`                                                            | 增加协议、历史精确匹配、能力探测、迁移和 fallback 测试                        |

### 9.3 删除或延期

- 不再使用的 `agent-session-detail-open` 主入口事件：Phase A 标记 deprecated；Phase B 删除。
- 详情专用的居中层样式和 modal focus 管理：Phase B 删除，不能在 Phase A 与原生打开逻辑重复触发。
- Provider Adapter 中“只打开活动会话”的旧 `open(documentKey)` 路径：新增 API 稳定后删除或限制为内部活动会话。
- 任何试图扫描 Provider 私有 storage 以实现 discovery 的代码：不引入；若已有实验代码，迁移到 feature flag 后删除。

### 9.4 清理验收

- `rg` 不应再发现历史入口直接调用 `querySessionDetail`；只有 fallback action 可以调用。
- `openSession` 的实现必须同时出现 `executionId` 精确匹配和 `record.session` 传递。
- UI 不应出现“打开详情”作为默认主按钮；详情仅作为 fallback/诊断动作。
- `openUri` 校验测试必须继续覆盖非法 scheme、host、path、query 和路径穿越。

## 10. 历史数据迁移和兼容策略

### 10.1 版本策略

建议将 sidecar schema 从 1 升级为 2，但读取端兼容 v1：

```text
读取：schemaVersion 1 → normalizeV1ToV2 → 内存 v2
读取：schemaVersion 2 → normalizeV2
写入：统一写 v2
```

v2 只新增可选 `session.nativeOpen`，不改变 executionId、sessionId、nodeIndex、openUri 的语义。若团队不希望立即改版本，也可以先以 v1 additive 字段落地；但必须记录迁移版本，避免未来无法区分字段来源。推荐 v2，便于审计和回滚。

### 10.2 旧记录处理

| 旧数据情况                       | 处理方式                                                                  |             是否回写 |
| -------------------------------- | ------------------------------------------------------------------------- | -------------------: |
| 有合法`openUri`，无 nativeOpen | 根据 provider 和 ID 只读派生 capability；成功打开后异步补写               |     默认是，失败不写 |
| `openUri` 非法                 | 沿用现有 sidecar 重建/校验错误处理；禁止用 native URI 覆盖                |                   否 |
| 缺少 sessionId/threadId          | 返回`SESSION_ID_MISSING`，仍可打开 InfiniteMap 详情                     |                   否 |
| Provider Session 已不存在        | 保留历史摘要/产物；返回`NATIVE_SESSION_NOT_FOUND`                       | 可写 lastProbe/error |
| 节点已删除、sidecar orphan       | 允许打开 Provider（若 identity 完整），UI 显示 orphan；不自动重新绑定节点 |                   否 |
| 只有 live 内存快照、尚未落盘     | 先完成现有`km_record_session` 队列；若仍无 record，禁止 native open     |                   否 |

### 10.3 回滚

- 保留 v1 读取和旧 `agent-session-detail-open` 事件开关 `infiniteMap.agentSession.nativeOpenEnabled`。
- 关闭 feature flag 只改变 UI 主动作和 resolver 调用，不删除数据字段。
- 迁移失败时 quarantine sidecar 的现有机制继续生效，使用 KM 节点 `latestSession` 重建可恢复记录。

## 11. Ownership、handoff 与运行时架构决策

### 11.1 首期只读打开原则

“打开应用”不等于“接管会话”。Phase A/B 只允许：

- InfiniteMap 继续读取历史；
- 原生客户端打开并由用户决定是否继续；
- InfiniteMap 不因打开动作自动 resume、send、steer 或释放其他 owner。

在没有 owner/lease 之前，若两个客户端同时写同一 Session，结果是不确定的；UI 必须显示风险而不是静默并行。

### 11.2 建议的 ownership 数据

后续 sidecar 可增加：

```ts
interface SessionOwnership {
  owner: 'infinite-map' | 'native-ide' | 'none';
  leaseId?: string;
  ownerInstanceId?: string;
  acquiredAt?: string;
  expiresAt?: string;
  handoffState?: 'none' | 'requested' | 'released' | 'accepted' | 'conflict';
}
```

获取/释放必须使用现有 KM 文件锁和 CAS revision；不能只靠 Webview 状态。Native IDE 没有可确认的 handoff 回执时，只能把状态标为 `requested`，不能标为 `accepted`。

### 11.3 Codex 一进程一 Session 的 trade-off

原设计稿选择“一 Session 一 Codex App Server 进程”，优点是 writer 边界清晰、handoff 简单、故障隔离好；缺点是多会话时进程数、内存、启动时延和升级管理成本线性增加。

当前源码并未证明该决策已落地：Registry 在组件级创建一个 `CodexRuntimeManager`，见 `src/providers/providerComponentRegistry.ts:224-249`。实施前必须二选一：

| 选项                         | 优点                                      | 缺点                                                   | 建议                                            |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| 每 Session 独立 Runtime      | ownership 最清晰，native handoff 容易隔离 | 资源开销大，需 RuntimePool、回收和崩溃恢复             | 若产品同时活动会话≤3，优先采用                 |
| 工作区/Provider 共享 Runtime | 资源和启动成本低                          | 多 Session writer、恢复和 handoff 复杂；需 thread 级锁 | 多会话规模较大时采用，但必须先实现 thread lease |

在决策完成前，不能在文档或 capability 中宣称“一 Session 一进程”。

## 12. 待决策清单与影响评估

| 编号 | 待决策                           | 选项                                                  | 影响                                                                      | 建议                                              | 决策                                          |
| ---- | -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| D1   | 详情弹窗是否彻底删除             | A 保留 fallback；B 立即删除                           | A 增加维护面但抗私有协议失败；B 交付简单但 Copilot 无原生能力时无历史查看 | 选 A，待 Phase B 指标达标再删                     | B 立即删除                                    |
| D2   | Copilot 原生打开承诺             | A 首期不承诺；B 依赖 proposed API；C 读取私有 storage | B 版本风险；C 安全/兼容风险                                               | 选 A；B 仅实验 flag；禁止 C                       | 选 A；B 仅实验 flag；禁止 C                   |
| D3   | Codex 私有 URI 是否进入生产      | A allowlist + 探测；B 不支持 IDE，只 CLI              | A 可满足用户目标但需持续回归；B 稳定性高但体验弱                          | 选 A，明确 experimental 和 fallback               | 选 A，明确 experimental 和 fallback           |
| D4   | Claude 原生命令是否承诺稳定      | A experimental；B 仅 CLI                              | A 可定位 IDE；B 更稳定                                                    | 选 A experimental，CLI 作为稳定路径               | 选 A experimental，CLI 作为稳定路径           |
| D5   | sidecar schema 是否升级到 v2     | A additive 不改版本；B v1→v2                         | B 可审计，需迁移代码；A 改动小但版本语义弱                                | 选 B                                              | B                                             |
| D6   | fallback 默认策略                | A 详情；B CLI；C 弹窗让用户选                         | A 保留现有可读性；B 需安装 CLI；C 多一步交互                              | 默认 A，Claude 可提供 B，统一允许用户改选         | B CLI；                                       |
| D7   | Codex Runtime 进程模型           | A 一 Session 一进程；B 共享进程                       | A 隔离好、资源高；B 资源低、锁复杂                                        | 活跃会话≤3选 A，否则 B+thread lease              | 活跃会话≤3选 A，否则 B+thread lease          |
| D8   | ownership handoff 首期范围       | A 只读打开；B 打开即接管；C 完整 handoff              | A 风险最低；B 会双写；C 工期大                                            | 选 A                                              | A 只读打开；                                  |
| D9   | nativeOpen 是否写入 KM 节点 JSON | A 仅 sidecar；B 节点 latestSession 同步               | A 改 KM 少；B 深链/节点卡片可直接显示                                     | 先 sidecar + latestSession 只保留摘要，稳定后同步 | A 仅 sidecar；                                |
| D10  | 原生打开成功判定                 | A 命令未抛错；B Provider 回执                         | A 可实现但不证明定位；B 复杂且依赖 Provider                               | 首期 A，日志区分 attempted/accepted/verified      | 首期 A，日志区分 attempted/accepted/verified  |

## 13. 分阶段实施计划

### Phase 0：开关和协议准备

- 增加 `OpenTarget`、`NativeOpenDescriptor`、`SessionOpenResult`、错误码。
- 引入 feature flag 和结构化日志。
- 完成 v1→v2 sidecar 读兼容，不改变 UI。
- 新增历史精确匹配单元测试。

交付门槛：现有测试、typecheck、lint 全绿；旧详情路径行为不变。

### Phase 1：Host 历史打开主链路

- 实现 `openHistoricalSession()`。
- 修复 Coordinator 忽略 `executionId` 的缺陷。
- 加入 NativeOpenResolver 骨架和 `infinite-map` fallback。
- Webview 条目进入 `opening` 状态并消费结果。

交付门槛：使用 fake Adapter 验证 A/B/C 三条历史记录不会串会话。

### Phase 2：Codex/Claude 原生适配

- Codex 私有 URI + custom editor 适配，版本 allowlist 可配置。
- Claude command 适配，CLI fallback 保持可用。
- 安装、版本不兼容、命令失败和 Session 不存在场景回归。

交付门槛：本机扩展版本和至少一个旧历史 Session 手工验证；私有契约变化时能 fail closed。

### Phase 3：Copilot 实验能力和详情降级

- 仅在公开/可验证 API 存在时实现 proposed adapter。
- 验证 SDK `baseDirectory` 与 Copilot UI store 的同源性；不通过则保持 unsupported。
- 完善详情 fallback 的可发现入口和错误文案。

交付门槛：不能把“SDK resume 成功”误报为“Copilot UI 打开成功”。

### Phase 4：Ownership/handoff（取消）

- 增加 owner/lease/handoff 数据和 CAS 工具。
- Provider 支持释放/接管时才启用；否则只记录 requested。
- 加入双写冲突、超时、崩溃恢复测试。

## 14. 测试和验收设计

### 14.1 单元测试

- `openHistoricalSession` 必须把匹配记录的 `sessionId/threadId` 传给 Adapter。
- executionId 不存在、nodeId 不匹配、orphan、缺 ID、分页历史均有断言。
- Codex URI 生成：scheme、authority、viewType、local path、编码和 allowlist。
- Claude command 探测：命令存在/不存在/调用抛错/CLI fallback。
- Copilot 明确返回 unsupported，不得误报 native。
- `openUri` 原有安全校验全部保留。
- sidecar v1/v2 normalize、损坏 sidecar quarantine、nativeOpen 缺失兼容。
- 重复点击幂等和 `opening` 状态防抖。

### 14.2 集成测试

- fake VS Code API 验证 `vscode.openWith` 的 URI 和 viewType。
- fake `vscode.commands.executeCommand` 验证 Claude sessionId 参数。
- fake Provider Registry 验证 provider capability gate。
- Host → Webview result 序列化验证未知字段不会破坏旧客户端。

### 14.3 手工回归矩阵

| 场景                       | Codex | Claude | Copilot |
| -------------------------- | ----: | -----: | ------: |
| 当前活动会话打开           |  必测 |   必测 |    必测 |
| 旧历史会话打开             |  必测 |   必测 |    必测 |
| 活动列表入口               |  必测 |   必测 |    必测 |
| 历史列表入口               |  必测 |   必测 |    必测 |
| Provider 未安装            |  必测 |   必测 |    必测 |
| 扩展版本不兼容             |  必测 |   必测 |    必测 |
| Session 已删除             |  必测 |   必测 |    必测 |
| native 失败后详情 fallback |  必测 |   必测 |    必测 |
| VS Code 重启后从 KM 恢复   |  必测 |   必测 |    必测 |

### 14.4 发布验收

```text
npm run verify:assets
npm run mcp:build
npm run test:provider
npm run typecheck
npm run lint
npm run build
```

还需执行浏览器/Webview smoke：打开 `.km`、打开历史抽屉、点击旧记录、验证 Provider 窗口/回退提示和焦点恢复。若涉及 UI 样式或布局变更，按仓库前端验证规则保存截图到 `Workspace/validations/<feature>/` 并执行 DOM `getBoundingClientRect` 检查。

## 15. 关键文件速查

| 需求                  | 文件                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------- |
| Webview 历史点击      | `webui/ui/directive/agentSessionHistory/agentSessionHistory.directive.js`            |
| Webview 活动点击      | `webui/ui/directive/agentActivityOverview/agentActivityOverview.directive.js`        |
| Webview 请求封装      | `webui/ui/service/agentSession.service.js`                                           |
| 协议 request/result   | `src/sessions/protocol.ts`                                                           |
| Provider-neutral 类型 | `src/sessions/types.ts`                                                              |
| 历史记录读取          | `src/sessions/agentControlBarCoordinator.ts`、`src/mcp/services/kmSessionState.ts` |
| 历史打开编排          | `src/sessions/sessionOrchestrator.ts`                                                |
| Provider 注册         | `src/providers/providerComponentRegistry.ts`                                         |
| Codex 打开            | `src/providers/codex/CodexAgentSessionAdapter.ts`                                    |
| Claude 打开           | `src/providers/claude/ClaudeAgentSessionAdapter.ts`                                  |
| Copilot 打开/限制     | `src/providers/copilot/CopilotAgentSessionAdapter.ts`                                |
| InfiniteMap 回跳深链  | `src/deepLinks/sessionUriHandler.ts`                                                 |
| Webview 模板缓存      | `webui/ui/templates.js`                                                              |
| 历史/详情现有测试     | `tests/agent-session-dock.test.cjs`、`tests/agent-activity-provider-spi.test.cjs`  |

## 16. 最终决策建议

建议批准以下最小可交付范围：

1. 先修复 `openSession` 的历史精确定位缺陷，再切换 UI 主入口。
2. Codex 使用受版本探测保护的私有 URI，Claude 使用受版本探测保护的命令；两者都提供 fallback。
3. Copilot 暂不承诺原生 IDE 打开，继续提供 InfiniteMap 详情 fallback，等待可验证的公开/实验 API。
4. `openUri` 永久保持 InfiniteMap deep link 语义，native metadata additive 存储并以 sidecar schema v2 管理。
5. 详情弹窗 Phase A 保留为 fallback，待原生打开稳定后再做 Phase B 删除。
6. 首期不做自动 handoff 和 ownership 接管；先建立只读打开、错误可见、日志可审计的基础链路。

按以上边界实施，可以满足“从居中弹窗详情改为拉起 VS Code 对应智能体应用并打开会话”的产品目标，同时保留历史数据可读性，避免把未经核实的 Provider 私有能力固化为不可回滚的公共契约。
