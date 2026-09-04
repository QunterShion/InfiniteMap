# 面包屑文本截断功能实现方案

## 需求概述

在节点卡片的面包屑导航中，当单个节点名称超过 8 个字符时，使用省略号（...）截断显示，避免面包屑过长影响界面布局。

## 相关节点

- `dl5s603j68g0` - 面包屑中单个节点长度超出 8 个字符时，以...指代

## 技术分析

### 面包屑导航的作用

面包屑显示当前节点到根节点的完整路径，帮助用户理解节点在整个思维导图中的位置。格式示例：
```
根节点 > 一级节点 > 二级节点 > 当前节点
```

### 截断需求说明

- **截断阈值**：8 个字符（中文字符按1个计算，英文字符按1个计算）
- **截断方式**：超出部分用 `...` 替代
- **示例**：
  - "这是一个很长的节点名称" → "这是一个很长..."
  - "Short" → "Short"（不截断）
  - "12345678" → "12345678"（临界值，不截断）
  - "123456789" → "12345..."（超出，截断）

### 实现方案

#### 方案一：CSS 截断（推荐）

**优点**：
- 实现简单，性能好
- 浏览器原生支持
- 自动适配不同字体宽度

**实现代码**：
```css
.breadcrumb-item {
  display: inline-block;
  max-width: 8em; /* 8个字符宽度 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
```

**注意事项**：
- 需要确保面包屑的每个节点项都应用该 CSS 类
- `8em` 是基于字体大小的相对单位，更精确的方式是使用 `ch` 单位（字符宽度）

#### 方案二：JavaScript 字符串截断

**优点**：
- 精确控制字符数量
- 可以自定义截断规则（如中文2字符，英文1字符）

**实现代码**：
```javascript
function truncateText(text, maxLength) {
  if (!text) return '';
  
  // 计算实际显示长度（中英文混合）
  var length = 0;
  var result = '';
  
  for (var i = 0; i < text.length; i++) {
    var char = text[i];
    // 中文字符范围判断
    var isChinese = /[一-龥]/.test(char);
    length += isChinese ? 1 : 1; // 可调整中文权重
    
    if (length > maxLength) {
      return result + '...';
    }
    result += char;
  }
  
  return result;
}

// 使用示例
var breadcrumbText = truncateText(node.getText(), 8);
```

**更精确的中英文混合截断**：
```javascript
function truncateText(text, maxLength) {
  if (!text) return '';
  
  var actualLength = 0;
  var result = '';
  
  for (var i = 0; i < text.length; i++) {
    var char = text[i];
    var charCode = char.charCodeAt(0);
    
    // 判断字符宽度：中文、全角符号算2，其他算1
    var charWidth = (charCode >= 0x4e00 && charCode <= 0x9fa5) || 
                    (charCode >= 0xff00 && charCode <= 0xffef) ? 2 : 1;
    
    if (actualLength + charWidth > maxLength) {
      return result + '...';
    }
    
    actualLength += charWidth;
    result += char;
  }
  
  return result;
}
```

#### 方案三：混合方案（推荐）

结合 CSS 和 JavaScript：
- 使用 JavaScript 预处理文本，精确截断到 8 个字符
- 使用 CSS `text-overflow: ellipsis` 作为降级方案
- 添加 `title` 属性显示完整文本（鼠标悬停提示）

```javascript
// 渲染面包屑节点时
function renderBreadcrumbItem(node) {
  var fullText = node.getText();
  var displayText = truncateText(fullText, 8);
  
  return {
    text: displayText,
    title: fullText, // 完整文本用于 tooltip
    fullText: fullText
  };
}
```

### 涉及文件

需要定位面包屑渲染的相关代码，可能位于：
- `webui/ui/directive/` 目录下的某个指令组件
- 或者在节点卡片的渲染逻辑中

**查找步骤**：
1. 搜索关键词：`breadcrumb`、`面包屑`、`path`、`层级`
2. 检查节点卡片相关的 HTML 模板文件
3. 查看 Angular 指令定义（如果使用 AngularJS）

## 实施步骤

1. **定位代码位置**
   - 搜索面包屑相关的渲染代码
   - 确认面包屑数据的来源和格式

2. **实现文本截断函数**
   - 创建通用的文本截断工具函数
   - 支持配置截断长度（默认 8）
   - 添加单元测试

3. **应用到面包屑渲染**
   - 在面包屑渲染逻辑中调用截断函数
   - 为每个面包屑项添加 `title` 属性
   - 确保分隔符（如 `>`）不被截断

4. **样式优化**
   - 添加 CSS 类确保截断后的文本正常显示
   - 测试不同长度的节点名称
   - 确保面包屑的整体布局不受影响

5. **测试验证**
   - 测试中文节点名称
   - 测试英文节点名称
   - 测试中英文混合
   - 测试特殊字符（emoji 等）
   - 测试边界值（7、8、9 字符）

## 验证标准

1. ✅ 节点名称 ≤ 8 字符时，完整显示
2. ✅ 节点名称 > 8 字符时，截断并显示 `...`
3. ✅ 鼠标悬停在截断的节点上时，通过 tooltip 显示完整名称
4. ✅ 面包屑的分隔符（`>`）正常显示，不被截断
5. ✅ 截断不影响面包屑的点击跳转功能
6. ✅ 在不同屏幕尺寸下都正常显示

## 示例数据测试

```javascript
// 测试用例
var testCases = [
  { input: '短名', expected: '短名' },
  { input: '12345678', expected: '12345678' },
  { input: '123456789', expected: '12345...' },
  { input: '这是一个很长的节点名称', expected: '这是一个很长...' },
  { input: 'VeryLongNodeNameExample', expected: 'VeryLon...' },
  { input: '中English混合Test', expected: '中Englis...' },
  { input: '根节点', expected: '根节点' }
];
```

## 注意事项

1. **字符计数方式**：
   - 简单方案：所有字符都算 1 个单位
   - 复杂方案：中文算 2 个单位，英文算 1 个单位
   - 建议采用简单方案，因为需求中说"8 个字符"

2. **截断位置**：
   - 前 5 个字符 + `...` 的方式可能更美观
   - 或者前 7 个字符 + `...`
   - 需要根据实际效果调整

3. **Emoji 处理**：
   - Emoji 字符可能占用 2 个 UTF-16 编码单元
   - 需要正确处理，避免截断到 emoji 中间

4. **性能考虑**：
   - 如果面包屑项很多（深层嵌套），截断操作应该高效
   - 考虑缓存截断结果，避免重复计算

## 扩展建议

1. **可配置化**：将截断长度（8）作为配置项，方便后续调整
2. **国际化**：不同语言可能需要不同的截断长度
3. **响应式**：在小屏幕设备上，可能需要更短的截断长度
