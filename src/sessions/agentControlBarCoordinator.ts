import * as path from 'path';
import * as vscode from 'vscode';
import { DocumentState } from '../editor/MindEditorDocument';
import { KmMcpClient } from '../mcpClient/kmMcpClient';
import { ProviderComponentRegistry } from '../providers/providerComponentRegistry';
import { buildUserTurn } from './buildUserTurn';
import { AgentSessionRequest, AgentSessionResult } from './protocol';
import { SessionOrchestrator } from './sessionOrchestrator';
import { AGENT_SESSION_PROTOCOL_VERSION, AgentSessionErrorCode } from './types';

const MAX_INPUT_LENGTH = 64 * 1024;

export class AgentControlBarCoordinator implements vscode.Disposable {
	private readonly extensionPath: string;
	private readonly providers: ProviderComponentRegistry;
	private readonly mcpClients = new Set<KmMcpClient>();
	private readonly orchestrator: SessionOrchestrator;
	private readonly panels = new Map<string, vscode.WebviewPanel>();
	private readonly panelOwners = new Map<string, vscode.CustomDocument>();
	private readonly eventSubscription: vscode.Disposable;
	private readonly providerChangeSubscription: vscode.Disposable; // Main-P1-02

	constructor(
		context: vscode.ExtensionContext,
		providers?: ProviderComponentRegistry
	) {
		this.extensionPath = context.extensionPath;
		const getConfiguration = (vscode.workspace as any).getConfiguration as
			| ((section: string) => { get<T>(key: string, defaultValue: T): T })
			| undefined;
		const configuration = getConfiguration?.('infiniteMap.codex');
		this.providers = providers || new ProviderComponentRegistry({
			storagePath: context.globalStorageUri?.fsPath || path.join(context.extensionPath, '.infinite-map-storage'),
			secretStorage: context.secrets,
			explicitCodexExecutable: configuration?.get<string>('executable', '') || '',
		});
		this.orchestrator = new SessionOrchestrator(this.providers);
		this.eventSubscription = this.orchestrator.onDidEvent((event) => {
			const panel = this.panels.get(event.documentKey);
			if (!panel) {
				return;
			}
			void panel.webview.postMessage({
				command: 'agentSessionEvent',
				protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
				executionId: event.executionId,
				sequence: event.sequence,
				type: event.type,
				payload: event.payload,
			});
		});
		// Main-P1-02：订阅 provider 状态变更，将最新 provider 列表广播到所有已注册 Webview
		this.providerChangeSubscription = this.providers.onDidChange(() => {
			void (async () => {
				try {
					const providers = await this.orchestrator.discover();
					for (const [documentKey, panel] of this.panels) {
						void (panel.webview.postMessage({
							command: 'agentSessionSnapshot',
							protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
							providers,
							session: this.orchestrator.getSnapshot(documentKey),
						}) as Promise<boolean>).catch(() => undefined);
					}
				} catch {
					// provider 枚举失败时静默忽略，不影响主流程
				}
			})();
		});
	}

	public bind(document: vscode.CustomDocument, panel: vscode.WebviewPanel): vscode.Disposable {
		const documentKey = document.uri.toString();
		this.panels.set(documentKey, panel);
		this.panelOwners.set(documentKey, document);
		return {
			dispose: () => {
				if (this.panels.get(documentKey) === panel && this.panelOwners.get(documentKey) === document) {
					this.panels.delete(documentKey);
					this.panelOwners.delete(documentKey);
				}
			},
		};
	}

	public async broadcastSnapshot(
		document: vscode.CustomDocument,
		panel: vscode.WebviewPanel,
		documentState: DocumentState
	): Promise<void> {
		try {
			if (!this.orchestrator.getSnapshot(document.uri.toString())) {
				await this.recoverLatestSession(document);
			}
			await panel.webview.postMessage({
				command: 'agentSessionSnapshot',
				protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
				providers: await this.orchestrator.discover(),
				session: this.orchestrator.getSnapshot(document.uri.toString()),
				document: {
					dirty: documentState.dirty,
					conflict: documentState.externalConflict,
				},
			});
		} catch {
			// A disposed Webview is allowed to miss a best-effort recovery snapshot.
		}
	}

	private async recoverLatestSession(document: vscode.CustomDocument): Promise<void> {
		try {
			const workspace = this.requireTrustedWorkspace(document);
			const page = await this.callKmTool(document, 'km_list_node_sessions', {
				filePath: document.uri.fsPath,
				limit: 100,
			}) as { sessions?: Array<{
				executionId: string;
				status: import('./types').NodeExecutionStatus;
				session: import('./types').AgentSessionRef;
					requestedConfig?: import('./types').SessionConfiguration;
					effectiveConfig?: import('./types').SessionConfiguration;
				updatedAt: string;
			}> };
			const candidate = (page.sessions || []).find((record) =>
				['allocated', 'starting', 'running', 'idle', 'interrupting', 'disconnected'].includes(record.status)
			);
			if (candidate) {
				await this.orchestrator.recover({
					documentKey: document.uri.toString(),
					executionId: candidate.executionId,
					status: candidate.status,
					session: candidate.session,
					requestedConfig: candidate.requestedConfig,
					effectiveConfig: candidate.effectiveConfig,
					updatedAt: candidate.updatedAt,
					workingDirectory: workspace.uri.fsPath,
					mcpServer: this.mcpServerLaunch(),
				});
			}
		} catch {
			// History and Provider recovery are best effort; normal editing remains available.
		}
	}

	private async findSessionRecord(
		document: vscode.CustomDocument,
		executionId: string,
		nodeId?: string
	): Promise<{
		executionId: string;
		nodeId?: string;
		status: import('./types').NodeExecutionStatus;
		session: import('./types').AgentSessionRef;
		requestedConfig?: import('./types').SessionConfiguration;
		effectiveConfig?: import('./types').SessionConfiguration;
		updatedAt: string;
		summary?: string;
		artifacts?: unknown[];
		error?: unknown;
	} | undefined> {
		let cursor: string | undefined;
		do {
			const page = await this.callKmTool(document, 'km_list_node_sessions', {
				filePath: document.uri.fsPath,
				...(nodeId ? { nodeId } : {}),
				...(cursor ? { cursor } : {}),
				limit: 100,
			}) as {
				sessions?: Array<{
					executionId: string;
					nodeId?: string;
					status: import('./types').NodeExecutionStatus;
					session: import('./types').AgentSessionRef;
					requestedConfig?: import('./types').SessionConfiguration;
					effectiveConfig?: import('./types').SessionConfiguration;
					updatedAt: string;
					summary?: string;
					artifacts?: unknown[];
					error?: unknown;
				}>;
				nextCursor?: string | null;
			};
			const match = (page.sessions || []).find((candidate) => candidate.executionId === executionId);
			if (match) {
				return match;
			}
			cursor = page.nextCursor || undefined;
		} while (cursor);
		return undefined;
	}

	public async handle(
		request: AgentSessionRequest,
		document: vscode.CustomDocument,
		panel: vscode.WebviewPanel,
		documentState: DocumentState
	): Promise<void> {
		let response: AgentSessionResult;
		try {
			this.assertDocumentOwner(request, document, panel);
			const documentKey = document.uri.toString();
			switch (request.operation) {
				case 'discoverProviders':
					response = this.success(request, {
						providers: await this.orchestrator.discover(),
						session: this.orchestrator.getSnapshot(documentKey),
						document: {
							dirty: documentState.dirty,
							conflict: documentState.externalConflict,
						},
					});
					break;
				case 'installProvider':
					response = this.success(request, {
						installation: await this.installProvider(request, panel),
					});
					break;
				case 'authenticateProvider': {
					const component = await this.providers.load(this.requireProviderId(request));
					if (!component.authenticate) {
						throw this.error('CAPABILITY_UNAVAILABLE', 'Provider does not expose an authentication entry point.', false);
					}
					await component.authenticate();
					response = this.success(request, { authenticated: true });
					break;
				}
				case 'loadProvider':
				case 'listModels': {
					const providerId = this.requireProviderId(request);
					const component = await this.providers.load(providerId);
					const descriptor = await component.getDescriptor();
					const models = request.operation === 'listModels'
						&& descriptor.installState !== 'auth_required'
						? await this.orchestrator.listModels(providerId)
						: descriptor.models;
					const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
					const permissionModes = descriptor.installState !== 'auth_required'
						? await this.orchestrator.listPermissionModes(providerId, workspace?.uri.fsPath)
						: descriptor.permissionModes;
					response = this.success(request, {
						descriptor: { ...descriptor, permissionModes },
						models,
						permissionModes,
					});
					break;
				}
				case 'send': {
					this.assertSendableDocument(document, documentState);
					const providerId = this.requireProviderId(request);
					const modelId = this.requireModelId(request);
					const workspace = this.requireTrustedWorkspace(document);
					const message = this.buildTrustedMessage(request, document);
					const snapshot = await this.orchestrator.send({
						documentKey,
						providerId,
						workingDirectory: workspace.uri.fsPath,
						mapPath: this.relativeMapPath(workspace, document),
						nodeId: request.nodeId,
						mcpServer: this.mcpServerLaunch(),
						message,
						modelId,
						effort: request.effort,
						permissionModeId: request.permissionModeId,
						idempotencyKey: request.idempotencyKey || request.requestId,
					});
					response = this.success(request, { session: snapshot });
					break;
				}
				case 'append': {
					this.assertSendableDocument(document, documentState);
					const providerId = this.requireProviderId(request);
					const modelId = this.requireModelId(request);
					const workspace = this.requireTrustedWorkspace(document);
					const message = this.buildTrustedMessage(request, document);
					const snapshot = await this.orchestrator.append({
						documentKey,
						providerId,
						workingDirectory: workspace.uri.fsPath,
						mapPath: this.relativeMapPath(workspace, document),
						nodeId: request.nodeId,
						mcpServer: this.mcpServerLaunch(),
						message,
						modelId,
						effort: request.effort,
						permissionModeId: request.permissionModeId,
						idempotencyKey: request.idempotencyKey || request.requestId,
						expectedTurnId: request.expectedTurnId,
					});
					response = this.success(request, { session: snapshot });
					break;
				}
				case 'interrupt':
					response = this.success(request, {
						session: await this.orchestrator.interrupt(documentKey, request.expectedTurnId),
					});
					break;
					case 'querySession':
						response = this.success(request, { session: await this.orchestrator.query(documentKey) });
						break;
					case 'querySessionDetail': {
						if (!request.executionId) {
							throw this.error('INTERNAL_ERROR', 'An executionId is required to read session detail.', false);
						}
						const live = this.orchestrator.getSnapshot(documentKey);
						if (live?.executionId === request.executionId) {
							response = this.success(request, { session: live });
							break;
						}
						const record = await this.findSessionRecord(document, request.executionId, request.nodeId);
						if (!record) {
							throw this.error('NO_ACTIVE_SESSION', `Session history was not found: ${request.executionId}`, false);
						}
						const workspace = this.requireTrustedWorkspace(document);
						const providerSnapshot = await this.orchestrator.readSessionDetail({
							executionId: record.executionId,
							session: record.session,
							workingDirectory: workspace.uri.fsPath,
							mcpServer: this.mcpServerLaunch(),
						});
						response = this.success(request, {
							session: {
								...record,
								...providerSnapshot,
								session: { ...record.session, ...providerSnapshot.session },
							},
						});
						break;
					}
				case 'resolveInput':
					if (!request.inputRequestId || !request.decision) {
						throw this.error('CAPABILITY_UNAVAILABLE', 'A pending input request and decision are required.', false);
					}
					await this.orchestrator.resolveInput(
						documentKey,
						request.inputRequestId,
						request.decision,
						request.inputValue
					);
					response = this.success(request, { resolved: true });
					break;
				case 'updateSession':
					if (!request.mutation) {
						throw this.error('CAPABILITY_UNAVAILABLE', 'A supported session mutation is required.', false);
					}
					response = this.success(request, {
						session: await this.orchestrator.mutate(documentKey, request.mutation, request.value),
					});
					break;
				case 'queryHistory':
					response = this.success(
						request,
						await this.callKmTool(document, 'km_list_node_sessions', {
							filePath: document.uri.fsPath,
							...(request.nodeId ? { nodeId: request.nodeId } : {}),
							...(request.cursor ? { cursor: request.cursor } : {}),
							...(request.limit ? { limit: request.limit } : {}),
						})
					);
					break;
				case 'reconnectMcp': {
					const client = this.getKmClient(document);
					await client.reconnect();
					response = this.success(request, { connection: client.status });
					break;
				}
				case 'openSession': {
					if (!request.nodeId) {
						throw this.error('INTERNAL_ERROR', 'A nodeId is required to open session history.', false);
					}
					const history = await this.callKmTool(document, 'km_list_node_sessions', {
						filePath: document.uri.fsPath,
						nodeId: request.nodeId,
					});
					if (request.target && request.target !== 'infinite-map') {
						await this.orchestrator.open(documentKey, request.target);
					}
					response = this.success(request, { history, executionId: request.executionId });
					break;
				}
				default:
					throw this.error('CAPABILITY_UNAVAILABLE', 'Unsupported agent-session operation.', false);
			}
		} catch (error) {
			response = this.failure(request, error);
		}
		await panel.webview.postMessage(response);
	}

	public dispose(): void {
		this.eventSubscription.dispose();
		this.providerChangeSubscription.dispose(); // Main-P1-02
		this.orchestrator.dispose();
		this.providers.dispose();
		for (const client of this.mcpClients) {
			void client.dispose();
		}
		this.mcpClients.clear();
		this.panels.clear();
		this.panelOwners.clear();
	}

	private async installProvider(
		request: AgentSessionRequest,
		panel: vscode.WebviewPanel
	): Promise<import('./types').ProviderInstallationResult> {
		const providerId = this.requireProviderId(request);
		const report = async (phase: import('./types').ProviderInstallPhase): Promise<void> => {
			await panel.webview.postMessage({
				command: 'agentProviderInstallProgress',
				protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
				requestId: request.requestId,
				providerId,
				phase,
			});
		};
		try {
			const installation = await this.providers.openInstallation(providerId, (phase) => {
				void report(phase).catch(() => undefined);
			});
			await report('completed');
			return installation;
		} catch (error) {
			const detail = error as Error & { code?: string };
			const failure = detail.code
				? error
				: this.error('PROVIDER_INSTALL_FAILED', detail.message || String(error), true);
			if (detail.code === 'PROVIDER_INSTALL_FAILED') {
				(detail as Error & { retryable?: boolean }).retryable = true;
			}
			const normalized = this.failure(request, failure).error;
			await panel.webview.postMessage({
				command: 'agentProviderInstallProgress',
				protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
				requestId: request.requestId,
				providerId,
				phase: 'failed',
				error: normalized,
			});
			throw failure;
		}
	}

	private async callKmTool(
		document: vscode.CustomDocument,
		name: string,
		args: Record<string, unknown>
	): Promise<unknown> {
		const client = this.getKmClient(document);
		try {
			const raw = await client.callTool({ name, arguments: args });
			return this.parseToolResult(raw);
		} catch (error) {
			throw this.error('MCP_UNAVAILABLE', error instanceof Error ? error.message : String(error), true);
		}
	}

	private getKmClient(document: vscode.CustomDocument): KmMcpClient {
		const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
		const workspaceKey = workspace ? workspace.uri.toString() : path.dirname(document.uri.fsPath);
		const client = KmMcpClient.forWorkspace(workspaceKey, { extensionPath: this.extensionPath });
		this.mcpClients.add(client);
		return client;
	}

	private parseToolResult(raw: unknown): unknown {
		const result = raw as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
		const text = result?.content?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
		if (!text) {
			return raw;
		}
		try {
			return JSON.parse(text);
		} catch {
			return { text };
		}
	}

	private buildTrustedMessage(request: AgentSessionRequest, document: vscode.CustomDocument): string {
		const input = request.input || '';
		if (input.length > MAX_INPUT_LENGTH) {
			throw this.error('CAPABILITY_UNAVAILABLE', 'Agent-session input exceeds 64 KiB.', false);
		}
		return buildUserTurn(input, document.uri.fsPath);
	}

	private assertSendableDocument(document: vscode.CustomDocument, state: DocumentState): void {
		if (state.dirty || state.externalConflict) {
			throw this.error('DOCUMENT_DIRTY', 'Save or resolve the current mind map before sending.', true);
		}
		if (document.uri.scheme !== 'file' || path.extname(document.uri.fsPath).toLowerCase() !== '.km') {
			throw this.error('CAPABILITY_UNAVAILABLE', 'Agent task execution requires a local .km document.', false);
		}
	}

	private requireTrustedWorkspace(document: vscode.CustomDocument): vscode.WorkspaceFolder {
		if (vscode.workspace.isTrusted === false) {
			throw this.error('CAPABILITY_UNAVAILABLE', 'Agent task execution is disabled in an untrusted workspace.', false);
		}
		const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
		if (!workspace || workspace.uri.scheme !== 'file') {
			throw this.error('CAPABILITY_UNAVAILABLE', 'The mind map must be inside a trusted local workspace.', false);
		}
		return workspace;
	}

	private relativeMapPath(workspace: vscode.WorkspaceFolder, document: vscode.CustomDocument): string {
		const relative = path.relative(workspace.uri.fsPath, document.uri.fsPath);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			throw this.error('CAPABILITY_UNAVAILABLE', 'The mind map path is outside the trusted workspace.', false);
		}
		return relative;
	}

	private mcpServerLaunch(): { command: string; args: string[] } {
		return {
			command: process.execPath,
			args: [path.join(this.extensionPath, 'dist', 'mcp', 'server.js')],
		};
	}

	private assertDocumentOwner(
		request: AgentSessionRequest,
		document: vscode.CustomDocument,
		panel: vscode.WebviewPanel
	): void {
		const documentKey = document.uri.toString();
		if (request.documentUri !== documentKey
			|| this.panels.get(documentKey) !== panel
			|| this.panelOwners.get(documentKey) !== document) {
			throw this.error('INTERNAL_ERROR', 'The request does not belong to the active document owner.', false);
		}
		if (document.uri.scheme !== 'file' || path.extname(document.uri.fsPath).toLowerCase() !== '.km') {
			throw this.error('CAPABILITY_UNAVAILABLE', 'Agent task execution requires a local .km document.', false);
		}
	}

	private requireProviderId(request: AgentSessionRequest): string {
		if (!request.providerId) {
			throw this.error('PROVIDER_COMPONENT_MISSING', 'A Provider must be selected.', false);
		}
		return request.providerId;
	}

	private requireModelId(request: AgentSessionRequest): string {
		if (!request.modelId) {
			throw this.error('MODEL_UNAVAILABLE', 'A model must be selected.', false);
		}
		return request.modelId;
	}

	private success(request: AgentSessionRequest, result: unknown): AgentSessionResult {
		return {
			command: 'agentSessionResult',
			protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
			requestId: request.requestId,
			ok: true,
			result,
		};
	}

	private failure(request: AgentSessionRequest, error: unknown): AgentSessionResult {
		const detail = error as Error & { code?: AgentSessionErrorCode; retryable?: boolean };
		const knownCode = detail.code && this.isKnownErrorCode(detail.code) ? detail.code : 'INTERNAL_ERROR';
		return {
			command: 'agentSessionResult',
			protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
			requestId: request.requestId,
			ok: false,
			error: {
				code: knownCode,
				message: detail.message || String(error),
				retryable: detail.retryable === true,
			},
		};
	}

	private isKnownErrorCode(code: string): code is AgentSessionErrorCode {
		return [
			'MCP_UNAVAILABLE', 'DOCUMENT_DIRTY', 'PROVIDER_COMPONENT_MISSING', 'PROVIDER_INSTALL_FAILED',
			'PROVIDER_LOAD_FAILED', 'PROVIDER_INCOMPATIBLE', 'AUTH_REQUIRED', 'CAPABILITY_UNAVAILABLE',
				'MODEL_UNAVAILABLE', 'EFFORT_UNAVAILABLE', 'PERMISSION_MODE_UNAVAILABLE',
				'NO_ACTIVE_SESSION', 'NO_ACTIVE_TURN', 'STALE_TURN',
			'TIMEOUT', 'INTERNAL_ERROR',
		].includes(code);
	}

	private error(code: AgentSessionErrorCode, message: string, retryable: boolean): Error {
		const error = new Error(message) as Error & { code: AgentSessionErrorCode; retryable: boolean };
		error.code = code;
		error.retryable = retryable;
		return error;
	}
}
