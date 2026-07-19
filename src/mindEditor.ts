import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { selectFile, getRootUri, changeSvgImg } from "./util";
import { extensionHostSessionId, logLifecycle } from './lifecycle';
const xmindparser = require('./xmindparser');
let parser = new xmindparser();

const { Resvg, initWasm } = require('./wasm');
const index_bg = fs.readFileSync(path.join(__dirname, '../webui/resvg-js/index_bg.wasm'));
initWasm(index_bg);
const fontPath = path.join(__dirname, '../webui/resvg-js/fonts/Alibaba_PuHuiTi_2.0_45_Light_45_Light.ttf');

const matchableFileTypes: string[] = ['xmind', 'km', 'svg'];
const viewType = 'infinite-map.editor';
const SAVE_TIMEOUT_MS = 10000;
const IMPORT_TIMEOUT_MS = 10000;

interface DocumentState {
	content: string;
	dirty: boolean;
	externalConflict: boolean;
	lastDiskContent: string;
}

interface PendingSave {
	document: vscode.CustomDocument;
	destination: vscode.Uri;
	requestId: string;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	cancellationSubscription: vscode.Disposable;
}

interface PendingImport {
	document: vscode.CustomDocument;
	importId: string;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class MindEditorProvider implements vscode.CustomEditorProvider {
	private activePanels = new Map<string, vscode.WebviewPanel>();
	private activePanelOwners = new Map<string, vscode.CustomDocument>();
	private panelIds = new WeakMap<vscode.WebviewPanel, number>();
	private nextPanelId = 1;
	private panelBindings = new WeakMap<vscode.WebviewPanel, () => void>();
	private documentStates = new Map<string, DocumentState>();
	private documentOwners = new Map<string, vscode.CustomDocument>();
	private documentWatchers = new Map<string, vscode.FileSystemWatcher>();
	private externalChangeTimers = new Map<string, NodeJS.Timeout>();
	private externalChangeRevisions = new Map<string, number>();
	private reloadOperations = new Map<string, Promise<void>>();
	private reloadInvocationCounts = new Map<string, number>();
	private refreshRequestIds = new Map<string, string>();
	private refreshOperations = new Map<string, Promise<void>>();
	private documentIoTails = new Map<string, Promise<void>>();
	private pendingSaves = new Map<string, PendingSave>();
	private pendingImports = new Map<string, PendingImport>();
	private nextSaveRequestId = 1;

	constructor(public context: vscode.ExtensionContext, private readonly sessionId = extensionHostSessionId) {
		this.context = context;
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
		return providerRegistration;
	}

	async revertCustomDocument(document: vscode.CustomDocument, _cancellation?: vscode.CancellationToken): Promise<void> {
		const docKey = document.uri.toString();
		this.assertDocumentCurrent(document);
		const requestId = this.refreshRequestIds.get(docKey);
		this.reloadInvocationCounts.set(docKey, (this.reloadInvocationCounts.get(docKey) ?? 0) + 1);
		const existingOperation = this.reloadOperations.get(docKey);
		if (existingOperation) {
			return existingOperation;
		}

		// Cancel only saves that are still waiting for Webview data. A write that
		// already entered the document I/O queue is allowed to finish before the
		// refresh reads the now-stable file from disk.
		this.rejectPendingSave(
			docKey,
			new Error('Save cancelled because the document is being reloaded from disk.'),
			document
		);
		const operation = (this.documentIoTails.get(docKey) || Promise.resolve())
			.catch(() => undefined)
			.then(() => this.reloadCustomDocument(document, requestId));
		this.reloadOperations.set(docKey, operation);
		try {
			await operation;
		} finally {
			if (this.reloadOperations.get(docKey) === operation) {
				this.reloadOperations.delete(docKey);
			}
		}
	}

	private async reloadCustomDocument(document: vscode.CustomDocument, importRequestId?: string): Promise<void> {
		const docKey = document.uri.toString();
		this.assertDocumentCurrent(document);
		const state = this.getDocumentState(document);
		const previousState = { ...state };
		try {
			this.assertDocumentCurrent(document);
			let content = await this.getContent(document);
			this.assertDocumentCurrent(document);
			await this.postImport(document, content, importRequestId);
			this.assertDocumentCurrent(document);

			// Watcher callbacks can arrive while the Webview is acknowledging an
			// import. Keep reading until no watcher revision changes across a read,
			// then commit synchronously so an observed external edit is never lost.
			for (let attempt = 0; attempt < 10; attempt++) {
				const revisionBeforeRead = this.externalChangeRevisions.get(docKey) ?? 0;
				const latestContent = await this.getContent(document);
				this.assertDocumentCurrent(document);
				const revisionAfterRead = this.externalChangeRevisions.get(docKey) ?? 0;
				if (latestContent !== content) {
					await this.postImport(
						document,
						latestContent,
						importRequestId ? `${importRequestId}:latest:${attempt + 1}` : undefined
					);
					content = latestContent;
					continue;
				}
				if (
					revisionAfterRead !== revisionBeforeRead ||
					(this.externalChangeRevisions.get(docKey) ?? 0) !== revisionAfterRead
				) {
					continue;
				}

				state.content = content;
				state.dirty = false;
				state.externalConflict = false;
				state.lastDiskContent = content;
				return;
			}
			throw new Error('The mind map kept changing while it was being reloaded from disk.');
		} catch (error) {
			if (this.documentOwners.get(docKey) === document && this.documentStates.get(docKey) === state) {
				Object.assign(state, previousState);
			}
			throw error;
		}
	}

	async backupCustomDocument(
		document: vscode.CustomDocument,
		context: vscode.CustomDocumentBackupContext,
		_cancellation: vscode.CancellationToken
	): Promise<vscode.CustomDocumentBackup> {
		const state = this.getDocumentState(document);
		const content = state.content;
		await this.enqueueDocumentIo(document, async () => {
			await fs.promises.mkdir(path.dirname(context.destination.fsPath), { recursive: true });
			await this.writeContent(context.destination.fsPath, path.extname(document.uri.fsPath), content);
		});
		return {
			id: context.destination.toString(),
			delete: () => {
				void fs.promises.unlink(context.destination.fsPath).catch(() => undefined);
			},
		};
	}

	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent>();
	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	saveCustomDocumentAs(
		document: vscode.CustomDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken
	): Thenable<void> {
		return this.requestSave(document, destination, cancellation);
	}

	public async openCustomDocument(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext
	): Promise<vscode.CustomDocument> {
		const docKey = uri.toString();
		// A URI can be reopened immediately after dispose. Wait for every old
		// reload/write operation before reading it again, even when the previous
		// owner has already been removed from the map.
		const previousIo = this.documentIoTails.get(docKey);
		if (previousIo) {
			await previousIo.catch(() => undefined);
		}
		const previousOwner = this.documentOwners.get(docKey);
		if (previousOwner) {
			this.rejectPendingSave(
				docKey,
				new Error('Save cancelled because the document is being reopened.'),
				previousOwner
			);
			this.rejectPendingImportsForDocument(
				previousOwner,
				new Error('Import cancelled because the document is being reopened.')
			);
		}
		// A previous instance may still be finishing a read-only reload. It is
		// intentionally not awaited; its owner checks will reject it after this
		// instance takes over the URI. Writes were awaited above.
		this.refreshOperations.delete(docKey);
		this.reloadOperations.delete(docKey);
		this.refreshRequestIds.delete(docKey);
		this.reloadInvocationCounts.delete(docKey);
		logLifecycle('openCustomDocument.begin', {
			viewType,
			documentUri: docKey,
			backupId: openContext.backupId ?? null,
			untitledDocumentData: Boolean(openContext.untitledDocumentData),
		});
		let content: string;
		if (openContext.backupId) {
			const backupUri = vscode.Uri.parse(openContext.backupId);
			content = await this.readContent(backupUri.fsPath, path.extname(uri.fsPath));
		} else if (openContext.untitledDocumentData) {
			content = Buffer.from(openContext.untitledDocumentData).toString('utf8');
		} else {
			content = await this.readContent(uri.fsPath, path.extname(uri.fsPath));
		}
		const lastDiskContent = openContext.backupId && uri.scheme === 'file'
			? await this.readContent(uri.fsPath, path.extname(uri.fsPath)).catch(() => content)
			: content;
		if (this.documentOwners.has(docKey)) {
			this.disposeDocumentWatcher(docKey);
		}
		this.documentStates.set(docKey, {
			content,
			dirty: Boolean(openContext.backupId),
			externalConflict: false,
			lastDiskContent,
		});
		const document: vscode.CustomDocument = {
			uri,
			dispose: () => {
				this.rejectPendingSave(
					docKey,
					new Error('Document closed before the save completed.'),
					document
				);
				this.rejectPendingImportsForDocument(
					document,
					new Error('Document closed before the import completed.')
				);
				if (this.documentOwners.get(docKey) !== document) {
					return;
				}
				this.disposeDocumentWatcher(docKey);
				this.documentStates.delete(docKey);
				this.documentOwners.delete(docKey);
				this.refreshRequestIds.delete(docKey);
				this.reloadInvocationCounts.delete(docKey);
				if (this.activePanelOwners.get(docKey) === document) {
					this.activePanels.delete(docKey);
					this.activePanelOwners.delete(docKey);
				}
			},
		};
		this.documentOwners.set(docKey, document);
		this.externalChangeRevisions.set(docKey, 0);
		this.watchDocument(document);
		logLifecycle('openCustomDocument.complete', {
			viewType,
			documentUri: docKey,
			restoredFromBackup: Boolean(openContext.backupId),
			dirty: Boolean(openContext.backupId),
		});
		return document;
	}

	public saveCustomDocument(
		document: vscode.CustomDocument,
		cancellation: vscode.CancellationToken
	): Thenable<void> {
		return this.requestSave(document, document.uri, cancellation);
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
				const delivered = await panel.webview.postMessage({ command: 'ping', pingId });
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
			this.rejectPendingSave(
				docKey,
				new Error('Webview closed before the save completed.'),
				document
			);
			this.rejectPendingImportsForDocument(
				document,
				new Error('Webview closed before the import completed.')
			);
		}));

		subscriptions.push(panel.webview.onDidReceiveMessage(
				async (message: any) => {
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
							const state = this.getDocumentState(document);
							if (!state.dirty && !state.externalConflict) {
								state.content = await this.getContent(document);
								state.lastDiskContent = state.content;
							}
							await this.postImport(document, state.content);
							return;
						case 'refresh': {
							const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
							try {
								if (requestId) {
									const activeRefresh = this.refreshOperations.get(docKey) || this.reloadOperations.get(docKey);
									if (activeRefresh && this.refreshRequestIds.get(docKey) !== requestId) {
										await panel.webview.postMessage({
											command: 'refreshResult',
											requestId,
											ok: false,
											error: 'Another refresh is already in progress.',
										});
										return;
									}
									await this.refreshFromDisk(document, requestId);
								} else {
									await this.revertCustomDocument(document);
								}
								if (requestId) {
									await panel.webview.postMessage({
										command: 'refreshResult',
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
							this.completePendingImport(
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
							const reconnectState = this.getDocumentState(document);
							if (reconnectState.dirty && typeof message.exportData === 'string') {
								reconnectState.content = message.exportData;
							} else {
								await this.postImport(document, reconnectState.content);
							}
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
									await this.completeSave(document, message.exportData, message.requestId);
								} catch (ex) {
									this.rejectPendingSave(
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
							if (this.refreshOperations.has(docKey) || this.reloadOperations.has(docKey)) {
								return;
							}
							try {
								const draftState = this.getDocumentState(document);
								draftState.content = message.exportData;
								draftState.dirty = true;
								this._onDidChangeCustomDocument.fire({ document });
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
					case 'importFile':
						// 选择文件
						const importFileUri = await selectFile({
							canSelectFiles: false,
							canSelectFolders: false,
							filters: {
								file: ['km', 'txt', 'md', 'json', 'xmind'],
							}
						});
						if (importFileUri) {
							let basename = path.extname(importFileUri.fsPath).toLowerCase();
							let fileType = '';
							switch (basename) {
								case '.md':
									fileType = 'markdown';
									break;
								case '.txt':
									fileType = 'text';
									break;
								case '.km':
								case '.json':
									fileType = 'json';
									break;
								case '.xmind':
									fileType = 'xmind';
									break;
								default:
									console.log("File not supported!");
									return;
							}

								if (fileType === 'xmind') {
								parser.xmindToJSON(importFileUri.fsPath).then((json: any) => {
									panel.webview.postMessage({
										command: 'importNewData',
										content: json,
										basename,
									});
								});
							} else {
								let content: any = fs.readFileSync(importFileUri.fsPath, 'utf-8');
								panel.webview.postMessage({
									command: 'importNewData',
									content,
									basename,
								});
							}
						}

						break;
						case 'export': {
							const filters: Record<string, string[]> = { 'All Files': ['*'] };
							if (message.type === 'xmind') {
								filters['Text Files'] = ['xmind'];
							} else if (message.type === 'png') {
								filters['Images Files'] = ['png'];
							}

							const rootUri = getRootUri();
							if (!rootUri) {
								break;
							}
							const uri = await vscode.window.showSaveDialog({
								defaultUri: vscode.Uri.file(path.join(rootUri.fsPath, `${message.filename}.${message.type}`)),
								filters,
							});
							if (!uri) {
								break;
							}

							if (message.type === 'xmind') {
								await parser.JSONToXmind(JSON.parse(message.content), uri.fsPath);
							} else if (message.type === 'png') {
								const svg = await changeSvgImg(message.content);
								if (svg) {
									const fontBuffer = await fs.promises.readFile(path.resolve(fontPath));
									const resvg = new Resvg(svg, {
										background: mindmapConfig.get<string>('imageBackgroundColor', '#ffffff'),
										fitTo: {
											mode: 'zoom',
											value: mindmapConfig.get<number>('imageScaleSize', 2),
										},
										font: { fontBuffers: [fontBuffer], loadSystemFonts: false },
									});
									await fs.promises.writeFile(uri.fsPath, resvg.render().asPng());
								}
							} else if (message.type === 'json') {
								await fs.promises.writeFile(
									uri.fsPath,
									JSON.stringify(JSON.parse(message.content), null, '\t'),
									'utf8'
								);
							} else {
								await fs.promises.writeFile(uri.fsPath, message.content, 'utf8');
							}
							break;
						}
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

	private assertDocumentCurrent(document: vscode.CustomDocument): void {
		const docKey = document.uri.toString();
		if (this.documentOwners.get(docKey) !== document || !this.documentStates.has(docKey)) {
			throw new Error(`Document closed before the reload completed: ${docKey}`);
		}
	}

	private getDocumentState(document: vscode.CustomDocument): DocumentState {
		this.assertDocumentCurrent(document);
		const state = this.documentStates.get(document.uri.toString());
		if (!state) {
			throw new Error(`Document state is unavailable for ${document.uri.toString()}.`);
		}
		return state;
	}

	private getActivePanel(document: vscode.CustomDocument): vscode.WebviewPanel | undefined {
		const docKey = document.uri.toString();
		if (this.activePanelOwners.get(docKey) !== document) {
			return undefined;
		}
		return this.activePanels.get(docKey);
	}

	private assertPanelCurrent(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
		if (this.getActivePanel(document) !== panel) {
			throw new Error('The Webview panel was replaced before the refresh completed.');
		}
	}

	private enqueueDocumentIo(
		document: vscode.CustomDocument,
		operation: () => Promise<void>
	): Promise<void> {
		const docKey = document.uri.toString();
		const previousTail = this.documentIoTails.get(docKey) || Promise.resolve();
		const current = previousTail.then(() => {
			this.assertDocumentCurrent(document);
			return operation();
		});
		const settledTail = current.catch(() => undefined);
		this.documentIoTails.set(docKey, settledTail);
		void settledTail.then(() => {
			if (this.documentIoTails.get(docKey) === settledTail) {
				this.documentIoTails.delete(docKey);
			}
		});
		return current;
	}

	private async refreshFromDisk(document: vscode.CustomDocument, requestId: string): Promise<void> {
		const docKey = document.uri.toString();
		const existingOperation = this.refreshOperations.get(docKey) || this.reloadOperations.get(docKey);
		if (existingOperation) {
			await existingOperation;
			return;
		}
		const operation = this.runRefreshFromDisk(document, requestId);
		this.refreshOperations.set(docKey, operation);
		try {
			await operation;
		} finally {
			if (this.refreshOperations.get(docKey) === operation) {
				this.refreshOperations.delete(docKey);
			}
		}
	}

	private async runRefreshFromDisk(document: vscode.CustomDocument, requestId: string): Promise<void> {
		const docKey = document.uri.toString();
		const invocationBefore = this.reloadInvocationCounts.get(docKey) ?? 0;
		this.refreshRequestIds.set(docKey, requestId);
		try {
			// A dirty custom editor must go through the workbench revert command so
			// VS Code clears its dirty badge. Clean editors often skip the command,
			// so the invocation counter provides a deterministic direct fallback.
			let commandError: Error | undefined;
			try {
				await vscode.commands.executeCommand('workbench.action.files.revert');
			} catch (error) {
				commandError = error instanceof Error ? error : new Error(String(error));
			}
			if ((this.reloadInvocationCounts.get(docKey) ?? 0) === invocationBefore) {
				await this.revertCustomDocument(document);
			} else if (commandError) {
				throw commandError;
			} else {
				const invokedReload = this.reloadOperations.get(docKey);
				if (invokedReload) {
					await invokedReload;
				}
			}
		} finally {
			if (this.refreshRequestIds.get(docKey) === requestId) {
				this.refreshRequestIds.delete(docKey);
			}
		}
	}

	private requestSave(
		document: vscode.CustomDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		const docKey = document.uri.toString();
		this.assertDocumentCurrent(document);
		if (this.reloadOperations.has(docKey) || this.refreshOperations.has(docKey)) {
			return Promise.reject(new Error('Save cancelled because the document is being reloaded from disk.'));
		}
		if (destination.toString() === docKey && this.getDocumentState(document).externalConflict) {
			const error = new Error(
				'The mind map changed on disk while this editor had unsaved changes. Reload from disk or use Save As to avoid overwriting external edits.'
			);
			void vscode.window.showErrorMessage(error.message);
			return Promise.reject(error);
		}
		this.rejectPendingSave(
			docKey,
			new Error('A newer save request replaced the previous request.'),
			document
		);
		if (cancellation.isCancellationRequested) {
			return Promise.reject(new Error('Save cancelled.'));
		}

		const panel = this.getActivePanel(document);
		if (!panel) {
			return this.persistContent(document, destination, this.getDocumentState(document).content);
		}

		return new Promise<void>((resolve, reject) => {
			const requestId = `save-${this.nextSaveRequestId++}`;
			const timer = setTimeout(() => {
				this.rejectPendingSave(
					docKey,
					new Error('Timed out waiting for the Webview save response.'),
					document,
					requestId
				);
			}, SAVE_TIMEOUT_MS);
			const cancellationSubscription = cancellation.onCancellationRequested(() => {
				this.rejectPendingSave(docKey, new Error('Save cancelled.'), document, requestId);
			});
			this.pendingSaves.set(docKey, {
				document,
				destination,
				requestId,
				resolve,
				reject,
				timer,
				cancellationSubscription,
			});
			void panel.webview.postMessage({ command: 'requestSave', requestId }).then(
				(delivered) => {
					if (!delivered) {
						this.rejectPendingSave(
								docKey,
								new Error('Webview save request was not delivered.'),
								document,
								requestId
						);
					}
				},
				(error) => {
					this.rejectPendingSave(
							docKey,
							error instanceof Error ? error : new Error(String(error)),
							document,
							requestId
					);
				}
			);
		});
	}

	private async completeSave(document: vscode.CustomDocument, content: string, requestId?: string): Promise<void> {
		const docKey = document.uri.toString();
		const pending = this.pendingSaves.get(docKey);
		if (
			!pending ||
			pending.document !== document ||
			typeof requestId !== 'string' ||
			pending.requestId !== requestId
		) {
			return;
		}
		const destination = pending.destination;
		const state = this.getDocumentState(document);
		if (destination.toString() === docKey && state.externalConflict) {
			throw new Error(
				'The mind map changed on disk before the save completed. Reload from disk or use Save As to preserve both versions.'
			);
		}
		clearTimeout(pending.timer);
		pending.cancellationSubscription.dispose();
		if (this.pendingSaves.get(docKey) === pending) {
			this.pendingSaves.delete(docKey);
		}
		const operation = this.persistContent(document, destination, content);
		try {
			await operation;
			state.content = content;
			pending.resolve();
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	private persistContent(
		document: vscode.CustomDocument,
		destination: vscode.Uri,
		content: string
	): Promise<void> {
		return this.enqueueDocumentIo(document, () =>
			this.persistContentNow(document, destination, content)
		);
	}

	private async persistContentNow(
		document: vscode.CustomDocument,
		destination: vscode.Uri,
		content: string
	): Promise<void> {
		const writesOriginal = destination.toString() === document.uri.toString();
		if (writesOriginal && document.uri.scheme === 'file') {
			await this.assertDiskUnchanged(document);
		}
		const destinationExtension = path.extname(destination.fsPath) || path.extname(document.uri.fsPath);
		await this.writeContent(destination.fsPath, destinationExtension, content);
		if (writesOriginal) {
			const state = this.getDocumentState(document);
			state.content = content;
			state.dirty = false;
			state.externalConflict = false;
			state.lastDiskContent = content;
		}
	}

	private async assertDiskUnchanged(document: vscode.CustomDocument): Promise<void> {
		const state = this.getDocumentState(document);
		let diskContent: string;
		try {
			diskContent = await this.getContent(document);
		} catch {
			await this.markExternalConflict(document, 'The mind map is no longer available on disk.');
			throw new Error('The mind map changed on disk before the save completed.');
		}
		if (diskContent !== state.lastDiskContent) {
			await this.markExternalConflict(
				document,
				'The mind map changed on disk before the save completed.'
			);
			throw new Error(
				'The mind map changed on disk before the save completed. Reload from disk or use Save As to preserve both versions.'
			);
		}
	}

	private watchDocument(document: vscode.CustomDocument): void {
		if (document.uri.scheme !== 'file') {
			return;
		}
		const docKey = document.uri.toString();
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(path.dirname(document.uri.fsPath), path.basename(document.uri.fsPath))
		);
		watcher.onDidChange(() => this.scheduleExternalChange(document, false));
		watcher.onDidCreate(() => this.scheduleExternalChange(document, false));
		watcher.onDidDelete(() => this.scheduleExternalChange(document, true));
		this.documentWatchers.set(docKey, watcher);
	}

	private scheduleExternalChange(document: vscode.CustomDocument, deleted: boolean): void {
		const docKey = document.uri.toString();
		if (this.documentOwners.get(docKey) !== document) {
			return;
		}
		this.externalChangeRevisions.set(
			docKey,
			(this.externalChangeRevisions.get(docKey) ?? 0) + 1
		);
		const currentTimer = this.externalChangeTimers.get(docKey);
		if (currentTimer) {
			clearTimeout(currentTimer);
		}
		const timer = setTimeout(() => {
			this.externalChangeTimers.delete(docKey);
			void this.handleExternalChange(document, deleted).catch((error) => console.error(error));
		}, 75);
		this.externalChangeTimers.set(docKey, timer);
	}

	private async handleExternalChange(document: vscode.CustomDocument, deleted: boolean): Promise<void> {
		const docKey = document.uri.toString();
		if (
			this.documentOwners.get(docKey) !== document ||
			this.refreshOperations.has(docKey) ||
			this.reloadOperations.has(docKey)
		) {
			return;
		}
		const state = this.getDocumentState(document);

		if (deleted) {
			await this.markExternalConflict(document, 'The mind map was deleted outside InfiniteMap.');
			return;
		}

		const content = await this.getContent(document);
		if (content === state.content) {
			state.externalConflict = false;
			state.lastDiskContent = content;
			return;
		}

		if (state.dirty) {
			await this.markExternalConflict(
				document,
				'The mind map changed on disk while InfiniteMap has unsaved changes.'
			);
			return;
		}

		state.content = content;
		state.externalConflict = false;
		state.lastDiskContent = content;
		await this.postImport(document, content);
	}

	private async markExternalConflict(document: vscode.CustomDocument, message: string): Promise<void> {
		const state = this.getDocumentState(document);
		if (state.externalConflict) {
			return;
		}
		state.externalConflict = true;
		const action = await vscode.window.showWarningMessage(
			`${message} Saving is blocked to prevent data loss.`,
			'Reload from Disk',
			'Save As...'
		);
		if (action === 'Reload from Disk') {
			await vscode.commands.executeCommand('workbench.action.files.revert');
		} else if (action === 'Save As...') {
			await vscode.commands.executeCommand('workbench.action.files.saveAs');
		}
	}

	private disposeDocumentWatcher(docKey: string): void {
		const timer = this.externalChangeTimers.get(docKey);
		if (timer) {
			clearTimeout(timer);
			this.externalChangeTimers.delete(docKey);
		}
		this.documentWatchers.get(docKey)?.dispose();
		this.documentWatchers.delete(docKey);
		this.externalChangeRevisions.delete(docKey);
	}

	private rejectPendingSave(
		docKey: string,
		error: Error,
		document?: vscode.CustomDocument,
		requestId?: string
	): void {
		const pending = this.pendingSaves.get(docKey);
		if (
			!pending ||
			(document && pending.document !== document) ||
			(requestId && pending.requestId !== requestId)
		) {
			return;
		}
		clearTimeout(pending.timer);
		pending.cancellationSubscription.dispose();
		this.pendingSaves.delete(docKey);
		pending.reject(error);
	}

	private async postImport(
		document: vscode.CustomDocument,
		content: string,
		importRequestId?: string
	): Promise<void> {
		const docKey = document.uri.toString();
		this.assertDocumentCurrent(document);
		const panel = this.getActivePanel(document);
		if (!panel) {
			if (importRequestId) {
				throw new Error('The Webview panel is unavailable for this refresh.');
			}
			return;
		}
		const importId = importRequestId;
		const acknowledgement = importId ? this.waitForImport(document, importId) : undefined;
		let delivered: boolean;
		try {
			delivered = await panel.webview.postMessage({
				command: 'import',
				importData: content,
				extName: path.extname(document.uri.fsPath),
				...(importId ? { importRequestId: importId } : {}),
			});
		} catch (error) {
			if (importId) {
				this.rejectPendingImport(
					document,
					importId,
					error instanceof Error ? error : new Error(String(error))
				);
			}
			throw error;
		}
		if (!delivered) {
			if (importId) {
				this.rejectPendingImport(document, importId, new Error('Webview import message was not delivered.'));
			}
			throw new Error('Webview import message was not delivered.');
		}
		if (acknowledgement) {
			await acknowledgement;
		}
		this.assertPanelCurrent(document, panel);
		this.assertDocumentCurrent(document);
	}

	private waitForImport(document: vscode.CustomDocument, importId: string): Promise<void> {
		const docKey = document.uri.toString();
		this.rejectPendingImportsForDocument(document, new Error('A newer import replaced the previous import.'));
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.rejectPendingImport(
					document,
					importId,
					new Error('Timed out waiting for the Webview import acknowledgement.')
				);
			}, IMPORT_TIMEOUT_MS);
			this.pendingImports.set(docKey, { document, importId, resolve, reject, timer });
		});
	}

	private completePendingImport(
		document: vscode.CustomDocument,
		_importId: string,
		ok: boolean,
		error?: string
	): void {
		const docKey = document.uri.toString();
		const pending = this.pendingImports.get(docKey);
		if (!pending || pending.document !== document || pending.importId !== _importId) {
			return;
		}
		clearTimeout(pending.timer);
		this.pendingImports.delete(docKey);
		if (ok) {
			pending.resolve();
		} else {
			pending.reject(new Error(error || 'Webview import failed.'));
		}
	}

	private rejectPendingImport(document: vscode.CustomDocument, _importId: string, error: Error): void {
		const docKey = document.uri.toString();
		const pending = this.pendingImports.get(docKey);
		if (!pending || pending.document !== document || pending.importId !== _importId) {
			return;
		}
		clearTimeout(pending.timer);
		this.pendingImports.delete(docKey);
		pending.reject(error);
	}

	private rejectPendingImportsForDocument(document: vscode.CustomDocument, error: Error): void {
		const docKey = document.uri.toString();
		const pending = this.pendingImports.get(docKey);
		if (!pending || pending.document !== document) {
			return;
		}
		clearTimeout(pending.timer);
		this.pendingImports.delete(docKey);
		pending.reject(error);
	}

	private getContent(document: vscode.CustomDocument): Promise<string> {
		return this.readContent(document.uri.fsPath, path.extname(document.uri.fsPath));
	}

	private async readContent(filePath: string, extension: string): Promise<string> {
		switch (extension.toLowerCase()) {
			case '.xmind': {
				const data = await parser.xmindToJSON(filePath);
				return JSON.stringify(data) || '{}';
			}
			case '.km':
			case '.svg':
				return (await fs.promises.readFile(filePath, 'utf8')) || '{}';
			default:
				return '';
		}
	}

	private async writeContent(filePath: string, extension: string, content: string): Promise<void> {
		if (extension.toLowerCase() === '.xmind') {
			await parser.JSONToXmind(JSON.parse(content), filePath);
			return;
		}
		await fs.promises.writeFile(filePath, content, 'utf8');
	}

	get extensionChannels() {
		return vscode.extensions.all
			.filter((ext) => ext.isActive && ext.exports && ext.exports.exportedMessageChannel)
			.map((ext) => ext.exports.exportedMessageChannel);
	}
}
