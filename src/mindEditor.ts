import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { selectFile, getRootUri, changeSvgImg } from "./util";
const xmindparser = require('./xmindparser');
let parser = new xmindparser();

const { Resvg, initWasm } = require('./wasm');
const index_bg = fs.readFileSync(path.join(__dirname, '../webui/resvg-js/index_bg.wasm'));
initWasm(index_bg);
const fontPath = path.join(__dirname, '../webui/resvg-js/fonts/Alibaba_PuHuiTi_2.0_45_Light_45_Light.ttf');

const matchableFileTypes: string[] = ['xmind', 'km', 'svg'];
const viewType = 'infinite-map.editor';
const SAVE_TIMEOUT_MS = 10000;

interface DocumentState {
	content: string;
	dirty: boolean;
	externalConflict: boolean;
	lastDiskContent: string;
}

interface PendingSave {
	destination: vscode.Uri;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	cancellationSubscription: vscode.Disposable;
}

export class MindEditorProvider implements vscode.CustomEditorProvider {
	private activePanels = new Map<string, vscode.WebviewPanel>();
	private documentStates = new Map<string, DocumentState>();
	private documentWatchers = new Map<string, vscode.FileSystemWatcher>();
	private externalChangeTimers = new Map<string, NodeJS.Timeout>();
	private pendingSaves = new Map<string, PendingSave>();

	constructor(public context: vscode.ExtensionContext) {
		this.context = context;
	}

	static register(context: vscode.ExtensionContext) {
		const provider = new MindEditorProvider(context);
		const providerRegistration = vscode.window.registerCustomEditorProvider(viewType, provider, {
			webviewOptions: {
				retainContextWhenHidden: true,
			},
			supportsMultipleEditorsPerDocument: false,
		});
		return providerRegistration;
	}

	async revertCustomDocument(document: vscode.CustomDocument, _cancellation?: vscode.CancellationToken): Promise<void> {
		const content = await this.getContent(document);
		this.documentStates.set(document.uri.toString(), {
			content,
			dirty: false,
			externalConflict: false,
			lastDiskContent: content,
		});
		await this.postImport(document, content);
	}

	async backupCustomDocument(
		document: vscode.CustomDocument,
		context: vscode.CustomDocumentBackupContext,
		_cancellation: vscode.CancellationToken
	): Promise<vscode.CustomDocumentBackup> {
		const state = this.getDocumentState(document);
		await fs.promises.mkdir(path.dirname(context.destination.fsPath), { recursive: true });
		await this.writeContent(context.destination.fsPath, path.extname(document.uri.fsPath), state.content);
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
		this.documentStates.set(docKey, {
			content,
			dirty: Boolean(openContext.backupId),
			externalConflict: false,
			lastDiskContent,
		});
		const document: vscode.CustomDocument = {
			uri,
			dispose: () => {
				this.rejectPendingSave(docKey, new Error('Document closed before the save completed.'));
				this.disposeDocumentWatcher(docKey);
				this.documentStates.delete(docKey);
				this.activePanels.delete(docKey);
			},
		};
		this.watchDocument(document);
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
			return;
		}
		const panel = webviewPanel;
		const docKey = document.uri.toString();
		this.activePanels.set(docKey, panel);
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'webui'))],
		};
		panel.webview.html = html;

		let missedPings = 0;
		let awaitingPong = false;
		let heartbeatBusy = false;
		let reconnecting = false;
		const PING_INTERVAL = 15000;
		const MAX_MISSED = 3;

		const reconnectWebview = () => {
			if (reconnecting) {
				return;
			}
			reconnecting = true;
			clearInterval(heartbeatTimer);
			panel.dispose();
			void vscode.commands.executeCommand('vscode.openWith', document.uri, viewType);
		};

		const heartbeatTimer = setInterval(async () => {
			if (heartbeatBusy || reconnecting) {
				return;
			}
			heartbeatBusy = true;
			try {
				if (awaitingPong) {
					missedPings += 1;
				}
				if (missedPings >= MAX_MISSED) {
					reconnectWebview();
					return;
				}
				const delivered = await panel.webview.postMessage({ command: 'ping' });
				if (delivered) {
					awaitingPong = true;
				} else {
					missedPings += 1;
					if (missedPings >= MAX_MISSED) {
						reconnectWebview();
					}
				}
			} catch {
				missedPings += 1;
				if (missedPings >= MAX_MISSED) {
					reconnectWebview();
				}
			} finally {
				heartbeatBusy = false;
			}
		}, PING_INTERVAL);

		panel.onDidDispose(() => {
			clearInterval(heartbeatTimer);
			this.activePanels.delete(docKey);
			this.rejectPendingSave(docKey, new Error('Webview closed before the save completed.'));
		});

		panel.webview.onDidReceiveMessage(
				async (message: any) => {
					switch (message.command) {
						case 'loaded':
							const state = this.getDocumentState(document);
							if (!state.dirty && !state.externalConflict) {
								state.content = await this.getContent(document);
								state.lastDiskContent = state.content;
							}
							await this.postImport(document, state.content);
							return;
						case 'refresh':
							await vscode.commands.executeCommand('workbench.action.files.revert');
							return;
						case 'pong':
							awaitingPong = false;
							missedPings = 0;
							return;
						case 'save':
							try {
								await this.completeSave(document, message.exportData);
							} catch (ex) {
								this.rejectPendingSave(docKey, ex instanceof Error ? ex : new Error(String(ex)));
								if (!(ex instanceof Error && ex.message.includes('changed on disk'))) {
									console.error(ex);
								}
							}
							return;
						case 'draft':
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
			this.context.subscriptions
		);
	}

	private notifyExternalExtensions(message: any) {
		this.extensionChannels.forEach((chanel) => {
			chanel.postMessage(message);
		});
	}

	private getDocumentState(document: vscode.CustomDocument): DocumentState {
		const state = this.documentStates.get(document.uri.toString());
		if (!state) {
			throw new Error(`Document state is unavailable for ${document.uri.toString()}.`);
		}
		return state;
	}

	private requestSave(
		document: vscode.CustomDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		const docKey = document.uri.toString();
		if (destination.toString() === docKey && this.getDocumentState(document).externalConflict) {
			const error = new Error(
				'The mind map changed on disk while this editor had unsaved changes. Reload from disk or use Save As to avoid overwriting external edits.'
			);
			void vscode.window.showErrorMessage(error.message);
			return Promise.reject(error);
		}
		this.rejectPendingSave(docKey, new Error('A newer save request replaced the previous request.'));
		if (cancellation.isCancellationRequested) {
			return Promise.reject(new Error('Save cancelled.'));
		}

		const panel = this.activePanels.get(docKey);
		if (!panel) {
			return this.persistContent(document, destination, this.getDocumentState(document).content);
		}

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.rejectPendingSave(docKey, new Error('Timed out waiting for the Webview save response.'));
			}, SAVE_TIMEOUT_MS);
			const cancellationSubscription = cancellation.onCancellationRequested(() => {
				this.rejectPendingSave(docKey, new Error('Save cancelled.'));
			});
			this.pendingSaves.set(docKey, {
				destination,
				resolve,
				reject,
				timer,
				cancellationSubscription,
			});
			void panel.webview.postMessage({ command: 'requestSave' }).then(
				(delivered) => {
					if (!delivered) {
						this.rejectPendingSave(docKey, new Error('Webview save request was not delivered.'));
					}
				},
				(error) => {
					this.rejectPendingSave(docKey, error instanceof Error ? error : new Error(String(error)));
				}
			);
		});
	}

	private async completeSave(document: vscode.CustomDocument, content: string): Promise<void> {
		const docKey = document.uri.toString();
		const pending = this.pendingSaves.get(docKey);
		const destination = pending?.destination ?? document.uri;
		const state = this.getDocumentState(document);
		if (destination.toString() === docKey && state.externalConflict) {
			throw new Error(
				'The mind map changed on disk before the save completed. Reload from disk or use Save As to preserve both versions.'
			);
		}
		state.content = content;
		await this.persistContent(document, destination, content);
		if (pending) {
			clearTimeout(pending.timer);
			pending.cancellationSubscription.dispose();
			this.pendingSaves.delete(docKey);
			pending.resolve();
		}
	}

	private async persistContent(
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
		const state = this.documentStates.get(document.uri.toString());
		if (!state) {
			return;
		}

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
	}

	private rejectPendingSave(docKey: string, error: Error): void {
		const pending = this.pendingSaves.get(docKey);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		pending.cancellationSubscription.dispose();
		this.pendingSaves.delete(docKey);
		pending.reject(error);
	}

	private async postImport(document: vscode.CustomDocument, content: string): Promise<void> {
		const panel = this.activePanels.get(document.uri.toString());
		if (!panel) {
			return;
		}
		const delivered = await panel.webview.postMessage({
			command: 'import',
			importData: content,
			extName: path.extname(document.uri.fsPath),
		});
		if (!delivered) {
			throw new Error('Webview import message was not delivered.');
		}
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
