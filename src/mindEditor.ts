import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ExecStateWatcher } from './editor/ExecStateWatcher';
import { ImportExportHandler } from './editor/ImportExportHandler';
import { DocumentState, MindEditorDocument } from './editor/MindEditorDocument';
import { extensionHostSessionId, logLifecycle } from './lifecycle';
import { KmMcpClient, KmMcpClientStatus } from './mcpClient/kmMcpClient';
import { AgentControlBarCoordinator } from './sessions/agentControlBarCoordinator';
import { isAgentSessionRequest } from './sessions/protocol';
import { AGENT_SESSION_PROTOCOL_VERSION } from './sessions/types';
import { PendingSessionDeepLink, sessionDeepLinkStore } from './deepLinks/sessionDeepLinkStore';
import {
	assertDifferentSplitDestination,
	suggestSplitPath,
	writeSplitFile,
} from './nodeSplit';

const matchableFileTypes: string[] = ['xmind', 'km', 'svg'];
const viewType = 'infinite-map.editor';
const PROVIDER_REBOUND_CHECK_DELAY_MS = 5000;

export class MindEditorProvider implements vscode.CustomEditorProvider {
	private activePanels = new Map<string, vscode.WebviewPanel>();
	private activePanelOwners = new Map<string, vscode.CustomDocument>();
	private panelIds = new WeakMap<vscode.WebviewPanel, number>();
	private nextPanelId = 1;
	private panelBindings = new WeakMap<vscode.WebviewPanel, () => void>();
	private execStateWatchers = new Map<string, ExecStateWatcher>();
	private readonly agentCoordinator: AgentControlBarCoordinator;
	private readonly mcpClients = new Set<KmMcpClient>();
	private readonly mcpStateSubscriptions = new Map<KmMcpClient, vscode.Disposable>();
	private readonly importExportHandler = new ImportExportHandler();
	private readonly sessionDeepLinkSubscription: vscode.Disposable;
	private readonly documentManager: MindEditorDocument;
	public readonly documentStates: Map<string, DocumentState>;

	constructor(public context: vscode.ExtensionContext, private readonly sessionId = extensionHostSessionId) {
		this.context = context;
		this.agentCoordinator = new AgentControlBarCoordinator(context);
		this.documentManager = new MindEditorDocument({
			getActivePanel: (document) => this.getActivePanel(document),
			onDocumentOpened: (document) => this.startExecStateWatcher(document),
			onDocumentDisposed: (document) => this.handleDocumentDisposed(document),
			onDocumentStateChanged: (document, state) => {
				const panel = this.getActivePanel(document);
				if (panel) {
					void this.agentCoordinator.broadcastSnapshot(document, panel, state);
				}
			},
		}, this.importExportHandler);
		this.documentStates = this.documentManager.documentStates;
		this.sessionDeepLinkSubscription = sessionDeepLinkStore.onDidSet((link) => {
			void this.deliverSessionDeepLink(link);
		});
		logLifecycle('MindEditorProvider.constructor', {
			viewType,
			providerType: 'CustomEditorProvider',
			providerSessionId: this.sessionId,
		});
	}

	static register(context: vscode.ExtensionContext, sessionId = extensionHostSessionId) {
		logLifecycle('registerCustomEditorProvider.begin', {
			viewType,
			providerType: 'CustomEditorProvider',
		});
		const provider = new MindEditorProvider(context, sessionId);
		const providerRegistration = vscode.window.registerCustomEditorProvider(viewType, provider, {
			webviewOptions: {
				retainContextWhenHidden: true,
			},
			supportsMultipleEditorsPerDocument: false,
		});
		logLifecycle('registerCustomEditorProvider.complete', {
			viewType,
			providerType: 'CustomEditorProvider',
			retainContextWhenHidden: true,
			supportsMultipleEditorsPerDocument: false,
		});
		const recoveryMonitor = provider.startRecoveryMonitor();
		return {
			dispose: () => {
				recoveryMonitor?.dispose();
				provider.dispose();
				providerRegistration.dispose();
			},
		};
	}

	private dispose(): void {
		this.sessionDeepLinkSubscription.dispose();
		this.agentCoordinator.dispose();
		for (const subscription of this.mcpStateSubscriptions.values()) {
			subscription.dispose();
		}
		this.mcpStateSubscriptions.clear();
		for (const client of this.mcpClients) {
			void client.dispose();
		}
		this.mcpClients.clear();
	}

	private async deliverSessionDeepLink(link: PendingSessionDeepLink): Promise<void> {
		const panel = this.activePanels.get(link.documentUri);
		if (!panel) {
			return;
		}
		try {
			const delivered = await panel.webview.postMessage({
				command: 'agentSessionHistoryOpen',
				protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
				nodeId: link.nodeId,
				executionId: link.executionId,
			});
			if (delivered) {
				sessionDeepLinkStore.consume(link.documentUri, link.executionId);
			}
		} catch {
			// The pending link stays queued until the matching Webview becomes ready.
		}
	}

	private startRecoveryMonitor(): vscode.Disposable | undefined {
		const tabGroups = (vscode.window as any).tabGroups as vscode.TabGroups | undefined;
		if (!tabGroups || typeof tabGroups.onDidChangeTabs !== 'function') {
			logLifecycle('providerRecoveryMonitor.unavailable', { viewType });
			return undefined;
		}

		let disposed = false;
		let scanTimer: NodeJS.Timeout | undefined;
		const warnedUris = new Set<string>();
		const scheduleScan = (reason: string) => {
			if (scanTimer) {
				clearTimeout(scanTimer);
			}
			scanTimer = setTimeout(() => {
				scanTimer = undefined;
				if (disposed) {
					return;
				}
				this.scanForUnreboundEditors(tabGroups, reason, warnedUris);
			}, PROVIDER_REBOUND_CHECK_DELAY_MS);
		};

		const tabsSubscription = tabGroups.onDidChangeTabs((event: vscode.TabChangeEvent) => {
			for (const tab of event.closed) {
				const input = tab.input as { uri?: vscode.Uri; viewType?: string };
				if (input?.viewType === viewType && input.uri) {
					warnedUris.delete(input.uri.toString());
				}
			}
			scheduleScan('tabs-changed');
		});
		scheduleScan('provider-registered');

		return {
			dispose: () => {
				disposed = true;
				if (scanTimer) {
					clearTimeout(scanTimer);
					scanTimer = undefined;
				}
				tabsSubscription.dispose();
				warnedUris.clear();
			},
		};
	}

	private scanForUnreboundEditors(
		tabGroups: vscode.TabGroups,
		reason: string,
		warnedUris: Set<string>
	): void {
		const unresolved: Array<{ uri: vscode.Uri; tab: vscode.Tab }> = [];
		for (const group of tabGroups.all) {
			for (const tab of group.tabs) {
				const input = tab.input as { uri?: vscode.Uri; viewType?: string };
				// Inactive restored tabs may be intentionally lazy. Selecting one fires
				// onDidChangeTabs and schedules a fresh check.
				if (!tab.isActive || input?.viewType !== viewType || !input.uri) {
					continue;
				}
				const docKey = input.uri.toString();
				if (!this.activePanels.has(docKey)) {
					unresolved.push({ uri: input.uri, tab });
				}
			}
		}
		const unresolvedUris = new Set(unresolved.map(({ uri }) => uri.toString()));
		for (const warnedUri of warnedUris) {
			if (!unresolvedUris.has(warnedUri)) {
				warnedUris.delete(warnedUri);
			}
		}
		if (unresolved.length === 0) {
			return;
		}

		for (const { uri, tab } of unresolved) {
			const docKey = uri.toString();
			if (warnedUris.has(docKey)) {
				continue;
			}
			warnedUris.add(docKey);
			logLifecycle('provider-not-rebound', {
				viewType,
				documentUri: docKey,
				reason,
				tabLabel: tab.label,
				tabDirty: tab.isDirty,
				tabActive: tab.isActive ?? null,
				tabViewColumn: tab.group?.viewColumn ?? null,
				panelObjectAvailable: false,
			});
			void Promise.resolve(vscode.window.showWarningMessage(
				'InfiniteMap editor is still open, but the Extension Host did not reattach it. Reload the VS Code window to restore it.',
				'Reload Window'
			)).then((action) => {
				if (action === 'Reload Window') {
					return vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
				return undefined;
			}).catch((error: unknown) => {
				logLifecycle('providerRecoveryMonitor.actionFailed', {
					documentUri: docKey,
					error: error instanceof Error ? error.stack || error.message : String(error),
				});
			});
		}
	}

	async revertCustomDocument(document: vscode.CustomDocument, _cancellation?: vscode.CancellationToken): Promise<void> {
		return this.documentManager.revertCustomDocument(document);
	}

	async backupCustomDocument(
		document: vscode.CustomDocument,
		context: vscode.CustomDocumentBackupContext,
		_cancellation: vscode.CancellationToken
	): Promise<vscode.CustomDocumentBackup> {
		return this.documentManager.backupCustomDocument(document, context);
	}

	public get onDidChangeCustomDocument(): vscode.Event<vscode.CustomDocumentContentChangeEvent> {
		return this.documentManager.onDidChangeCustomDocument;
	}

	saveCustomDocumentAs(
		document: vscode.CustomDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken
	): Thenable<void> {
		return this.documentManager.saveCustomDocumentAs(document, destination, cancellation);
	}

	public async openCustomDocument(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext
	): Promise<vscode.CustomDocument> {
		return this.documentManager.openCustomDocument(uri, openContext);
	}

	public saveCustomDocument(
		document: vscode.CustomDocument,
		cancellation: vscode.CancellationToken
	): Thenable<void> {
		return this.documentManager.saveCustomDocument(document, cancellation);
	}

	async resolveCustomEditor(
		document: vscode.CustomDocument,
		webviewPanel: vscode.WebviewPanel
	): Promise<void> {
		const docKey = document.uri.toString();
		const existingPanelId = this.panelIds.get(webviewPanel);
		const panelId = existingPanelId ?? this.nextPanelId++;
		const panelObjectNew = existingPanelId === undefined;
		this.panelIds.set(webviewPanel, panelId);
		logLifecycle('resolveCustomEditor.begin', {
			viewType,
			documentUri: docKey,
			panelId,
			panelObjectNew,
			panelActive: webviewPanel.active ?? null,
			panelVisible: webviewPanel.visible ?? null,
			panelViewColumn: webviewPanel.viewColumn ?? null,
			webviewHtmlLength: this.getWebviewHtmlLength(webviewPanel),
		});

		const onDiskPath = vscode.Uri.file(path.join(this.context.extensionPath, 'webui', 'mindmap.html'));
		const resourcePath = vscode.Uri.file(path.join(this.context.extensionPath, 'webui'));
		const resourceRealPath = webviewPanel.webview.asWebviewUri(resourcePath);
		const fileContent =
			process.platform === 'win32'
				? fs.readFileSync(onDiskPath.path.slice(1)).toString()
				: fs.readFileSync(onDiskPath.path).toString();

		// 生成 CSP meta 标签
		const cspSource = webviewPanel.webview.cspSource;
		const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data: blob:; script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource} data:; connect-src ${cspSource} https:; worker-src blob:;" />`;

		let html = fileContent.replace(/\$\{vscode\}/g, resourceRealPath.toString()).replace(/\$\{csp\}/g, csp);

		let mindmapConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("infiniteMap");
		const uploadUrl = mindmapConfig.get<string>('uploadUrl', '');
		const lang = mindmapConfig.get<string>('language') || vscode.env.language;
		//设置默认语言
		html = html.replace(/\$\{vscode_lang\}/g, lang);
		// Bootstrap the document identity before child directives issue their first
		// request. The coordinator still derives the authoritative path from the
		// current CustomDocument and ignores any Webview attempt to replace it.
		html = html.replace(/\$\{vscode_document_uri\}/g, encodeURIComponent(document.uri.toString()));
		//设置上传地址
		html = html.replace(/\$\{vscode_upload_url\}/g, uploadUrl);

		const fileName = document.uri.fsPath;
		const extName = path.extname(fileName);
		if (!matchableFileTypes.includes(extName.slice(1))) {
			logLifecycle('resolveCustomEditor.unsupportedDocument', {
				viewType,
				documentUri: docKey,
				panelId,
				extName,
			});
			return;
		}
		const panel = webviewPanel;
		const hasRetainedWebview = panel.webview.html.trim().length > 0;
		const previousBinding = this.panelBindings.get(panel);
		if (previousBinding) {
			previousBinding();
			logLifecycle('resolveCustomEditor.previousBindingDisposed', {
				viewType,
				documentUri: docKey,
				panelId,
			});
		}
		this.activePanels.set(docKey, panel);
		this.activePanelOwners.set(docKey, document);
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'webui'))],
		};

		let missedPings = 0;
		let awaitingPingId: number | undefined;
		let heartbeatBusy = false;
		let reconnectSequence = 0;
		let pingSequence = 0;
		let awaitingReconnectId: number | undefined;
		let reloadPending = false;
		let reconnectTimer: NodeJS.Timeout | undefined;
		const PING_INTERVAL = 15000;
		const MAX_MISSED = 3;

		const isPanelVisible = () => panel.visible !== false;

		const resetHeartbeat = () => {
			missedPings = 0;
			awaitingPingId = undefined;
		};

		const clearReconnectTimer = () => {
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
		};

		const completeReconnect = () => {
			clearReconnectTimer();
			awaitingReconnectId = undefined;
			reloadPending = false;
			resetHeartbeat();
		};

		const reloadWebviewInPlace = (reason: string) => {
			if (!isPanelVisible() || reloadPending) {
				return;
			}
			clearReconnectTimer();
			awaitingReconnectId = undefined;
			reloadPending = true;
			resetHeartbeat();
			panel.webview.html = html;
			logLifecycle('Webview.htmlReset', {
				viewType,
				documentUri: docKey,
				panelId,
				htmlReset: true,
				reason,
			});
			reconnectTimer = setTimeout(() => {
				reconnectTimer = undefined;
				reloadPending = false;
				missedPings = MAX_MISSED - 1;
			}, PING_INTERVAL);
		};

		const requestReconnect = async () => {
			if (!isPanelVisible() || reloadPending || awaitingReconnectId !== undefined) {
				return;
			}
			const reconnectId = ++reconnectSequence;
			awaitingReconnectId = reconnectId;
			resetHeartbeat();
			try {
				const delivered = await panel.webview.postMessage({
					command: 'reconnect',
					protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
					reconnectId,
				});
				if (awaitingReconnectId !== reconnectId) {
					return;
				}
				if (!delivered) {
					awaitingReconnectId = undefined;
					reloadWebviewInPlace('reconnect-message-not-delivered');
					return;
				}
				reconnectTimer = setTimeout(() => {
					reconnectTimer = undefined;
					awaitingReconnectId = undefined;
					reloadWebviewInPlace('reconnect-ack-timeout');
				}, PING_INTERVAL);
			} catch {
				if (awaitingReconnectId === reconnectId) {
					awaitingReconnectId = undefined;
					reloadWebviewInPlace('reconnect-message-error');
				}
			}
		};

		const heartbeatTimer = setInterval(async () => {
			if (!isPanelVisible()) {
				resetHeartbeat();
				return;
			}
			if (heartbeatBusy || reloadPending || awaitingReconnectId !== undefined) {
				return;
			}
			heartbeatBusy = true;
			try {
				if (awaitingPingId !== undefined) {
					missedPings += 1;
				}
				if (missedPings >= MAX_MISSED) {
					reloadWebviewInPlace('heartbeat-timeout');
					return;
				}
				const pingId = ++pingSequence;
				const delivered = await panel.webview.postMessage({
					command: 'ping',
					protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
					pingId,
				});
				if (delivered) {
					awaitingPingId = pingId;
				} else {
					missedPings += 1;
					if (missedPings >= MAX_MISSED) {
						reloadWebviewInPlace('heartbeat-message-not-delivered');
					}
				}
			} catch {
				missedPings += 1;
				if (missedPings >= MAX_MISSED) {
					reloadWebviewInPlace('heartbeat-message-error');
				}
			} finally {
				heartbeatBusy = false;
			}
		}, PING_INTERVAL);

		const subscriptions: vscode.Disposable[] = [];
		subscriptions.push(this.agentCoordinator.bind(document, panel));
		let bindingDisposed = false;
		const cleanupBinding = () => {
			if (bindingDisposed) {
				return;
			}
			bindingDisposed = true;
			clearInterval(heartbeatTimer);
			clearReconnectTimer();
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			if (
				this.activePanels.get(docKey) === panel &&
				this.activePanelOwners.get(docKey) === document
			) {
				this.activePanels.delete(docKey);
				this.activePanelOwners.delete(docKey);
			}
			logLifecycle('resolveCustomEditor.bindingDisposed', {
				viewType,
				documentUri: docKey,
				panelId,
			});
		};
		this.panelBindings.set(panel, cleanupBinding);

		subscriptions.push(panel.onDidChangeViewState(() => {
			logLifecycle('WebviewPanel.onDidChangeViewState', {
				viewType,
				documentUri: docKey,
				panelId,
				panelActive: panel.active ?? null,
				panelVisible: panel.visible ?? null,
				panelViewColumn: panel.viewColumn ?? null,
			});
			if (!isPanelVisible()) {
				clearReconnectTimer();
				awaitingReconnectId = undefined;
				reloadPending = false;
				resetHeartbeat();
				return;
			}
			resetHeartbeat();
			void requestReconnect();
		}));

		subscriptions.push(panel.onDidDispose(() => {
			logLifecycle('WebviewPanel.onDidDispose', {
				viewType,
				documentUri: docKey,
				panelId,
			});
			cleanupBinding();
			this.documentManager.rejectPendingSave(
				docKey,
				new Error('Webview closed before the save completed.'),
				document
			);
			this.documentManager.rejectPendingImportsForDocument(
				document,
				new Error('Webview closed before the import completed.')
			);
		}));

		subscriptions.push(panel.webview.onDidReceiveMessage(
			async (message: any) => {
					if (!message || message.protocolVersion !== AGENT_SESSION_PROTOCOL_VERSION) {
						return;
					}
					if (isAgentSessionRequest(message)) {
						await this.agentCoordinator.handle(
							message,
							document,
							panel,
							this.documentManager.getState(document)
						);
						return;
					}
					if (message.command === 'ready' || message.command === 'loaded' || message.command === 'reconnected') {
						logLifecycle('Webview.message.' + message.command, {
							viewType,
							documentUri: docKey,
							panelId,
							panelActive: panel.active ?? null,
							panelVisible: panel.visible ?? null,
							panelViewColumn: panel.viewColumn ?? null,
							readyHandshake: message.command === 'ready' || message.command === 'loaded',
							webviewSessionId: message.webviewSessionId ?? null,
							webviewTimestamp: message.timestamp ?? null,
						});
					}
					switch (message.command) {
						case 'ready':
						case 'loaded':
							completeReconnect();
							await this.documentManager.prepareWebview(document);
							this.broadcastExecState(document);
							void this.broadcastKmExecutionAvailability(document);
							void this.agentCoordinator.broadcastSnapshot(
								document,
								panel,
								this.documentManager.getState(document)
							);
							const pendingLink = sessionDeepLinkStore.peek(document.uri.toString());
							if (pendingLink) {
								void this.deliverSessionDeepLink(pendingLink);
							}
							return;
						case 'refresh': {
							const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
							try {
								if (requestId) {
									const activeRefresh = this.documentManager.getActiveRefresh(docKey);
									if (activeRefresh && this.documentManager.getRefreshRequestId(docKey) !== requestId) {
										await panel.webview.postMessage({
											command: 'refreshResult',
											protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
											requestId,
											ok: false,
											error: 'Another refresh is already in progress.',
										});
										return;
									}
									await this.documentManager.refreshFromDisk(document, requestId);
								} else {
									await this.revertCustomDocument(document);
								}
								if (requestId) {
									await panel.webview.postMessage({
										command: 'refreshResult',
										protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
										requestId,
										ok: true,
									});
								}
							} catch (ex) {
								const error = ex instanceof Error ? ex : new Error(String(ex));
								if (requestId) {
									try {
										await panel.webview.postMessage({
											command: 'refreshResult',
											protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
											requestId,
											ok: false,
											error: error.message,
										});
									} catch {
										// The Webview may already be gone; the client-side timeout unlocks it.
									}
								}
								if (!error.message.includes('Document closed')) {
									void vscode.window.showErrorMessage(`Unable to reload the mind map: ${error.message}`);
								}
							}
							return;
						}
						case 'importResult':
							this.documentManager.completePendingImport(
								document,
								message.importRequestId,
								message.ok !== false,
								message.error
							);
							return;
						case 'reconnected': {
							if (message.reconnectId !== awaitingReconnectId) {
								return;
							}
							completeReconnect();
							await this.documentManager.reconnectWebview(document, message.exportData);
							return;
						}
						case 'pong':
							if (
								message.pingId !== undefined &&
								awaitingPingId !== undefined &&
								message.pingId !== awaitingPingId
							) {
								return;
							}
							resetHeartbeat();
							return;
							case 'save':
								try {
									await this.documentManager.completeSave(document, message.exportData, message.requestId);
								} catch (ex) {
									this.documentManager.rejectPendingSave(
										docKey,
										ex instanceof Error ? ex : new Error(String(ex)),
										document,
										message.requestId
									);
								if (!(ex instanceof Error && ex.message.includes('changed on disk'))) {
									console.error(ex);
								}
							}
							return;
						case 'draft':
							try {
								this.documentManager.updateDraft(document, message.exportData);
							} catch (ex) {
							console.error(ex);
						}
						return;
					case 'clicklink':
						this.notifyExternalExtensions({
							type: 'clicklink',
							from: 'infiniteMap',
							link: message.link,
						});
						break;
					case 'errormsg':
						vscode.window.showErrorMessage(message.content);
						break;
					case 'splitNode': {
						const requestId = typeof message.requestId === 'string' ? message.requestId : '';
						if (!requestId) {
							return;
						}
						try {
							const destination = await vscode.window.showSaveDialog({
								defaultUri: vscode.Uri.file(suggestSplitPath(document.uri.fsPath, message.nodeText)),
								filters: { 'InfiniteMap': ['km'] },
							});
							if (!destination) {
								await panel.webview.postMessage({
									command: 'splitNodeResult',
									protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
									requestId,
									ok: false,
									cancelled: true,
								});
								return;
							}
							assertDifferentSplitDestination(document.uri.fsPath, destination.fsPath);
							await writeSplitFile(destination.fsPath, message.content);
							await panel.webview.postMessage({
								command: 'splitNodeResult',
								protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
								requestId,
								ok: true,
							});
						} catch (error) {
							const detail = error instanceof Error ? error.message : String(error);
							await panel.webview.postMessage({
								command: 'splitNodeResult',
								protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
								requestId,
								ok: false,
								error: detail,
							});
							void vscode.window.showErrorMessage(`Unable to split the node: ${detail}`);
						}
						return;
					}
					case 'importFile':
						await this.importExportHandler.handleImportFile(panel, docKey, panelId);
						break;
					case 'export':
						await this.importExportHandler.handleExport(message, mindmapConfig, docKey, panelId);
						break;
					default:
						break;
				}
				},
				undefined,
			));
		logLifecycle('resolveCustomEditor.listenersRegistered', {
			viewType,
			documentUri: docKey,
			panelId,
			onDidReceiveMessageRegistered: true,
			onDidDisposeRegistered: true,
		});

		if (hasRetainedWebview) {
			logLifecycle('resolveCustomEditor.htmlDecision', {
				viewType,
				documentUri: docKey,
				panelId,
				htmlReset: false,
				hasRetainedWebview: true,
			});
			void requestReconnect();
		} else {
			panel.webview.html = html;
			logLifecycle('resolveCustomEditor.htmlDecision', {
				viewType,
				documentUri: docKey,
				panelId,
				htmlReset: true,
				hasRetainedWebview: false,
			});
		}
		logLifecycle('resolveCustomEditor.complete', {
			viewType,
			documentUri: docKey,
			panelId,
			panelObjectNew,
			panelActive: panel.active ?? null,
			panelVisible: panel.visible ?? null,
			panelViewColumn: panel.viewColumn ?? null,
		});
	}

	private getWebviewHtmlLength(panel: vscode.WebviewPanel): number | null {
		try {
			return panel.webview.html.length;
		} catch {
			return null;
		}
	}

	private notifyExternalExtensions(message: any) {
		this.extensionChannels.forEach((chanel) => {
			chanel.postMessage(message);
		});
	}

	private getActivePanel(document: vscode.CustomDocument): vscode.WebviewPanel | undefined {
		const docKey = document.uri.toString();
		if (this.activePanelOwners.get(docKey) !== document) {
			return undefined;
		}
		return this.activePanels.get(docKey);
	}

	private startExecStateWatcher(document: vscode.CustomDocument): void {
		if (document.uri.scheme !== 'file') {
			return;
		}
		const docKey = document.uri.toString();
		this.execStateWatchers.get(docKey)?.dispose();
		const watcher = new ExecStateWatcher(document, () => this.getActivePanel(document));
		watcher.start();
		this.execStateWatchers.set(docKey, watcher);
	}

	private handleDocumentDisposed(document: vscode.CustomDocument): void {
		const docKey = document.uri.toString();
		this.disposeDocumentWatcher(docKey);
		if (this.activePanelOwners.get(docKey) === document) {
			this.activePanels.delete(docKey);
			this.activePanelOwners.delete(docKey);
		}
	}

	private broadcastExecState(document: vscode.CustomDocument): void {
		this.execStateWatchers.get(document.uri.toString())?.broadcast();
	}

	private async broadcastKmExecutionAvailability(document: vscode.CustomDocument): Promise<void> {
		const panel = this.getActivePanel(document);
		if (!panel) {
			return;
		}
		if (document.uri.scheme !== 'file' || path.extname(document.uri.fsPath).toLowerCase() !== '.km') {
			await panel.webview.postMessage({
				command: 'kmExecutionAvailability',
				protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
				available: false,
				reason: 'Agent task execution is available only for local .km documents.',
			});
			return;
		}
		const workspace = (vscode.workspace as any).getWorkspaceFolder?.(document.uri) as
			| vscode.WorkspaceFolder
			| undefined;
		const workspaceKey = workspace ? workspace.uri.toString() : path.dirname(document.uri.fsPath);
		const client = KmMcpClient.forWorkspace(workspaceKey, { extensionPath: this.context.extensionPath });
		this.mcpClients.add(client);
		this.observeMcpClient(client, workspaceKey);
		try {
			await client.connect();
			await this.postMcpConnectionState(panel, client.status);
		} catch (error) {
			await this.postMcpConnectionState(panel, {
				...client.status,
				lastError: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private observeMcpClient(client: KmMcpClient, workspaceKey: string): void {
		if (this.mcpStateSubscriptions.has(client)) {
			return;
		}
		const subscription = client.onDidChangeState((status) => {
			for (const [documentKey, document] of this.activePanelOwners) {
				const workspace = (vscode.workspace as any).getWorkspaceFolder?.(document.uri) as
					| vscode.WorkspaceFolder
					| undefined;
				const documentWorkspaceKey = workspace
					? workspace.uri.toString()
					: path.dirname(document.uri.fsPath);
				if (documentWorkspaceKey !== workspaceKey) {
					continue;
				}
				const panel = this.activePanels.get(documentKey);
				if (panel) {
					void this.postMcpConnectionState(panel, status).catch(() => undefined);
				}
			}
		});
		this.mcpStateSubscriptions.set(client, subscription);
	}

	private async postMcpConnectionState(
		panel: vscode.WebviewPanel,
		status: KmMcpClientStatus
	): Promise<void> {
		const available = status.state === 'ready';
		await panel.webview.postMessage({
			command: 'mcpConnectionState',
			protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
			state: status.state,
			available,
			attempt: status.attempt,
			nextRetryMs: status.nextRetryMs,
			retryable: status.state !== 'disposed',
		});
		await panel.webview.postMessage({
			command: 'kmExecutionAvailability',
			protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
			available,
			state: status.state,
		});
	}

	private disposeDocumentWatcher(docKey: string): void {
		this.execStateWatchers.get(docKey)?.dispose();
		this.execStateWatchers.delete(docKey);
	}

	get extensionChannels() {
		return vscode.extensions.all
			.filter((ext) => ext.isActive && ext.exports && ext.exports.exportedMessageChannel)
			.map((ext) => ext.exports.exportedMessageChannel);
	}
}
