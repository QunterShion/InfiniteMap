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
8. 在编辑器中只读展示 KM 任务状态、最近智能体会话和分页本地会话历史。
9. 提供 16 个 InfiniteMap MCP 工具，覆盖租约安全的任务执行与会话追溯。
10. 同一个 InfiniteMap 扩展内置 Codex、Claude Agent、Copilot，并在首次使用时安装和管理各自固定版本的官方运行时，不需要额外 Provider/companion VSIX。

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

InfiniteMap 只产出并安装这一份 VSIX，内置 catalog 同时包含 Codex、Claude Agent、Copilot。用户在编辑器中确认后，主扩展会下载所选 Provider 的固定版本官方运行时，校验发布清单中的完整性（Codex 使用 SHA-256，Claude Agent 与 Copilot 使用 SHA-512），再安装到扩展自己的用户级 `globalStorage`；不会修改全局 `PATH`，VSIX 本身也不内置任何平台可执行文件。

## 致谢

InfiniteMap 基于 [oorzc/vscode-mindmap](https://github.com/oorzc/vscode-mindmap) 改造，后者源自 [souche/vscode-mindmap](https://github.com/souche/vscode-mindmap)。原项目的许可证声明保留在本仓库中。
