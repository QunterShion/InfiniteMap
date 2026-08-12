# InfiniteMap 优化落地方案

> 文档版本：v1.0
> 生成时间：2026-08-11
> 依据：工程项目全量代码四路审计（MCP 层 / Companion 层 / 主扩展层 / 前端层）
> 输出目录：`Workspace/openSource/InfiniteMap/docs/optimization-plan.md`

---

## 一、概述

方案已基本落地，核心架构（三 Companion / MCP 16 工具 / Provider API V1 / AngularJS Webview）与设计文档整体一致。审计期间未发现功能性需求遗漏，但识别出 **9 个 P0 阻断缺陷、约 20 个 P1 重要问题，以及若干可显著降低维护成本的架构优化点**。

### 1.1 需求偏差评估

| 维度 | 结论 |
|---|---|
| Codex Companion（stdio JSONL） | ✅ 符合，`thread/start`、`turn/start`、`turn/steer` 流程正确 |
| Copilot Companion（`@github/copilot-sdk`） | ✅ 主路径符合，存在 token 变更不刷新客户端的 P1 缺陷 |
| Claude Companion（`@anthropic-ai/claude-agent-sdk`） | ✅ 主路径符合，MCP 缺失时存在 P0 危险降级 |
| MCP 16 工具 | ✅ 工具接口完整，但内部 I/O 存在 P0 正确性和性能缺陷 |
| 主扩展层 | ✅ 扩展入口 / DeepLink / SessionOrchestrator 逻辑正确，P0 打包缺失 |
| 前端 Webview | ✅ 指令 / 服务结构完整，P0 数据形态不匹配导致锁定逻辑失效 |

**结论：** 需求实现无结构性偏差，下文所列均属工程质量问题，需在首次稳定版本发布前修复。

---

## 二、P0 阻断缺陷（必须先修复，否则不可发布）

### 2.1 【MCP-P0-01】文件锁永久死锁

**位置：** `src/mcp/services/kmFileLock.ts:47-52, 59-66`

**现象：** 进程在写 lock 文件时崩溃，留下空文件或残缺 JSON；下次任何工具调用尝试解析时抛出异常，锁永远无法被接管，整个 KM 文件陷入永久不可写状态。

**根因：** `acquireLock` 在两步操作（writeFileSync → JSON.stringify）之间没有原子性保证；lock 过期恢复逻辑依赖 `JSON.parse` 成功，空文件直接 throw。

**修复方案：**
```typescript
// kmFileLock.ts — acquireLock 核心逻辑
async function acquireLock(lockPath: string, token: string): Promise<void> {
  const content = JSON.stringify({ token, ts: Date.now() });
  // 原子写：先写临时文件再 rename，避免半写残留
  const tmp = lockPath + '.tmp.' + process.pid;
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, lockPath);
}

// releaseLock：parse 失败时按 mtime 判断是否已过期
async function tryBreakStaleLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_EXPIRE_MS) {
      await fs.promises.unlink(lockPath);
      return true;
    }
  } catch { /* 文件不存在，视为已释放 */ }
  return false;
}
```

---

### 2.2 【MCP-P0-02】文件锁 Token 竞争导致 finally 误删继承者的锁

**位置：** `src/mcp/services/kmFileLock.ts`（finally 块）

**现象：** 持锁者 A 超时，持锁者 B 接管并写入新 token；A 的 finally 块无条件 `unlink` → 删掉 B 的锁 → B 以为自己仍持锁继续写，实际已无保护。

**修复方案：**
```typescript
// finally 中校验 token，仅删除自己的锁
async function releaseLockIfOwner(lockPath: string, myToken: string): Promise<void> {
  try {
    const raw = await fs.promises.readFile(lockPath, 'utf8');
    const { token } = JSON.parse(raw);
    if (token === myToken) {
      await fs.promises.unlink(lockPath);
    }
  } catch { /* 文件已不存在，无需处理 */ }
}
```

同时在持锁期间启动 heartbeat（每 `LOCK_EXPIRE_MS / 3` 刷新 mtime），防止因执行时间过长被误判为过期。

---

### 2.3 【MCP-P0-03】`.exec.json` 损坏静默吞错，Lease 保护失效

**位置：** `src/mcp/services/kmExecState.ts:142-154`

**现象：** sidecar 文件损坏时，`readExecState` 返回空对象而非抛出；`km_mark_done` 查不到任何 lease 记录，直接认为"无活跃 lease"并标记完成，破坏并发保护。

**修复方案：**
```typescript
function readExecState(path: string): ExecState {
  try {
    const raw = fs.readFileSync(path, 'utf8');
    return JSON.parse(raw) as ExecState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyExecState();
    }
    // 损坏文件：隔离并抛出，不允许继续写入
    const quarantine = path + '.corrupt.' + Date.now();
    fs.renameSync(path, quarantine);
    throw new Error(
      `[kmExecState] sidecar 文件损坏已隔离至 ${quarantine}，请人工检查后重试`
    );
  }
}
```

---

### 2.4 【MCP-P0-04】单次写操作触发 5× 冗余读 I/O

**位置：** `src/mcp/services/kmFileWriter.ts`（`km_mark_done` 路径）

**现象：** 一次 `km_mark_done` 产生 5 次 `readFileSync` + 3 次 `JSON.parse` + 2 次 SHA-256，对大文件（200+ 节点）造成明显延迟，且在高并发场景下 I/O 放大倍数线性增长。

**修复方案：**
1. 在已持锁的单次写事务内，复用同一次读取的 `rawContent` 和已解析的树对象，不再重复读文件；
2. 对内存中已序列化的字符串直接计算 SHA-256，而非再次读磁盘：

```typescript
// 单次读 → 修改 → 序列化 → hash → 写，全程只读一次
const raw = await fs.promises.readFile(kmPath, 'utf8');
const tree = JSON.parse(raw);
applyMutations(tree, mutations);
const serialized = JSON.stringify(tree);
const newRevision = sha256(serialized);          // 对内存字符串哈希
await fs.promises.writeFile(kmPath, serialized, 'utf8');
```

---

### 2.5 【MCP-P0-05】`modified=0` 时仍返回 `verified:true`

**位置：** `src/mcp/services/kmFileWriter.ts:238-246`

**现象：** 目标节点 ID 不存在时，`km_mark_done` 静默返回成功，调用方无法感知节点未被修改，导致误判任务已完成。

**修复方案：**
```typescript
if (result.modified === 0) {
  throw new KmToolError(
    'NODE_NOT_FOUND',
    `指定节点 [${nodeIds.join(', ')}] 在文件中不存在，未做任何修改`
  );
}
```

---

### 2.6 【MCP-P0-06】Lock 超时（2 s）< Lock 过期时间（10 s），窗口期内无保护

**位置：** `src/mcp/services/kmFileLock.ts:5-7`

**现象：** `LOCK_TIMEOUT_MS=2000`，`LOCK_EXPIRE_MS=10000`；持锁者崩溃后，锁要 10 s 才能被接管，但等待者最多只等 2 s 就报超时 — 等待者永远无法通过超时机制拿到过期锁。

**修复方案：** `LOCK_TIMEOUT_MS` 应至少等于 `LOCK_EXPIRE_MS`，推荐使用指数退避：

```typescript
const LOCK_EXPIRE_MS  = 10_000;
const LOCK_TIMEOUT_MS = 15_000;  // > LOCK_EXPIRE_MS，留足过期检测余量
const LOCK_RETRY_BASE =    200;  // 指数退避起点
```

---

### 2.7 【Claude-P0-01】MCP 未安装时降级为宿主进程，产生危险副作用

**位置：** `companions/droid/src/ClaudeAgentSdkAdapter.ts:159, 286-288`

**现象：** `@modelcontextprotocol/sdk` 不可用时，代码回退到 `process.execPath` 启动子进程；宿主进程（Node.js / VS Code Extension Host）并不是 Claude Code CLI，执行后果不可预测，且可能产生无限递归或权限问题。

**修复方案：** MCP 缺失时必须 fail-closed，不允许任何降级：

```typescript
// ClaudeAgentSdkAdapter.ts — activate()
private async activate(): Promise<void> {
  let claudePath: string;
  try {
    claudePath = await which('claude');  // 使用 which 精确定位 CLI
  } catch {
    throw new Error(
      '[ClaudeAgentSdkAdapter] 未找到 claude CLI，请先安装 Claude Code 后重试。' +
      '不支持降级启动，以确保安全性。'
    );
  }
  // ...后续正常初始化
}
```

---

### 2.8 【Extension-P0-01】MCP server.js 未打包进 VSIX，扩展启动即崩溃

**位置：** `.vscodeignore:11`（`node_modules/@modelcontextprotocol/sdk` 被排除）

**现象：** 发布后的 VSIX 中不含 MCP SDK，Extension Host `require` 时立即抛出 `MODULE_NOT_FOUND`，扩展无法激活，所有 16 个 MCP 工具均不可用。

**修复方案（二选一）：**

**方案 A — webpack/esbuild 打包（推荐）：** 在 `webpack.config.js` 中将 MCP SDK 纳入 bundle，`.vscodeignore` 排除 `node_modules` 整体，bundle 文件打入 VSIX。

**方案 B — `.vscodeignore` 白名单：** 精确保留 MCP SDK：
```
# .vscodeignore
node_modules/**
!node_modules/@modelcontextprotocol/sdk/**
```

---

### 2.9 【Frontend-P0-01】`applySnapshot` 与 send 回调的 session 数据形态不匹配，Turn 锁定逻辑永久失效

**位置：** `webui/ui/directive/agentControlBar/`（`applySnapshot` 函数 vs send 成功回调）

**现象：** `applySnapshot` 使用驼峰字段（`activeTurnId`），send 回调写入下划线字段（`active_turn_id`）；`activeTurnId` 永远为 `undefined`，导致 Provider / 模型 / effort 在 turn 执行期间从不锁定，用户可在 turn 进行中随意切换模型，产生状态撕裂。

**修复方案：** 统一使用驼峰格式，在 `agentSession.service.js` 的 `updateSession` 中做单点标准化：

```javascript
// agentSession.service.js
function normalizeSession(raw) {
  return {
    activeTurnId:   raw.activeTurnId   ?? raw.active_turn_id   ?? null,
    activeProvider: raw.activeProvider ?? raw.active_provider  ?? null,
    // ...其他字段同理
  };
}
```

---

## 三、P1 重要问题（首个稳定版本前修复）

### 3.1 MCP 层

| 编号 | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| MCP-P1-01 | `kmExecState.ts`, `kmSessionState.ts` | Sidecar 每次写操作全量读写 O(历史记录数)，记录越多越慢 | 改为追加写 JSONL + 定期压缩，读取时倒序扫描取最新 N 条 |
| MCP-P1-02 | `km_list_todos`, `km_get_node` | 单次请求分别读文件 3 次、2 次 | 在锁内读一次，传引用复用 |
| MCP-P1-03 | 全部 MCP 工具 | 所有 `readFileSync` / `writeFileSync` 阻塞 Event Loop | 统一替换为 `fs.promises.*` |
| MCP-P1-04 | `kmFileReader.ts` | 遍历树时无 nodeId 索引，每次 DFS O(n)，大文件 O(n²) | 读文件后一次性构建 `Map<string, KmNode>`，传入下游 |
| MCP-P1-05 | `kmFileWriter.ts`, `kmExecState.ts`, `kmFileReader.ts` | 三文件循环依赖 | 抽取 `kmTree.ts`（纯树操作）和 `kmLabels.ts`（标签常量），断开循环 |

### 3.2 Codex Companion

| 编号 | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| Codex-P1-01 | `CodexAppServerClient.ts` | notification handlers 在 `initialize` 响应返回 **后** 才注册，初始化阶段的通知丢失 | 在发送 `initialize` 请求前注册所有 handlers |
| Codex-P1-02 | `CodexAppServerClient.ts` | server request handler 的 dispose 路径存在资源泄漏，审批回调可能丢失 | 使用统一的 `DisposableStore` 管理，确保 dispose 时先通知再释放 |

### 3.3 Copilot Companion

| 编号 | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| Copilot-P1-01 | `CopilotRuntimeManager.ts` | Token 变更（`SecretStorage` 事件）不触发 SDK client 重建，旧 token 一直使用到重启 | 订阅 `onDidChange` 事件，token 变更后调用 `client.dispose()` 并重新 `createClient()` |
| Copilot-P1-02 | `CopilotSdkAdapter.ts` | 用户审批存在事件回调和直接返回两条路径，竞争条件下可能双重审批 | 删除事件回调路径，仅保留 `Promise` 直接返回路径 |

### 3.4 Claude Companion

| 编号 | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| Claude-P1-01 | `ClaudeAgentSdkAdapter.ts` | `PermissionRequest`、`SessionStart`、`Stop` 三类 Hook 未注册，权限拦截和生命周期事件缺失 | 补全三类 Hook 注册，`PermissionRequest` 接入 `PendingInputRegistry`，`SessionStart/Stop` 触发 `updateSession` |
| Claude-P1-02 | `ClaudeAgentSdkAdapter.ts` | `getSessionMessages()` 在长对话后触发 context compaction，返回摘要而非完整历史 | 文档注释警告此行为；UI 展示时以 `agentSessionHistory` 指令的增量事件为准，不依赖全量消息 |

### 3.5 主扩展层

| 编号 | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| Main-P1-01 | `sessionOrchestrator.ts` | Recovery 路径吞掉全部异常，Provider 断开后 session 永远不进入 `disconnected` 状态，UI 无法展示重连提示 | catch 中按异常类型分流：网络错误 → `disconnected`，其余 → `failed`，均触发 `updateSession` |
| Main-P1-02 | `providerComponentRegistry.ts` | `onDidChange` 事件有发射逻辑但无任何订阅者，Provider 列表变更后 UI 不刷新 | 在 `mindEditor.ts` 激活时订阅 `onDidChange`，变更后通知 Webview 刷新 Provider 下拉列表 |

### 3.6 前端层

| 编号 | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| FE-P1-01 | `agentControlBar` 指令 | `session.delta` 每帧触发 `$broadcast` + `$digest`，高频流式输出时造成 digest storm，UI 卡顿 | 用 `requestAnimationFrame` 节流，或改为 100 ms debounce 批量更新 |
| FE-P1-02 | `agentControlBar` 指令 | Provider 状态为 `installed_inactive` 时，模型列表加载逻辑跳过该状态 → 模型永远为空 → Send 按钮永久灰化 | 在 `installed_inactive` 状态下也触发 `loadModels()`，仅在 `not_installed` 时跳过 |
| FE-P1-03 | `agentSessionI18n.service.js` | 9 个 session 状态键（`allocated`、`starting` 等）在 21 种语言包中均无翻译，回退显示英文枚举值 | 补全 21 语言包中 9 个状态键的翻译条目 |

---

## 四、架构优化方向（技术债，推荐在 v1.1 周期内处理）

### 4.1 MCP Sidecar 统一事务层

三个 sidecar 文件（`.exec.json` / `.sessions.json` / `.km`）各自实现锁 + 读 + 改 + 写，代码高度重复且行为不一致。

**建议：** 抽取 `withSidecarTransaction<S>(path, fn)` 泛型工具函数，统一处理锁获取 / heartbeat / 原子写 / 版本校验，各业务文件只传入纯函数 `fn: (state: S) => S`。

```typescript
// src/mcp/services/sidecarTransaction.ts（新文件）
async function withSidecarTransaction<S>(
  path: string,
  schema: ZodSchema<S>,
  defaultValue: S,
  fn: (state: S) => S | Promise<S>
): Promise<{ newState: S; revision: string }>;
```

### 4.2 KM 树操作统一模块

DFS 遍历、节点查找、标签判断、子树哈希等逻辑在 `kmFileReader.ts`、`kmFileWriter.ts`、`kmExecState.ts`、`kmCollaborationClaims.ts`、`kmRevisionCache.ts` 中存在 5 份重复实现。

**建议：** 新建 `src/mcp/services/kmTree.ts`（纯树操作，无 I/O）和 `src/mcp/services/kmLabels.ts`（标签常量与判断函数），所有业务文件改为引用这两个模块。

### 4.3 Companion 共享基类

三个 Companion Adapter（Codex / Copilot / Claude）均包含以下重复代码：
- `PendingInputRegistry`（等待用户输入的回调映射）
- `CachedProbe<T>`（Provider 状态探测 + 缓存 + 失效逻辑）
- `AgentExecutionReceiptSchema`（KM 回执 JSON Schema）
- Session 状态机（`allocated → starting → running → idle/completed/...`）

**建议：** 新建 `companions/shared/` 目录：
```
companions/shared/
  base-session-adapter.ts      # BaseSessionAdapter<TState> 抽象基类
  pending-input-registry.ts    # PendingInputRegistry
  cached-probe.ts              # CachedProbe<T>
  receipt-schema.ts            # AgentExecutionReceiptSchema（三方共享）
```

### 4.4 MCP 工具 Schema 单点定义

`src/mcp/tools/` 每个工具文件内嵌 JSON Schema，同时在 `server.ts` 存有已过时的 Schema 副本。两处不同步时，工具调用会因 Schema 不匹配被拒绝。

**建议：** 各工具文件的 Schema 为唯一权威来源，`server.ts` 改为动态 `import` 各工具的 `schema` 导出，删除静态副本。

---

## 五、落地路线图

### 阶段一：P0 修复（建议 1–2 个工作日内完成）

```
Day 1
  ├── MCP-P0-01 + MCP-P0-02  文件锁原子化 + Token 校验
  ├── MCP-P0-03               sidecar 损坏隔离
  └── MCP-P0-06               超时 / 过期时间修正

Day 2
  ├── MCP-P0-04 + MCP-P0-05  I/O 降 5×1 + modified=0 报错
  ├── Claude-P0-01             fail-closed MCP 检测
  ├── Extension-P0-01          VSIX 打包修复
  └── Frontend-P0-01           session 字段统一驼峰
```

### 阶段二：P1 修复（建议 3–5 个工作日内完成）

```
Week 2
  ├── MCP-P1-01~05  I/O 异步化 + 索引 + 循环依赖
  ├── Codex-P1-01~02 handler 注册时序 + dispose 泄漏
  ├── Copilot-P1-01~02 token 刷新 + 双路径竞争
  ├── Claude-P1-01~02 Hook 补全 + compaction 警告
  ├── Main-P1-01~02  Recovery 状态机 + Registry 订阅
  └── FE-P1-01~03   digest 节流 + inactive 模型加载 + i18n 补全
```

### 阶段三：技术债（v1.1 迭代规划）

```
  4.1  withSidecarTransaction 统一事务层
  4.2  kmTree.ts + kmLabels.ts 合并重复 DFS
  4.3  companions/shared/ 基类抽取
  4.4  MCP Schema 单点化
```

---

## 六、验收标准

### P0 验收
- [ ] `kmFileLock.ts` 单元测试：模拟写 lock 中途崩溃，下次调用可正常恢复
- [ ] `kmFileLock.ts` 单元测试：Token 不匹配时 finally 不删除他人的锁
- [ ] `kmExecState.ts` 单元测试：损坏文件隔离后，下次调用返回 `KmToolError` 而非空对象
- [ ] `kmFileWriter.ts` 单元测试：`modified=0` 时抛出 `NODE_NOT_FOUND` 错误
- [ ] `ClaudeAgentSdkAdapter.ts` 集成测试：`claude` CLI 不存在时激活失败，不启动 fallback 子进程
- [ ] VSIX 包内验证：`node_modules/@modelcontextprotocol/sdk` 存在（或 bundle 包含 MCP 代码）
- [ ] E2E 测试：执行 Turn 期间，模型下拉 / Provider 切换按钮处于禁用状态

### P1 验收
- [ ] 压测：200 节点 KM 文件，连续 100 次 `km_mark_done`，Event Loop 延迟 P99 < 50 ms
- [ ] `installed_inactive` 状态下 Provider 可展示模型列表，Send 按钮可用
- [ ] 所有 21 语言包中 9 个 session 状态键有对应翻译

---

*文档由四路并行代码审计综合生成*
*审计覆盖：MCP 服务层 / Codex Companion / Copilot Companion / Claude Companion / 主扩展层 / AngularJS 前端*
