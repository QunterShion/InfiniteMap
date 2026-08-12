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
8. Shows read-only KM task status, latest agent session, and paginated local session history in the editor.
9. Exposes 16 InfiniteMap MCP tools, including lease-safe task execution and session tracing.
10. Provides Codex, Claude Agent, and Copilot from the same InfiniteMap extension, installing each pinned official runtime on first use; no Provider/companion VSIX is required.

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

InfiniteMap produces and installs only this VSIX. Its built-in catalog contains Codex, Claude Agent, and Copilot. When the user confirms setup in the editor, the main extension downloads the pinned official runtime for the selected Provider, verifies its published checksum (SHA-256 for Codex; SHA-512 integrity for Claude Agent and Copilot), and installs it under the extension's user-level `globalStorage` directory without changing the global `PATH`. Platform executables are not embedded in the VSIX.

## Acknowledgements

InfiniteMap is derived from [oorzc/vscode-mindmap](https://github.com/oorzc/vscode-mindmap), which is based on [souche/vscode-mindmap](https://github.com/souche/vscode-mindmap). Their original license notices remain in this repository.
