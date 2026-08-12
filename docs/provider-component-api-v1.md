# InfiniteMap Provider Adapter API v1

`ProviderComponentApiV1` is the internal boundary between the InfiniteMap editor and Provider adapters bundled in the same InfiniteMap VSIX. It is not a second-extension distribution protocol. The current catalog contains the built-in Codex, Claude Agent, and Copilot adapters.

## Version and identity

```ts
interface ProviderComponentApiV1 {
  apiVersion: '1';
  getDescriptor(): Promise<ProviderDescriptor>;
  createAdapter(): Promise<AgentSessionAdapter>;
  authenticate?(): Promise<void>;
}
```

API v1 follows additive compatibility: optional descriptor and event payload fields may be added without changing the version. Removing or changing a required method, status, capability, or session field requires a new major API. Consumers ignore unknown additive event fields and reject an unknown `apiVersion`.

The canonical TypeScript contract is `src/sessions/types.ts`. `src/providers/catalog.json` is a reviewed allowlist containing `codex`, `claudecode`, and `copilot`; all three use component identity `chanterxiao.infinite-map`.

## Runtime installation boundary

The InfiniteMap VSIX contains all three adapters and their JavaScript SDK integration code, but no platform-specific Provider executable. When the user confirms installation:

1. `CodexRuntimeInstaller` selects the pinned OpenAI release by OS/architecture, downloads only from `https://github.com/openai/codex/releases/`, validates SHA-256, and installs atomically under `globalStorage/codex/<version>/<platform-arch>/`;
2. `ManagedNpmRuntimeInstaller` selects the pinned official Anthropic or GitHub platform package, downloads its tarball from the npm registry, validates the pinned SHA-512 integrity, and installs atomically under `globalStorage/runtimes/<provider>/<version>/<platform-arch>/`;
3. each installer verifies the executable before the matching built-in adapter starts it; no installer changes the global `PATH`.

The installer never calls `extension.open`, `npm install`, Homebrew, or `curl | sh`; it does not modify the user's global PATH. Build and release produce only `infinite-map-<version>.vsix`, never `infinite-map-provider-*.vsix`.

## Lifecycle contract

`getDescriptor()` and `listModels()` report current runtime/auth/model state. Invalid or expired model/effort selections are rejected, not silently substituted. `createSession()` allocates a Provider session, `send()` starts an idle turn, `append()` follows the declared `inputMode`, `query()` reconciles Provider state, `interrupt()` affects only the current turn, and `dispose()` releases listeners/processes without deleting history.

Every mutation returns or emits enough information to populate `SessionSnapshot`. Event `sequence` values increase within an execution. Duplicate or late Provider events are normalized before forwarding. Unsupported rename/archive/native-open operations are declared truthfully, and `openTargets` contains only destinations backed by a documented stable API.

## Interactive input and approval

Provider approval prompts and user questions are Host-mediated. The adapter emits `session.input.required` with a Provider-unique `requestId`, kind, short title, and minimum display context while keeping the underlying app-server request pending. It must never auto-approve tools, permissions, file changes, commands, elicitation requests, or questions.

Pending input fails closed: timeout, adapter disposal, Provider disconnect, or Extension Host teardown resolves it as denial. Workspace-boundary policy remains authoritative. Unknown, expired, already-resolved, or cross-session request IDs are rejected.

## KM execution boundary

The Host supplies a trusted workspace cwd, InfiniteMap MCP stdio launch command, `executionId`, and initial trace URI. Each adapter injects that MCP server and KM execution instructions into its Provider session. It does not read or write `.km` directly or reproduce claim/batch/revision coordination logic.

Session trace writes use MCP dry-run followed by the actual write. Only KM state determines task completion; structured receipts are display summaries, never authority for KM labels.

## Security and privacy

- Never put tokens, authorization headers, or complete prompts in KM/session sidecars or logs.
- Do not inspect Codex, Claude, or Copilot extensions' private storage, bundled executables, private modules, commands, or undocumented protocols.
- Reject cwd/artifact paths outside the trusted workspace.
- Pin runtime source, version, asset name, and integrity; checksum mismatch is a zero-install failure.
- Keep local history available when any Provider runtime is missing, signed out, incompatible, or disconnected.

## Acceptance

The minimum suite covers managed download and checksum failure, discovery/auth states, dynamic model/effort validation, app-server initialize/account/model pagination, create/resume/read/list, idle send, active/idle append, interrupt, event ordering/deduplication, recovery, interactive approvals, missing/incompatible behavior, single-VSIX archive inspection, and dark/light installation-state UI validation.
