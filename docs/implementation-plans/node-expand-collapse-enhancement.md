# 节点展开/收缩功能增强实现方案

## 需求概述

增强 InfiniteMap 思维导图的节点展开/收缩功能，包括：
1. 在父节点反向侧也增加展开/收缩按钮
2. 支持一键展开/收缩当前节点的所有子层级

## 相关节点

- `dl5s9ze5gfs0` - 父节点反向侧也增加按钮【展开/收缩】
- `dl5saibko7s0` - 点击展开当前节点所有子层级节点/收缩当前节点所有子层级节点
- `dl5sbhm12hk0` - 当前节点的子节点展开时，点击收缩当前节点所有子层级节点
- `dl5sbttm8000` - 当前节点的子节点收起时，点击展开当前节点所有子层级节点

## 技术分析

### 现有代码基础

文件位置：`webui/src/runtime/node.js`

当前代码中存在被注释的展开/收缩功能（第98-118行）：
```javascript
//main.button({
//    position: 'ring',
//    key: '/',
//    action: function(){
//        if (!minder.queryCommandState('expand')) {
//            minder.execCommand('expand');
//        } else if (!minder.queryCommandState('collapse')) {
//            minder.execCommand('collapse');
//        }
//    },
//    ...
//})
```

这表明底层的 `minder` 对象已支持 `expand` 和 `collapse` 命令。

### 实现方案

#### 1. 恢复并增强基础展开/收缩功能

**修改文件**：`webui/src/runtime/node.js`

**步骤**：
1. 取消注释第98-118行的展开/收缩按钮代码
2. 修改按钮的 `position` 属性，支持在父节点反向侧显示
3. 调整按钮的视觉样式和位置

#### 2. 实现递归展开/收缩功能

**新增功能**：
- 当前为收起状态时，点击按钮递归展开所有子孙节点
- 当前为展开状态时，点击按钮递归收缩所有子孙节点

**技术要点**：
```javascript
// 递归展开所有子节点
function expandAll(node) {
  if (node.isExpanded()) return;
  minder.execCommand('expand', node);
  var children = node.getChildren();
  children.forEach(function(child) {
    expandAll(child);
  });
}

// 递归收缩所有子节点
function collapseAll(node) {
  var children = node.getChildren();
  children.forEach(function(child) {
    collapseAll(child);
  });
  if (!node.isExpanded()) return;
  minder.execCommand('collapse', node);
}
```

#### 3. 双侧按钮支持

**需求**：父节点的正面和反向侧都显示展开/收缩按钮

**实现思路**：
- 检查 minder 的渲染模块，了解节点按钮的定位机制
- 可能需要修改节点的 SVG 渲染逻辑
- 为每个父节点渲染两个按钮实例（左右各一个）

**涉及文件**（预计）：
- `webui/src/runtime/node.js` - 按钮逻辑
- 可能需要修改底层的节点渲染模块（需要进一步调研 kityminder-core 的实现）

### 状态检测逻辑

**按钮状态判断**：
```javascript
enable: function() {
  var node = minder.getSelectedNode();
  if (!node) return false;
  var children = node.getChildren();
  return children && children.length > 0;
},
beforeShow: function() {
  var node = minder.getSelectedNode();
  var hasCollapsedChild = false;
  
  function checkExpanded(n) {
    if (!n.isExpanded()) {
      hasCollapsedChild = true;
      return;
    }
    var children = n.getChildren();
    children.forEach(checkExpanded);
  }
  
  checkExpanded(node);
  
  if (hasCollapsedChild) {
    this.$button.children[0].innerHTML = '全部展开';
  } else {
    this.$button.children[0].innerHTML = '全部收起';
  }
}
```

## 实施步骤

1. **第一阶段：基础功能恢复**
   - 取消注释展开/收缩按钮代码
   - 测试基础的单层级展开/收缩是否正常

2. **第二阶段：递归功能实现**
   - 实现 `expandAll()` 和 `collapseAll()` 函数
   - 修改按钮的 action 回调，调用递归函数
   - 实现智能状态检测（展开态 vs 收缩态）

3. **第三阶段：双侧按钮支持**
   - 调研节点渲染机制
   - 实现反向侧按钮的定位和渲染
   - 确保两侧按钮的行为一致

4. **第四阶段：样式优化**
   - 优化按钮的视觉样式
   - 添加动画效果（可选）
   - 确保在不同缩放级别下都正常显示

## 验证标准

1. ✅ 父节点正面显示展开/收缩按钮
2. ✅ 父节点反向侧也显示展开/收缩按钮
3. ✅ 点击按钮能递归展开所有子孙节点
4. ✅ 点击按钮能递归收缩所有子孙节点
5. ✅ 按钮文本/图标能正确反映当前状态
6. ✅ 按钮在叶子节点上不显示或禁用

## 风险与注意事项

1. **性能风险**：大型思维导图（节点数 > 1000）的全量展开可能导致性能问题
   - 建议：添加节点数量限制或分批渲染
   
2. **用户体验**：全量展开/收缩可能导致用户迷失当前位置
   - 建议：展开/收缩后自动调整视图，保持当前节点在可见区域

3. **兼容性**：需要确保与现有的键盘快捷键、上下文菜单等功能不冲突

## 相关资源

- kityminder-core 文档
- `webui/src/runtime/` 目录下的其他运行时模块
- minder 对象的 API 文档（需要查阅 kityminder-core 源码）
