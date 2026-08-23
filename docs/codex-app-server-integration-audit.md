# Codex App Server 集成审计

> 审计日期：2026-08-23  
> 运行时基线：`codex-cli 0.149.0-alpha.4.1`  
> 结论：InfiniteMap 当前直接集成 **32 个 JSON-RPC 方法**，其中客户端请求 14 个、客户端通知 1 个、服务端请求 5 个、服务端通知 12 个。

这里的“32 个”是 InfiniteMap 实际调用或消费的方法数，不是 Codex App Server 的全部协议方法数。App Server 还生成了文件系统、进程、插件、Apps、环境、实时语音等大量协议；这些不属于 InfiniteMap 智能体会话控制边界，不能为了追求数量全部接入。

## 1. 最终结论

当前集成路线合理：扩展宿主启动官方 `codex app-server` 子进程，通过 stdio JSONL/JSON-RPC 通信；Provider Adapter 负责 Thread/Turn/Item 映射，KM 文件仍只由 InfiniteMap MCP 修改。此次审计已把过去分散的字符串调用收口到一个协议清单，并将当前运行时生成的 Schema 从“只缓存”升级为“启动前强制对账”。

本次错误不是上游随机故障。根因是 `outputSchema` 使用了 OpenAI Structured Outputs strict 模式，但 `validations.items.properties.command` 没有同时出现在 `required` 中。strict 模式要求每个对象都满足：

- `additionalProperties: false`；
- `properties` 中的每个字段都出现在 `required`；
- 业务上的可选值用“字段必填 + 类型允许 `null`”表达。

修复后的回执约束为：

```ts
interface AgentExecutionReceipt {
  executionId: string;
  status: 'succeeded' | 'failed' | 'blocked';
  summary: string;
  artifacts: Array<{
    path: string;
    kind: 'created' | 'modified' | 'report';
  }>;
  validations: Array<{
    command: string | null;
    name: string;
    passed: boolean;
    evidence: string | null;
  }>;
  collaborationChildren: string[];
  blocker: string | null;
}
```

## 2. 32 个已集成方法

### 2.1 Client Request：14 个

| # | 方法 | 用途 | 当前状态 |
| ---: | --- | --- | --- |
| 1 | `initialize` | 握手并声明 `experimentalApi: true` | 完整 |
| 2 | `account/read` | 探测账号与认证要求 | 完整 |
| 3 | `account/login/start` | 启动 ChatGPT 浏览器登录 | 完整 |
| 4 | `model/list` | 分页读取可用模型和推理强度 | 完整 |
| 5 | `permissionProfile/list` | 分页读取策略允许的权限 Profile | 完整 |
| 6 | `configRequirements/read` | 读取管理员约束并过滤权限选项 | 完整 |
| 7 | `thread/start` | 创建新会话并注入 MCP、控制指令和权限 | 完整 |
| 8 | `thread/resume` | 仅恢复已持久化且当前未加载的旧会话 | 完整 |
| 9 | `thread/read` | 查询、恢复和错误对账 | 完整 |
| 10 | `thread/name/set` | 首个 Turn 后尽力更新名称 | 完整，非阻塞 |
| 11 | `thread/archive` | 归档 Provider Thread | 完整 |
| 12 | `turn/start` | 启动 Turn，携带 trace 与 strict `outputSchema` | 完整 |
| 13 | `turn/steer` | 对活动 Turn 追加输入并校验 `expectedTurnId` | 完整 |
| 14 | `turn/interrupt` | 中断匹配的活动 Turn | 完整 |

### 2.2 Client Notification：1 个

| # | 方法 | 用途 | 当前状态 |
| ---: | --- | --- | --- |
| 15 | `initialized` | 完成连接握手 | 完整 |

### 2.3 Server Request：5 个

| # | 方法 | InfiniteMap 回执 | 当前状态 |
| ---: | --- | --- | --- |
| 16 | `item/commandExecution/requestApproval` | `{ decision }`，尊重 `availableDecisions` | 完整 |
| 17 | `item/fileChange/requestApproval` | `{ decision }`，不把单次允许升级为持久授权 | 完整 |
| 18 | `item/tool/requestUserInput` | `{ answers: { [questionId]: { answers: string[] } } }` | 完整 |
| 19 | `mcpServer/elicitation/request` | accept 带 `content`；decline 带 `content: null` | 完整 |
| 20 | `item/permissions/requestApproval` | 只回授请求权限子集，默认 `scope: "turn"` | 完整 |

当前 0.149 生成 Schema 的真实方法名是 `item/tool/requestUserInput`。旧的 `tool/requestUserInput` 不再作为兼容别名注册，避免把协议漂移静默隐藏。

### 2.4 Server Notification：12 个

| # | 方法 | 用途 | 当前状态 |
| ---: | --- | --- | --- |
| 21 | `turn/started` | 绑定活动 Turn 与提交记录 | 完整 |
| 22 | `thread/status/changed` | 映射 active/idle/notLoaded/systemError | 完整 |
| 23 | `item/agentMessage/delta` | 流式输出智能体文本 | 完整 |
| 24 | `item/commandExecution/outputDelta` | 流式输出命令结果 | 完整 |
| 25 | `item/started` | 工具/Item 开始事件 | 完整 |
| 26 | `item/completed` | 工具/Item 完成事件 | 完整 |
| 27 | `turn/diff/updated` | 更新本轮变更事件 | 完整，统一事件模型 |
| 28 | `model/rerouted` | 更新实际使用模型 | 完整 |
| 29 | `turn/completed` | 收敛 Turn 状态并结束活动态 | 完整 |
| 30 | `error` | 保留真实错误、上游详情与 `willRetry` | 完整 |
| 31 | `serverRequest/resolved` | 清除已被 App Server 自动取消的过期审批 | 完整 |
| 32 | `account/login/completed` | 匹配 `loginId` 后结束登录等待并刷新运行时 | 完整 |

## 3. Stable 与实验字段边界

在 0.149 的非实验生成 Schema 中，上述 32 个方法名都存在；InfiniteMap 仍必须固定声明 `capabilities.experimentalApi = true`，因为实际请求使用了受能力门控的字段：

- `thread/start.permissions`；
- `thread/resume.permissions`；
- `turn/start.permissions`；
- `turn/start.additionalContext`；
- `turn/steer.additionalContext`。

因此握手与 Schema 生成必须成对配置：

```text
initialize.capabilities.experimentalApi = true
codex app-server generate-json-schema --experimental
```

只做其中一个都会产生“Schema 看似存在、运行时字段被拒绝”的假兼容。运行时 fingerprint 已包含二进制 realpath、版本、mtime、size、SHA-256 和 `experimentalApi`，升级 Codex 后会重新生成并验证 Schema。

## 4. 本次一次性收口的缺陷

| 缺陷 | 旧行为 | 修复后 |
| --- | --- | --- |
| strict output schema | `command`、`evidence`、`blocker` 可省略 | 全部 required；无值时为 `null` |
| Schema 使用方式 | 生成后只缓存，不检查 | 启动前检查 32 个方法、关键请求字段及 5 类回执 |
| 损坏缓存 | 目标目录已存在时可能继续读旧缓存 | 临时目录先验证，再替换旧缓存；多窗口等待锁释放 |
| 实验能力 | 请求字段与握手/生成面可能不一致 | 握手和 Schema 都固定启用实验表面 |
| 新线程生命周期 | 创建后立即 resume，可能没有 rollout | 新线程不 resume；只有旧会话恢复时 resume |
| 用户问答方法名 | 旧名 `tool/requestUserInput` | 当前 Schema 名 `item/tool/requestUserInput` |
| 权限审批回执 | 错误返回 `{ decision: "accept" }` | 返回 `{ permissions, scope: "turn" }` |
| MCP 拒绝回执 | 缺少 `content` | 返回 `{ action: "decline", content: null }` |
| 过期审批 | 等待五分钟超时，UI 可能卡住 | 使用 JSON-RPC requestId 消费 `serverRequest/resolved` |
| 权限发现异常 | 所有错误都静默降级 | 只有 `-32601`/method unavailable 降级，其余错误透出 |
| 登录 | 未接官方 App Server 登录流程 | start → 打开 authUrl → 匹配 completed → 刷新 runtime |
| 原始错误 | `thread/read` 对账错误可能覆盖首次错误 | 对账仅尽力执行，始终保留原始 Turn 错误 |

## 5. 有意不集成的协议

以下不是漏接，而是边界选择：

| 协议组 | 暂不接入原因 |
| --- | --- |
| `thread/list`、`thread/turns/list`、`thread/items/list` | 活动/历史页签以 InfiniteMap 创建并记录的智能体会话旁车为事实来源，不导入用户全部 Codex 历史 |
| `thread/fork`、goal、metadata、rollback/revert | 当前产品没有对应交互和数据模型 |
| reasoning/raw response delta | 不展示模型内部推理或原始上游响应 |
| `process/*`、`fs/*`、`command/exec*` | 会绕开 Agent 工具权限和 InfiniteMap MCP 业务边界 |
| plugin/app/marketplace/skills 管理 | 属于 Codex 平台管理，不属于会话控制条 |
| MCP 状态/资源/工具直调 | MCP 状态只在节点信息卡展示；会话页签不承担 MCP 控制面 |
| realtime/audio、remote-control、environment | 当前无对应产品需求，且部分表面仍处于实验阶段 |

若未来要接入上述能力，应先加入 `CODEX_PROTOCOL_SURFACE`，再补真实生成 Schema 对账、响应契约测试和对应 UI/领域模型；禁止直接在业务代码里新增裸方法字符串。

## 6. 回归防线

发布前至少执行：

```bash
npm run verify:assets
npm run typecheck
npm run lint
node --test --test-concurrency=1 \
  tests/codex-provider.test.cjs \
  tests/provider-permission-modes.test.cjs \
  tests/provider-installation.test.cjs \
  tests/agent-control-bar.test.cjs
npm run build
```

Codex 定向测试覆盖：握手与分页、32 方法清单、实验字段、strict Schema 递归约束、5 类服务端回执、过期审批清理、登录、未登录降级、新线程首轮、steer trace、no-rollout 对账、状态/错误通知和权限策略。

参考：OpenAI Codex App Server 文档与当前运行时 `generate-json-schema --experimental` 产物。运行时 Schema 是具体版本协议兼容性的最终依据。
