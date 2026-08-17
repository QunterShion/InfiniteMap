# InfiniteMap 会话响应跟踪交互优化

## 问题分析

### 现象
用户发送会话后，只能看到时不时返回的审批请求，看不到会话内容（AI 回复、工具执行过程等）。

### 根本原因
前端事件处理不完整，只处理了部分事件类型：

**已处理的事件：**
- ✅ `session.input.required` - 审批请求
- ✅ `session.state.changed` - 状态变化
- ✅ `session.completed` - 会话完成

**缺失处理的关键事件：**
- ❌ `session.delta` - AI 回复增量（最重要）
- ❌ `session.tool.started` - 工具开始执行
- ❌ `session.tool.completed` - 工具执行完成

## 交互流程梳理

### 1. 后端事件发射链路

```
CodexAgentSessionAdapter (或其他 Provider Adapter)
  ↓ 监听 RPC 通知
  ↓ handleNotification()
  ↓ 根据 notification.method 发射事件
  ↓
SessionOrchestrator
  ↓ onDidEvent 转发
  ↓
AgentControlBarCoordinator
  ↓ 订阅 orchestrator.onDidEvent
  ↓ panel.webview.postMessage() 发送到前端
  ↓
前端 agentSessionService
  ↓ window.addEventListener('message')
  ↓ $rootScope.$broadcast('agent-session-event')
  ↓
UI 组件监听并展示
```

### 2. 事件类型映射

**后端发送（CodexAgentSessionAdapter.ts）：**

| RPC Method | 发射事件类型 | 用途 |
|-----------|------------|------|
| `item/agentMessage/delta` | `session.delta` | AI 回复文本增量 |
| `item/commandExecution/outputDelta` | `session.delta` | 工具输出增量 |
| `item/started` | `session.tool.started` | 工具开始执行 |
| `item/completed` | `session.tool.completed` | 工具执行完成 |
| `turn/diff/updated` | `session.tool.completed` | diff 更新 |
| `thread/status/changed` | `session.state.changed` | 状态变化 |
| `turn/completed` | `session.completed` | 回合完成 |
| `user/input/required` | `session.input.required` | 需要用户输入/审批 |

**前端原有处理（agentControlBar.directive.js）：**

```javascript
scope.$on('agent-session-event', function(_event, value) {
    // 只处理了 3 种事件
    if (value.type === 'session.input.required') { ... }     // 审批请求
    if (value.type === 'session.state.changed') { ... }       // 状态变化  
    if (value.type === 'session.completed') { ... }           // 完成
    
    // ❌ session.delta、session.tool.* 都没有处理
});
```

## 优化方案

### 新增组件：agentSessionLog

创建一个独立的会话日志面板，实时展示所有会话事件。

#### 功能特性

1. **实时流式显示**
   - AI 回复增量渲染（100ms 节流）
   - 类打字机效果，带闪烁光标

2. **完整事件覆盖**
   - 💬 AI 消息
   - 🔧 工具开始
   - ✅ 工具完成
   - ❌ 工具失败
   - 🔄 状态变化
   - ⚠️ 错误提示

3. **交互功能**
   - 折叠/展开面板
   - 自动滚动开关
   - 清空日志
   - 事件计数徽章

4. **UI/UX 优化**
   - 渐变紫色主题
   - 不同事件类型颜色区分
   - 滑入动画
   - 响应式适配（移动端）
   - 暗色模式支持

#### 实现细节

**核心事件处理逻辑：**

```javascript
scope.$on('agent-session-event', function(_event, value) {
    switch (value.type) {
        case 'session.delta':
            // 提取增量文本并追加
            var text = payload.delta?.text || payload.outputDelta;
            appendDelta(text);  // 带节流的增量追加
            break;
            
        case 'session.tool.started':
            finalizeDelta();  // 完成当前流式输出
            addEntry('tool-started', '工具执行: ' + tool.name);
            break;
            
        case 'session.tool.completed':
            addEntry('tool-completed', '工具完成: ' + tool.name);
            break;
            
        // ... 其他事件
    }
});
```

**增量渲染优化：**

- 使用 100ms 节流避免频繁 DOM 更新
- 缓冲区累积增量文本
- 超时自动刷新到 UI

#### 文件清单

新增文件：
1. `webui/ui/directive/agentSessionLog/agentSessionLog.directive.js` - 指令逻辑（213 行）
2. `webui/ui/directive/agentSessionLog/agentSessionLog.html` - HTML 模板
3. `webui/less/agentSessionLog.less` - LESS 样式

修改文件：
1. `webui/ui/directive/kityminderEditor/kityminderEditor.html` - 添加组件引用
2. `webui/less/editor.less` - 导入新样式

### 集成方式

#### 1. 模板集成

```html
<!-- kityminderEditor.html -->
<div class="agent-control-bar" agent-control-bar ng-if="minder"></div>
<div class="agent-session-log" agent-session-log ng-if="minder"></div>
```

#### 2. 构建配置

Grunt 自动处理：
- `ngtemplates` 任务自动扫描 `ui/directive/**/*.html`
- `concat` 任务自动包含 `.tmp/scripts/directive/**/*.js`
- `less` 任务编译 `less/editor.less`（已导入 agentSessionLog.less）

无需修改 Gruntfile.js。

## 使用效果

### 会话启动后

```
📋 会话日志 [12]                    [📌] [🗑️] [▼]
─────────────────────────────────────────────────
💬 14:23:45  正在分析您的需求...
🔧 14:23:46  工具执行: read_file
✅ 14:23:47  工具完成: read_file
💬 14:23:48  根据文件内容，我建议...▊
```

### 审批请求时

```
💬 14:24:10  我需要修改 config.json
🔄 14:24:11  等待审批: 需要用户确认文件写入
```

### 完整会话

用户可以：
- 看到完整的 AI 思考过程
- 了解每个工具的执行时机
- 追踪错误发生的位置
- 回顾整个会话历史

## 性能优化

1. **增量渲染节流** - 100ms 批处理，避免高频更新
2. **日志条目上限** - 最多保留 500 条，防止内存泄漏
3. **去重机制** - 使用 eventId 防止重复事件
4. **懒加载** - 只在会话运行时显示面板

## 后续增强建议

1. **导出功能** - 支持导出会话日志为文本/JSON
2. **搜索过滤** - 按事件类型、关键词过滤
3. **时间线视图** - 可视化时间轴展示
4. **性能监控** - 显示每个工具的执行耗时
5. **多会话支持** - 切换查看不同节点的会话日志

## 验证方法

### 构建测试

```bash
cd /Users/chanterxiao/LLMAgentGateway/Workspace/openSource/InfiniteMap/webui
npm run build
```

### 运行时测试

1. 启动扩展，打开 .km 文件
2. 发送一个会话请求
3. 观察右下角会话日志面板
4. 验证：
   - ✅ AI 回复逐字显示
   - ✅ 工具执行过程可见
   - ✅ 审批请求正常弹出
   - ✅ 状态变化有提示

## 总结

**问题根源**：前端事件处理不完整，只监听了审批请求，忽略了会话内容事件。

**解决方案**：新增 `agentSessionLog` 组件，完整覆盖所有会话事件类型，提供实时流式展示。

**核心价值**：
- ✅ 用户可见 AI 完整思考过程
- ✅ 工具执行透明化
- ✅ 问题排查更容易
- ✅ 用户体验显著提升

## 参考资料

- 后端事件发射：`src/providers/codex/CodexAgentSessionAdapter.ts` (第 440-586 行)
- 前端事件转发：`src/sessions/agentControlBarCoordinator.ts` (第 39-52 行)
- 原有事件处理：`webui/ui/directive/agentControlBar/agentControlBar.directive.js` (第 408-421 行)
- 事件协议定义：`src/sessions/types.ts`
