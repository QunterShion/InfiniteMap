# InfiniteMap Custom Editor 生命周期排查

## 当前实现

InfiniteMap 使用 `vscode.CustomEditorProvider`，不是 `CustomTextEditorProvider`，也不是普通
`createWebviewPanel` + `WebviewPanelSerializer`。

- `package.json` 的 `contributes.customEditors[].viewType` 与 `activationEvents` 均为
  `infinite-map.editor`。
- `extension.activate()` 同步调用 `MindEditorProvider.register()`。
- `register()` 同步调用 `vscode.window.registerCustomEditorProvider()`。
- 文档入口是 `openCustomDocument()`，界面入口是 `resolveCustomEditor()`。
- Webview 启动时继续发送兼容旧版本的 `loaded`；Provider 同时接受 `loaded` 和 `ready`。
- 未注册 `registerWebviewPanelSerializer`，也没有 `deserializeWebviewPanel`；Custom Editor 的窗口恢复
  由 VS Code 内部 `CustomEditorInput` 序列化和 Provider resolve 流程负责。

## 场景验证结果

| 场景 | Provider 是否重新调用 | 回调名称 | 是否复用原标签页 | 是否拿到可用 WebviewPanel | 消息监听是否需要重挂 |
| --- | --- | --- | --- | --- | --- |
| `Developer: Reload Window` | 是 | `openCustomDocument`、`resolveCustomEditor` | 是，恢复原 `CustomEditorInput`，不创建新标签 | 是，但为新 Extension Host 中的新 JS 包装对象 | 是 |
| 仅执行 `Developer: Restart Extension Host` | 否；只重新激活并注册 Provider | 仅 `activate`/注册，无 open/resolve | 标签仍在主线程 | 否，扩展拿不到现存面板 | 无法重挂 |
| Extension Host 崩溃后自动重启 | 对已 resolve 的现存标签，预期同上 | 自动重启仅重建 Extension Host；源码未将已 resolve 输入重新入队 | 标签可仍在 | 旧引用失效，新引用未下发 | 无法重挂 |
| 禁用后原地重新启用 | 通常否；若操作要求 Reload Window 则按 Reload 结果 | 原地只重新注册；Reload 才 open/resolve | 条件性 | 条件性 | 条件性 |
| 更新后重新激活 | 若通过 Reload/重启窗口应用更新则是；仅热重启 Extension Host 则否 | 条件性 | 是 | 条件性 | 条件性 |
| 关闭并重新打开 VS Code | 是，前提是窗口/标签被恢复且资源可打开 | `openCustomDocument`、`resolveCustomEditor` | 是 | 是，新对象 | 是 |
| 工作区恢复且 Custom Editor 标签仍存在 | 是 | `openCustomDocument`、`resolveCustomEditor` | 是 | 是，新对象 | 是 |
| Webview 前端重载/崩溃，Extension Host 未重启 | 否 | 无 Provider 回调；前端重新发 `loaded`（Provider 也兼容 `ready`） | 是 | 原扩展侧对象仍可用 | 扩展侧无需；Webview 侧需重建 |

## 核心结论

1. VS Code 在窗口 Reload、应用重启或工作区恢复时，会先恢复/反序列化 Custom Editor 输入，按
   `onCustomEditor:<viewType>` 激活扩展；Provider 注册后会进入 `openCustomDocument` 和
   `resolveCustomEditor`。
2. `resolveCustomEditor` 拿到的是原标签页对应的可用面板，但它是当前 Extension Host 新建的
   `WebviewPanel` JS 包装对象。旧 Extension Host 中的对象引用、监听、Map 和闭包必然失效。
3. 仅重启 Extension Host 是不同路径：现存 `CustomEditorInput` 已经处于 resolved 状态，不会自动进入
   restoration queue。本机实测新 Host 只重新激活并注册 Provider，没有再次 open/resolve。
4. 没有公开 API 可以枚举或找回现存 Custom Editor 的 `WebviewPanel`。`window.tabGroups` 最多只能看见
   Tab/URI；不能取得面板对象。`WebviewPanelSerializer` 只适用于普通 WebviewPanel，不适用于 Custom Editor。
5. `retainContextWhenHidden` 只控制隐藏标签页的 iframe 上下文；不能跨 Extension Host 重启保留扩展侧
   对象引用、`onDidReceiveMessage` 或 `onDidDispose` 监听，也不会强制 VS Code 重新 resolve。
6. 当前代码已经正确处理窗口/工作区恢复和 Webview 前端重载；但公开 API 下无法自行修复
   “仅 Extension Host 重启后没有 Provider 回调”的孤儿面板。此类现象更可能是 VS Code 没有重新触发
   resolve，而不是插件拿到回调后处理失败。

## 空白画布回归根因

同版本 VSIX 覆盖安装时，VS Code 可以替换磁盘上的 Webview 资源而继续运行旧 Extension Host。
旧宿主只处理 `loaded`，诊断构建中的新 Webview 一度只发送 `ready`，导致首次 `import` 永远不会发生，
表现为编辑器框架正常打开但没有任何节点。最终实现恢复 Webview 的 `loaded` 握手，并在扩展端同时接受
`loaded` 和 `ready`，覆盖旧宿主/新资源以及新宿主/旧资源两种混合版本。

## 证据

### 当前代码

- `package.json:29-47`：激活事件和贡献点的 `viewType` 完全一致。
- `src/extension.ts:5-29`：同步注册、成功/失败日志及 deactivate 日志。
- `src/mindEditor.ts:33-70`：Provider 类型和 `registerCustomEditorProvider`。
- `src/mindEditor.ts:111-184`：`openCustomDocument`、`resolveCustomEditor` 入口日志。
- `src/mindEditor.ts:219-234`：面板重新登记及 Webview options。
- `src/mindEditor.ts:268-438`：原地 HTML 重载、监听清理/重挂、`loaded`/`ready`/`reconnected`。
- `src/mindEditor.ts:599-643`：监听注册结果、HTML 决策和面板状态日志。
- `webui/main.js:4-7,104-140`：Webview session ID、`reconnected` 和 `loaded`。

### VS Code 1.129.1 源码

本机版本：`1.129.1`，commit `8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8`。

- [`mainThreadCustomEditors.ts#L125-L134`](https://github.com/microsoft/vscode/blob/8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8/src/vs/workbench/api/browser/mainThreadCustomEditors.ts#L125-L134)：恢复输入先触发 `onCustomEditor:<viewType>`。
- [`mainThreadCustomEditors.ts#L186-L324`](https://github.com/microsoft/vscode/blob/8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8/src/vs/workbench/api/browser/mainThreadCustomEditors.ts#L186-L324)：Provider resolver 创建 handle，并调用扩展侧 `$resolveCustomEditor`。
- [`extHostCustomEditors.ts#L220-L298`](https://github.com/microsoft/vscode/blob/8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8/src/vs/workbench/api/common/extHostCustomEditors.ts#L220-L298)：创建 CustomDocument 和新的 Extension Host `WebviewPanel`，再调用 Provider。
- [`customEditorInputFactory.ts#L59-L113`](https://github.com/microsoft/vscode/blob/8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8/src/vs/workbench/contrib/customEditor/browser/customEditorInputFactory.ts#L59-L113)：窗口恢复反序列化原 Custom Editor 输入。
- [`webviewWorkbenchService.ts#L347-L384`](https://github.com/microsoft/vscode/blob/8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8/src/vs/workbench/contrib/webviewPanel/browser/webviewWorkbenchService.ts#L347-L384)：新 resolver 只处理等待恢复的未 resolve 输入。
- [`extHostWebview.ts#L23-L104`](https://github.com/microsoft/vscode/blob/8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8/src/vs/workbench/api/common/extHostWebview.ts#L23-L104)：新扩展侧 Webview 的 `html` 字段从空字符串开始。
- [`nativeExtensionService.ts#L149-L188`](https://github.com/microsoft/vscode/blob/8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8/src/vs/workbench/services/extensions/electron-browser/nativeExtensionService.ts#L149-L188)：普通本地 Extension Host 崩溃走 `startExtensionHosts()` 自动重启。
- [`nativeExtensionService.ts#L757-L763`](https://github.com/microsoft/vscode/blob/8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8/src/vs/workbench/services/extensions/electron-browser/nativeExtensionService.ts#L757-L763)：显式 Restart Extension Host 也走同一 `startExtensionHosts()` 路径。

### 官方 API

- [Custom Editors API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [`registerCustomEditorProvider`](https://code.visualstudio.com/api/references/vscode-api#window.registerCustomEditorProvider)
- [`CustomEditorProvider`](https://code.visualstudio.com/api/references/vscode-api#CustomEditorProvider)
- [`WebviewPanelOptions.retainContextWhenHidden`](https://code.visualstudio.com/api/references/vscode-api#WebviewPanelOptions)
- [`WebviewPanelSerializer`](https://code.visualstudio.com/api/references/vscode-api#WebviewPanelSerializer)

### 运行日志摘要

以下日志来自只发送 `ready` 的诊断构建，正是本次空白画布回归的复现证据；最终实现在线路上恢复为
`loaded`，Provider 仍保留 `ready` 兼容分支。

`Developer: Reload Window`：

```text
session=3bb53a... resolveCustomEditor panelObjectNew=true htmlLength=0 ready=c603d535...
execute workbench.action.reloadWindow
session=863381... openCustomDocument -> resolveCustomEditor panelObjectNew=true htmlLength=0 ready=0dbeaac8...
```

仅重启 Extension Host：

```text
session=472919... openCustomDocument -> resolveCustomEditor -> ready=8d157c31...
execute workbench.action.restartExtensionHost
session=4dc57a... activate -> providerRegistered
// 等待后仍无 openCustomDocument、resolveCustomEditor 或 ready
```

仅重载 Webview：

```text
session=65e54d... panelId=1 ready=65af8dca...
execute workbench.action.webview.reloadWebviewAction
session=65e54d... panelId=1 ready=c8bb81e2...
// Extension Host 和面板 ID 不变，无 resolveCustomEditor
```

## 实际复现步骤

1. 打开 `.km`，在“输出”中选择 `InfiniteMap Lifecycle`，记录 session ID 和首次 `loaded`。
2. 执行 `Developer: Reload Window`。预期新 session 中依次出现注册、open、resolve、HTML reset、loaded。
3. 执行 `Developer: Restart Extension Host`。当前 VS Code 1.129.1 中预期只有新 session 的注册日志，
   不出现 open/resolve；这是 Extension Host-only 孤儿面板的判据。
4. 执行 `Developer: Reload Webview`。预期 session ID 和 panel ID 不变，出现新的 webview session ID/loaded。
5. 若模拟真实崩溃，终止 Extension Host 进程并观察普通窗口的自动重启；开发宿主可能不自动重启，
   需与生产窗口行为区分。

## 修复建议

1. 保持 Provider 在 `activate()` 内同步注册；将 XMind/WASM 等重初始化继续改为 resolve 后或首次使用时懒加载，
   避免模块顶层异常阻止注册。
2. 每次 `resolveCustomEditor` 都重新登记文档 URI 到面板，并重新设置 Webview options；新包装对象的
   `webview.html` 为空时必须重建 HTML。
3. 每次 resolve 重新挂载 `onDidReceiveMessage`、`onDidDispose`、view-state 和 heartbeat；同一对象再次
   resolve 时先 dispose 旧 binding，避免重复监听。
4. Webview 每次脚本实例启动发送带 `webviewSessionId` 的 `loaded`；扩展同时接受 `ready`，收到任一握手后重新 `import` 当前文档状态。
5. 文档恢复继续依赖 `openContext.backupId` + `backupCustomDocument`；不要只依赖 Webview DOM 状态。
6. 心跳失败只原地重设 HTML，不 `dispose()`，也不调用 `vscode.openWith`，防止重复标签页。
7. 对 Extension Host-only 重启，不要自动 close/reopen 或 `openWith`：公开 API 无法保证不丢失未保存状态。
   可在新 session 注册后发现 `TabInputCustom(viewType)`、但超时未收到任何 resolve 时，提示用户执行
   `Developer: Reload Window`，并把该状态记为 `provider-not-rebound`。
8. 保留激活失败、resolve 异常、reconnect 超时和 HTML reset reason 日志；诊断结束后可设置
   `INFINITEMAP_LIFECYCLE_DEBUG=0` 关闭临时日志。

## 优化实施结果

以上建议已按公开 API 能力边界完成落地：

1. Provider 继续在 `activate()` 中同步注册。XMind parser 和 Resvg/WASM 已改为首次读写 XMind、首次导出
   PNG 时才加载和初始化，模块加载阶段不再读取 WASM 或创建 parser，避免非核心运行时故障阻断 Provider 注册。
2. 每次 `resolveCustomEditor` 继续重新登记 URI/面板、重设 Webview options、清理旧 binding，并重挂消息、
   dispose、view-state 和 heartbeat 监听；空 HTML 会重建，保留 HTML 会先走 reconnect。
3. Webview 启动继续发送带 `webviewSessionId` 的 `loaded`，Provider 同时接受 `ready`，两者都会重新 import
   当前文档状态；刷新 import 继续等待显式 `importResult`。
4. Provider 注册后新增恢复监视器：每次注册及标签变化后等待 5 秒，扫描相同 `viewType` 且当前活动的
   `TabInputCustom`。若活动标签仍存在但当前 Extension Host 没有对应可用面板，则记录
   `provider-not-rebound`，每个 URI 只提示一次，可由用户确认执行 `Developer: Reload Window`；未选中的
   懒恢复标签不会误报，用户选中后会触发新一轮检测。
5. 恢复监视器不会调用 `vscode.openWith`，不会自动关闭、替换或重复打开标签，因此不会主动破坏现存标签
   中可能尚未落盘的状态。公开 API 仍无法直接接管这类孤儿面板。
6. XMind 导入及 Resvg 加载/初始化失败均记录独立生命周期事件；现有激活、resolve、reconnect、HTML reset、
   refresh timeout 日志继续保留。

自动化验证覆盖了孤儿标签检测、单次提示、用户确认后 Reload Window，以及不调用 `vscode.openWith`；完整
测试、typecheck、lint、MCP build、Webpack/VSIX 构建均作为交付校验执行。
