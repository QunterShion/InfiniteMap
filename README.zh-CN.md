# InfiniteMap 思维导图工具

[English](./README.md)

InfiniteMap 是一个独立的 VS Code 思维导图编辑器，支持 `.km` 和 `.xmind` 文件。它使用独立的扩展标识、编辑器视图类型、设置命名空间和安装包名称，可与 `vscode-mindmap` 同时安装并按需切换。

## 功能

1. 直接打开 `.km`、`.xmind` 文档。
2. 导入和导出 KM、XMind、Markdown、SVG、文本、JSON、PNG 文件。
3. 按配置的缩放倍数和背景色导出高清图片。
4. 支持 14 种界面语言和自定义图片上传接口。
5. 可从“思路”工具栏重新加载磁盘中的当前文档。
6. 接入 VS Code 原生保存和未保存状态提示。
7. 检测失效的 Webview 消息通道并重新打开编辑器。

## 构建

```bash
npm ci
npm --prefix webui ci
npm --prefix webui run build
npm test
npm run build
```

扩展安装包输出为 `infinite-map-<version>.vsix`。

## 安装

```bash
code --install-extension infinite-map-1.0.0.vsix
```

## 致谢

InfiniteMap 基于 [oorzc/vscode-mindmap](https://github.com/oorzc/vscode-mindmap) 改造，后者源自 [souche/vscode-mindmap](https://github.com/souche/vscode-mindmap)。原项目的许可证声明保留在本仓库中。
