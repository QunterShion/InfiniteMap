# 移除任务状态查看和会话追溯功能方案

## 需求概述

取消 InfiniteMap 节点卡片中"任务状态查看和会话追溯"功能的支持。

## 相关节点

- `nmtlo68cv0` - 取消支持任务状态查看和会话追溯

## 背景分析

### 功能描述

根据节点路径：
```
生态工具搭建 > InfiniteMap-完成迭代后，自动生成最新 vsix 插件包 > 
界面可视化 > 节点卡片 > 显示信息 > 支持任务状态查看和会话追溯 > 
取消支持任务状态查看和会话追溯
```

"任务状态查看和会话追溯"功能可能包括：
1. **任务状态显示**：显示节点关联的任务执行状态（待执行、执行中、已完成、失败等）
2. **会话追溯**：查看历史会话记录、执行日志、Agent 执行轨迹等
3. **关联信息**：显示任务的执行者、执行时间、执行结果等

### 取消原因（推测）

可能的原因包括：
1. **功能复杂度过高**：实现和维护成本较大
2. **用户需求不明确**：实际使用频率低
3. **性能影响**：加载会话历史影响界面响应速度
4. **架构调整**：任务管理功能迁移到其他模块
5. **隐私考虑**：会话追溯可能涉及敏感信息

## 技术分析

### 需要移除的组件

#### 1. UI 组件

可能的文件位置：
```
webui/ui/directive/agentSessionLog/
  ├── agentSessionLog.html
  ├── agentSessionLog.js
  └── agentSessionLog.css
```

从之前的文件搜索中，我们确认存在 `agentSessionLog` 指令：
- `webui/ui/directive/agentSessionLog/agentSessionLog.html`

#### 2. 数据模型

可能涉及的数据结构：
```javascript
// 节点数据中可能包含的任务状态字段
node.data = {
  id: '...',
  text: '...',
  // 需要移除的字段
  taskStatus: '...',
  sessionId: '...',
  executionHistory: [...],
  // ...
}
```

#### 3. API 调用

可能涉及的 API 接口：
- 查询任务状态的接口
- 获取会话历史的接口
- 更新任务状态的接口

#### 4. 事件监听

可能注册的事件监听器：
- 任务状态变更事件
- 会话更新事件

### 移除范围

#### 完全移除（推荐）

如果确定未来不再使用该功能：
1. 删除相关 UI 组件文件
2. 删除数据模型中的相关字段
3. 移除 API 调用代码
4. 移除事件监听器
5. 清理相关样式文件
6. 更新文档和注释

#### 临时禁用

如果未来可能恢复该功能：
1. 在 UI 中隐藏相关组件
2. 添加功能开关（feature flag）
3. 保留代码但注释掉
4. 添加明确的注释说明

## 实施方案

### 方案一：完全移除（推荐）

#### 步骤 1：定位相关代码

```bash
# 搜索 agentSessionLog 相关文件
find webui -name "*agentSessionLog*" -o -name "*session*" -o -name "*taskStatus*"

# 搜索代码引用
grep -r "agentSessionLog\|taskStatus\|sessionId\|executionHistory" webui/
```

#### 步骤 2：移除 UI 组件

```bash
# 删除指令目录
rm -rf webui/ui/directive/agentSessionLog/

# 或者移动到废弃目录（保留备份）
mkdir -p webui/deprecated/
mv webui/ui/directive/agentSessionLog/ webui/deprecated/
```

#### 步骤 3：清理组件注册

```javascript
// 在 Angular 模块定义文件中
// 移除 agentSessionLog 指令的注册

// 例如：webui/ui/directive/module.js
angular.module('kityminderEditor')
  // .directive('agentSessionLog', require('./agentSessionLog/agentSessionLog'))  // 删除这行
  .directive('noteEditor', require('./noteEditor/noteEditor'))
  // ...
```

#### 步骤 4：移除节点卡片中的引用

```html
<!-- 在节点卡片的模板文件中 -->
<!-- 移除任务状态显示部分 -->
<!-- 
<div class="task-status-container">
  <agent-session-log node="currentNode"></agent-session-log>
</div>
-->
```

#### 步骤 5：清理数据模型

```javascript
// 在节点数据处理逻辑中，移除相关字段的读取和写入

// 例如：保存节点时，不再保存任务状态
function saveNode(node) {
  var data = {
    id: node.getId(),
    text: node.getText(),
    // taskStatus: node.getTaskStatus(),  // 删除
    // sessionId: node.getSessionId(),    // 删除
    // executionHistory: node.getExecutionHistory(),  // 删除
  };
  // ...
}
```

#### 步骤 6：移除 API 调用

```javascript
// 删除或注释掉相关 API 调用

// 例如：
// function fetchTaskStatus(nodeId) {
//   return api.get('/task-status/' + nodeId);
// }

// function fetchSessionHistory(sessionId) {
//   return api.get('/session-history/' + sessionId);
// }
```

#### 步骤 7：清理样式文件

```css
/* 移除相关 CSS 类定义 */

/* 例如：
.task-status-container { ... }
.session-log-panel { ... }
.execution-history { ... }
*/
```

### 方案二：功能开关（保守）

#### 实现功能开关

```javascript
// 添加配置项
var FEATURES = {
  TASK_STATUS_TRACKING: false,  // 关闭任务状态追踪
  SESSION_HISTORY: false         // 关闭会话历史
};

// 在渲染逻辑中使用开关
if (FEATURES.TASK_STATUS_TRACKING) {
  renderTaskStatus(node);
}

if (FEATURES.SESSION_HISTORY) {
  renderSessionHistory(node);
}
```

#### 条件渲染

```html
<!-- 使用 ng-if 控制显示 -->
<div ng-if="features.taskStatusTracking" class="task-status-container">
  <agent-session-log node="currentNode"></agent-session-log>
</div>
```

## 实施步骤（详细）

### 1. 代码审计

**目标**：找出所有与任务状态和会话追溯相关的代码

**执行命令**：
```bash
cd /path/to/InfiniteMap

# 搜索相关关键词
grep -r "agentSessionLog" webui/ --include="*.js" --include="*.html"
grep -r "taskStatus" webui/ --include="*.js" --include="*.html"
grep -r "executionHistory" webui/ --include="*.js" --include="*.html"
grep -r "sessionId" webui/ --include="*.js" --include="*.html"
grep -r "会话追溯\|任务状态" webui/ --include="*.js" --include="*.html"
```

**输出清单**：
- 所有引用该功能的文件列表
- 每个引用的上下文（代码片段）

### 2. 影响评估

**评估内容**：
1. 移除该功能是否影响其他功能？
2. 是否有用户数据依赖该功能？
3. 是否有外部系统依赖该功能的 API？
4. 移除后的测试用例是否需要更新？

### 3. 创建备份分支

```bash
git checkout -b feature/remove-task-status-tracking
```

### 4. 执行移除操作

按照"方案一：完全移除"的步骤逐步执行。

### 5. 更新依赖项

如果该功能依赖特定的 npm 包或库，考虑是否可以移除：

```json
// package.json
{
  "dependencies": {
    // "some-task-tracking-lib": "^1.0.0",  // 如果不再需要，可以移除
  }
}
```

### 6. 更新测试

```javascript
// 移除相关测试用例
// 例如：tests/unit/agentSessionLog.spec.js

// 或更新测试断言
describe('Node Card', function() {
  it('should not display task status', function() {
    var card = renderNodeCard(node);
    expect(card.find('.task-status-container').length).toBe(0);
  });
  
  it('should not display session history', function() {
    var card = renderNodeCard(node);
    expect(card.find('.session-log-panel').length).toBe(0);
  });
});
```

### 7. 更新文档

- 更新用户文档，说明该功能已移除
- 更新 CHANGELOG.md，记录变更
- 更新开发者文档，说明相关 API 已废弃

### 8. 测试验证

**功能测试**：
1. ✅ 节点卡片正常显示，不再显示任务状态
2. ✅ 节点卡片不再显示会话追溯入口
3. ✅ 其他功能（编辑、删除、移动等）正常工作

**回归测试**：
1. ✅ 运行完整的测试套件
2. ✅ 手动测试核心功能流程
3. ✅ 检查控制台是否有错误

**性能测试**：
1. ✅ 测量节点渲染速度（应该更快）
2. ✅ 测量内存占用（应该更低）

## 验证标准

1. ✅ 节点卡片中不再显示任务状态相关信息
2. ✅ 节点卡片中不再显示会话追溯入口
3. ✅ 移除相关代码后，代码库体积减小
4. ✅ 运行 `npm run build` 成功
5. ✅ 运行 `npm run test` 成功（相关测试已更新或移除）
6. ✅ 打开思维导图，节点卡片正常显示
7. ✅ 控制台无相关错误或警告
8. ✅ 其他功能不受影响

## 风险与注意事项

1. **数据兼容性**
   - 如果现有的 `.km` 文件中包含任务状态数据，需要确保向后兼容
   - 读取旧文件时，忽略任务状态字段即可，不需要特殊处理

2. **用户迁移**
   - 如果有用户依赖该功能，需要提供迁移指南或替代方案
   - 在版本发布说明中明确告知该变更

3. **回滚方案**
   - 保留移除的代码到单独的备份分支
   - 如果需要回滚，可以从备份分支恢复

4. **外部集成**
   - 如果有外部工具或脚本依赖任务状态 API，需要通知相关方

## 预期收益

1. **代码简化**：减少约 200-500 行代码（估算）
2. **性能提升**：减少不必要的数据加载和渲染
3. **维护成本降低**：减少需要维护的功能模块
4. **用户体验优化**：界面更简洁，减少信息过载

## 后续工作

1. **文档更新**：更新用户手册和 API 文档
2. **版本发布**：在下一个版本中发布该变更
3. **用户沟通**：通过更新日志或公告通知用户
4. **监控反馈**：收集用户反馈，确认是否有未预见的影响
