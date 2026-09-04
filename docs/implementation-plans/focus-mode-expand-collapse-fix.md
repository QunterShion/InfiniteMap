# 聚焦模式下节点展开/收缩功能修复方案

## 需求概述

在节点卡片的"聚焦"功能中，当聚焦到某个节点时，需要确保已渲染节点的展开和收缩功能仍然正常工作。

## 相关节点

- `dl5s7t25x1k0` - 节点收缩和展开也需保持支持，检查修复下

## 问题分析

### 聚焦功能的作用

"聚焦"按钮允许用户将视图中心聚焦到特定节点，可能的实现方式包括：
1. **视图平移**：将目标节点移动到画布中心
2. **缩放调整**：调整缩放比例，使节点及其子树适配视口
3. **高亮显示**：高亮当前聚焦的节点
4. **过滤渲染**：只渲染聚焦节点及其相关节点（性能优化）

### 可能的问题原因

根据需求描述"节点收缩和展开也需保持支持，检查修复下"，可能的问题包括：

1. **事件监听失效**
   - 聚焦后重新渲染导致事件监听器丢失
   - 需要重新绑定展开/收缩按钮的事件

2. **状态管理冲突**
   - 聚焦模式可能有独立的状态管理
   - 展开/收缩状态与聚焦状态可能冲突

3. **渲染逻辑问题**
   - 聚焦模式下的渲染逻辑可能忽略了节点的展开/收缩状态
   - 部分节点可能被过滤掉，导致展开/收缩无效

4. **命令执行限制**
   - 聚焦模式下，某些命令可能被禁用
   - `expand` 和 `collapse` 命令的执行条件可能不满足

## 技术方案

### 方案一：确保事件监听器持久化

**问题假设**：聚焦操作会重新渲染节点，导致事件监听器丢失

**解决方案**：
```javascript
// 在聚焦功能中，确保事件监听器重新绑定
function focusNode(node) {
  // 执行聚焦操作
  minder.execCommand('focus', node);
  
  // 重新绑定展开/收缩事件（如果需要）
  rebindNodeEvents();
}

function rebindNodeEvents() {
  var nodes = minder.getAllNodes();
  nodes.forEach(function(node) {
    // 重新绑定展开/收缩按钮的事件
    bindExpandCollapseEvents(node);
  });
}
```

### 方案二：状态同步机制

**问题假设**：聚焦状态与展开/收缩状态不同步

**解决方案**：
```javascript
// 在执行展开/收缩时，保留聚焦状态
minder.on('expand', function(e) {
  var focusedNode = minder.getFocusedNode();
  // 展开操作
  // ...
  // 恢复聚焦状态
  if (focusedNode) {
    maintainFocus(focusedNode);
  }
});

minder.on('collapse', function(e) {
  var focusedNode = minder.getFocusedNode();
  // 收缩操作
  // ...
  // 恢复聚焦状态
  if (focusedNode) {
    maintainFocus(focusedNode);
  }
});
```

### 方案三：修复命令查询状态

**问题假设**：聚焦模式下，展开/收缩命令的 `queryCommandState` 返回 -1（不可用）

**解决方案**：
```javascript
// 修改命令的 queryCommandState 实现
minder.registerCommand('expand', {
  queryState: function() {
    var node = minder.getSelectedNode();
    if (!node) return -1;
    
    // 即使在聚焦模式下，也应该允许展开/收缩
    var isFocusMode = minder.isFocusMode();
    if (isFocusMode) {
      // 检查节点是否在聚焦范围内
      var focusedNode = minder.getFocusedNode();
      if (!isNodeInFocusScope(node, focusedNode)) {
        return -1; // 超出聚焦范围的节点不允许操作
      }
    }
    
    // 检查节点是否有子节点且已收缩
    var children = node.getChildren();
    return (children.length > 0 && !node.isExpanded()) ? 0 : -1;
  },
  execute: function() {
    // 执行展开操作
    // ...
  }
});
```

### 方案四：渲染逻辑优化

**问题假设**：聚焦模式下的渲染逻辑有 bug

**解决方案**：
```javascript
// 确保聚焦模式下，展开/收缩操作触发重新渲染
function onExpandCollapse() {
  var isFocusMode = minder.isFocusMode();
  
  if (isFocusMode) {
    // 聚焦模式下，需要重新计算可见节点范围
    updateFocusScope();
    // 重新渲染
    minder.renderNode();
  }
}

// 监听展开/收缩事件
minder.on('expand', onExpandCollapse);
minder.on('collapse', onExpandCollapse);
```

## 实施步骤

### 1. 问题复现与定位

**步骤**：
1. 打开 InfiniteMap 思维导图
2. 选择一个有子节点的节点
3. 点击"聚焦"按钮
4. 尝试展开/收缩已渲染的节点
5. 观察是否正常工作

**预期问题**：
- 按钮点击无响应
- 按钮显示但被禁用
- 展开/收缩后视图显示异常
- 控制台报错

### 2. 代码审查

**需要审查的文件**：
```
webui/src/runtime/
  ├── node.js           # 节点操作相关
  ├── fsm.js            # 状态机（可能包含聚焦状态）
  └── [其他运行时模块]

webui/ui/directive/
  └── [节点卡片相关指令]
```

**审查重点**：
- 聚焦功能的实现位置
- 展开/收缩命令的定义
- 事件监听器的绑定时机
- 渲染逻辑中的条件判断

### 3. 添加调试日志

```javascript
// 在关键位置添加日志
function focusNode(node) {
  console.log('[Focus] Focusing node:', node.getText());
  // ...
}

function expandNode(node) {
  console.log('[Expand] Expanding node:', node.getText());
  console.log('[Expand] Is focus mode:', minder.isFocusMode());
  // ...
}

function collapseNode(node) {
  console.log('[Collapse] Collapsing node:', node.getText());
  console.log('[Collapse] Is focus mode:', minder.isFocusMode());
  // ...
}
```

### 4. 实施修复

根据定位到的具体问题，应用相应的技术方案：
- 如果是事件监听问题，使用方案一
- 如果是状态同步问题，使用方案二
- 如果是命令状态问题，使用方案三
- 如果是渲染逻辑问题，使用方案四

### 5. 测试验证

**测试场景**：
1. **基础功能测试**
   - 聚焦前：展开/收缩功能正常
   - 聚焦后：展开/收缩功能正常
   
2. **边界情况测试**
   - 聚焦到根节点
   - 聚焦到叶子节点
   - 聚焦到深层节点
   - 连续多次聚焦不同节点
   
3. **交互测试**
   - 聚焦 → 展开 → 取消聚焦
   - 聚焦 → 收缩 → 取消聚焦
   - 聚焦 → 展开子节点 → 再聚焦到子节点
   
4. **性能测试**
   - 大型思维导图（节点数 > 500）
   - 频繁切换展开/收缩
   - 内存泄漏检测

## 验证标准

1. ✅ 聚焦前，节点的展开/收缩功能正常
2. ✅ 聚焦后，已渲染节点的展开/收缩功能正常
3. ✅ 展开/收缩操作不会破坏聚焦状态
4. ✅ 聚焦到展开的节点后，可以收缩其子节点
5. ✅ 聚焦到收缩的节点后，可以展开其子节点
6. ✅ 取消聚焦后，展开/收缩功能仍然正常
7. ✅ 不会出现控制台错误或警告
8. ✅ 性能无明显下降

## 可能的根本原因（需验证）

基于节点路径：
```
生态工具搭建 > InfiniteMap-完成迭代后，自动生成最新 vsix 插件包 > 
界面可视化 > 节点卡片 > 显示信息 > 节点创建时间等信息 > 
【子节点数】 > 点击【聚焦】按钮时，聚焦到当前节点 > 
聚焦时，仍然保持界面功能支持已渲染节点的编辑修改等操作 > 
节点收缩和展开也需保持支持，检查修复下
```

这表明聚焦功能是在"节点卡片"中实现的，是一个相对较新的功能。可能的问题：
1. 聚焦功能实现时，没有考虑与展开/收缩功能的兼容性
2. 聚焦模式可能改变了节点的渲染方式或事件处理方式
3. 可能使用了不同的事件总线或状态管理

## 建议的改进方向

1. **统一状态管理**
   - 将聚焦状态、展开/收缩状态统一管理
   - 避免状态冲突

2. **解耦渲染逻辑**
   - 聚焦逻辑只负责视图变换（平移、缩放）
   - 不应影响节点的交互功能

3. **完善测试用例**
   - 添加聚焦模式下的展开/收缩自动化测试
   - 确保功能回归不被破坏

4. **文档完善**
   - 记录聚焦功能的实现细节
   - 说明与其他功能的交互约束
