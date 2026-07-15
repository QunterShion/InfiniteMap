# InfiniteMap

[中文文档](./README.zh-CN.md)

InfiniteMap is a standalone VS Code mind-map editor for `.km` and `.xmind` files. Its extension identity, custom-editor view type, settings namespace, and package name are independent from `vscode-mindmap`, so both extensions can remain installed.

## Features

1. Opens `.km` and `.xmind` documents directly.
2. Imports and exports KM, XMind, Markdown, SVG, text, JSON, and PNG files.
3. Exports high-resolution images with configurable scale and background color.
4. Supports 14 interface languages and configurable image uploads.
5. Reloads the current document from disk from the Idea toolbar.
6. Integrates VS Code save and dirty-document notifications.
7. Detects a stale Webview message channel and reopens the editor.

## Build

```bash
npm ci
npm --prefix webui ci
npm --prefix webui run build
npm test
npm run build
```

The packaged extension is written to `infinite-map-<version>.vsix`.

## Install

```bash
code --install-extension infinite-map-1.0.0.vsix
```

## Acknowledgements

InfiniteMap is derived from [oorzc/vscode-mindmap](https://github.com/oorzc/vscode-mindmap), which is based on [souche/vscode-mindmap](https://github.com/souche/vscode-mindmap). Their original license notices remain in this repository.
