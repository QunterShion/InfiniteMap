import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { logLifecycle } from '../lifecycle';
import { ImportExportHandler } from './ImportExportHandler';

const SAVE_TIMEOUT_MS = 10_000;
const IMPORT_TIMEOUT_MS = 10_000;

export interface DocumentState {
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

export interface MindEditorDocumentHost {
	getActivePanel(document: vscode.CustomDocument): vscode.WebviewPanel | undefined;
	onDocumentOpened(document: vscode.CustomDocument): void;
	onDocumentDisposed(document: vscode.CustomDocument): void;
	onDocumentStateChanged?(document: vscode.CustomDocument, state: DocumentState): void;
}

export class MindEditorDocument {
	public readonly documentStates = new Map<string, DocumentState>();
	private readonly documentOwners = new Map<string, vscode.CustomDocument>();
	private readonly documentWatchers = new Map<string, vscode.FileSystemWatcher>();
	private readonly externalChangeTimers = new Map<string, NodeJS.Timeout>();
	private readonly externalChangeRevisions = new Map<string, number>();
	private readonly reloadOperations = new Map<string, Promise<void>>();
	private readonly reloadInvocationCounts = new Map<string, number>();
	private readonly refreshRequestIds = new Map<string, string>();
	private readonly refreshOperations = new Map<string, Promise<void>>();
	private readonly documentIoTails = new Map<string, Promise<void>>();
	private readonly lastRenderedHashes = new Map<string, string>();
	private readonly pendingSaves = new Map<string, PendingSave>();
	private readonly pendingImports = new Map<string, PendingImport>();
	private nextSaveRequestId = 1;
	private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent>();
	public readonly onDidChangeCustomDocument = this.changeEmitter.event;

	constructor(
		private readonly host: MindEditorDocumentHost,
		private readonly importExport: ImportExportHandler
	) {}

	public async revertCustomDocument(document: vscode.CustomDocument): Promise<void> {
		const docKey = document.uri.toString();
		this.assertCurrent(document);
		const requestId = this.refreshRequestIds.get(docKey);
		this.reloadInvocationCounts.set(docKey, (this.reloadInvocationCounts.get(docKey) ?? 0) + 1);
		const existingOperation = this.reloadOperations.get(docKey);
		if (existingOperation) {
			return existingOperation;
		}
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

	public async backupCustomDocument(
		document: vscode.CustomDocument,
		context: vscode.CustomDocumentBackupContext
	): Promise<vscode.CustomDocumentBackup> {
		const content = this.getState(document).content;
		await this.enqueueIo(document, async () => {
			await fs.promises.mkdir(path.dirname(context.destination.fsPath), { recursive: true });
			await this.importExport.writeDocument(
				context.destination.fsPath,
				path.extname(document.uri.fsPath),
				content
			);
		});
		return {
			id: context.destination.toString(),
			delete: () => {
				void fs.promises.unlink(context.destination.fsPath).catch(() => undefined);
			},
		};
	}

	public saveCustomDocumentAs(
		document: vscode.CustomDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		return this.requestSave(document, destination, cancellation);
	}

	public async openCustomDocument(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext
	): Promise<vscode.CustomDocument> {
		const docKey = uri.toString();
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
		this.refreshOperations.delete(docKey);
		this.reloadOperations.delete(docKey);
		this.refreshRequestIds.delete(docKey);
		this.reloadInvocationCounts.delete(docKey);
		this.lastRenderedHashes.delete(docKey);
		logLifecycle('openCustomDocument.begin', {
			viewType: 'infinite-map.editor',
			documentUri: docKey,
			backupId: openContext.backupId ?? null,
			untitledDocumentData: Boolean(openContext.untitledDocumentData),
		});
		let content: string;
		if (openContext.backupId) {
			const backupUri = vscode.Uri.parse(openContext.backupId);
			content = await this.importExport.readDocument(backupUri.fsPath, path.extname(uri.fsPath));
		} else if (openContext.untitledDocumentData) {
			content = Buffer.from(openContext.untitledDocumentData).toString('utf8');
		} else {
			content = await this.importExport.readDocument(uri.fsPath, path.extname(uri.fsPath));
		}
		const lastDiskContent = openContext.backupId && uri.scheme === 'file'
			? await this.importExport.readDocument(uri.fsPath, path.extname(uri.fsPath)).catch(() => content)
			: content;
		if (this.documentOwners.has(docKey)) {
			this.disposeWatcher(docKey);
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
				this.disposeWatcher(docKey);
				this.documentStates.delete(docKey);
				this.documentOwners.delete(docKey);
				this.refreshRequestIds.delete(docKey);
				this.reloadInvocationCounts.delete(docKey);
				this.host.onDocumentDisposed(document);
			},
		};
		this.documentOwners.set(docKey, document);
		this.externalChangeRevisions.set(docKey, 0);
		this.watchDocument(document);
		this.host.onDocumentOpened(document);
		logLifecycle('openCustomDocument.complete', {
			viewType: 'infinite-map.editor',
			documentUri: docKey,
			restoredFromBackup: Boolean(openContext.backupId),
			dirty: Boolean(openContext.backupId),
		});
		return document;
	}

	public saveCustomDocument(
		document: vscode.CustomDocument,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		return this.requestSave(document, document.uri, cancellation);
	}

	public getState(document: vscode.CustomDocument): DocumentState {
		this.assertCurrent(document);
		const state = this.documentStates.get(document.uri.toString());
		if (!state) {
			throw new Error(`Document state is unavailable for ${document.uri.toString()}.`);
		}
		return state;
	}

	public getActiveRefresh(documentKey: string): Promise<void> | undefined {
		return this.refreshOperations.get(documentKey) || this.reloadOperations.get(documentKey);
	}

	public getRefreshRequestId(documentKey: string): string | undefined {
		return this.refreshRequestIds.get(documentKey);
	}

	public isBusy(documentKey: string): boolean {
		return this.refreshOperations.has(documentKey) || this.reloadOperations.has(documentKey);
	}

	public async refreshFromDisk(document: vscode.CustomDocument, requestId: string): Promise<void> {
		const docKey = document.uri.toString();
		const existingOperation = this.getActiveRefresh(docKey);
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

	public async completeSave(document: vscode.CustomDocument, content: string, requestId?: string): Promise<void> {
		const docKey = document.uri.toString();
		const pending = this.pendingSaves.get(docKey);
		if (!pending || pending.document !== document || !requestId || pending.requestId !== requestId) {
			return;
		}
		const destination = pending.destination;
		const state = this.getState(document);
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
		try {
			await this.persistContent(document, destination, content);
			state.content = content;
			pending.resolve();
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	public rejectPendingSave(
		docKey: string,
		error: Error,
		document?: vscode.CustomDocument,
		requestId?: string
	): void {
		const pending = this.pendingSaves.get(docKey);
		if (!pending || (document && pending.document !== document) || (requestId && pending.requestId !== requestId)) {
			return;
		}
		clearTimeout(pending.timer);
		pending.cancellationSubscription.dispose();
		this.pendingSaves.delete(docKey);
		pending.reject(error);
	}

	public async postImport(
		document: vscode.CustomDocument,
		content: string,
		importRequestId?: string
	): Promise<void> {
		this.assertCurrent(document);
		const panel = this.host.getActivePanel(document);
		if (!panel) {
			if (importRequestId) {
				throw new Error('The Webview panel is unavailable for this refresh.');
			}
			return;
		}
		const acknowledgement = importRequestId
			? this.waitForImport(document, importRequestId)
			: undefined;
		let delivered: boolean;
		try {
			const extension = path.extname(document.uri.fsPath);
			delivered = await panel.webview.postMessage({
				command: 'import',
				protocolVersion: 1,
				documentUri: document.uri.toString(),
				importData: content,
				extName: extension,
				...(extension.toLowerCase() === '.km'
					? { fileStem: path.basename(document.uri.fsPath, extension) }
					: {}),
				...(importRequestId ? { importRequestId } : {}),
			});
		} catch (error) {
			if (importRequestId) {
				this.rejectPendingImport(
					document,
					importRequestId,
					error instanceof Error ? error : new Error(String(error))
				);
			}
			throw error;
		}
		if (!delivered) {
			if (importRequestId) {
				this.rejectPendingImport(document, importRequestId, new Error('Webview import message was not delivered.'));
			}
			throw new Error('Webview import message was not delivered.');
		}
		if (acknowledgement) {
			await acknowledgement;
		}
		if (this.host.getActivePanel(document) !== panel) {
			throw new Error('The Webview panel was replaced before the refresh completed.');
		}
		this.assertCurrent(document);
		this.lastRenderedHashes.set(document.uri.toString(), this.hashContent(content));
	}

	public completePendingImport(
		document: vscode.CustomDocument,
		importId: string,
		ok: boolean,
		error?: string
	): void {
		const docKey = document.uri.toString();
		const pending = this.pendingImports.get(docKey);
		if (!pending || pending.document !== document || pending.importId !== importId) {
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

	public rejectPendingImportsForDocument(document: vscode.CustomDocument, error: Error): void {
		const docKey = document.uri.toString();
		const pending = this.pendingImports.get(docKey);
		if (!pending || pending.document !== document) {
			return;
		}
		clearTimeout(pending.timer);
		this.pendingImports.delete(docKey);
		pending.reject(error);
	}

	public async prepareWebview(document: vscode.CustomDocument): Promise<void> {
		const state = this.getState(document);
		if (!state.dirty && !state.externalConflict) {
			state.content = await this.getContent(document);
			state.lastDiskContent = state.content;
		}
		await this.postImport(document, state.content);
	}

	public async reconnectWebview(document: vscode.CustomDocument, exportData: unknown): Promise<void> {
		const state = this.getState(document);
		if (state.dirty && typeof exportData === 'string') {
			state.content = exportData;
		} else {
			await this.postImport(document, state.content);
		}
	}

	public updateDraft(document: vscode.CustomDocument, exportData: string): void {
		const docKey = document.uri.toString();
		if (this.isBusy(docKey)) {
			return;
		}
		const state = this.getState(document);
		state.content = exportData;
		state.dirty = true;
		this.notifyStateChanged(document, state);
		this.changeEmitter.fire({ document });
	}

	private assertCurrent(document: vscode.CustomDocument): void {
		const docKey = document.uri.toString();
		if (this.documentOwners.get(docKey) !== document || !this.documentStates.has(docKey)) {
			throw new Error(`Document closed before the reload completed: ${docKey}`);
		}
	}

	private async reloadCustomDocument(document: vscode.CustomDocument, importRequestId?: string): Promise<void> {
		const docKey = document.uri.toString();
		this.assertCurrent(document);
		const state = this.getState(document);
		const previousState = { ...state };
		try {
			let content = await this.getContent(document);
			this.assertCurrent(document);
			await this.postImport(document, content, importRequestId);
			this.assertCurrent(document);
			for (let attempt = 0; attempt < 10; attempt++) {
				const revisionBeforeRead = this.externalChangeRevisions.get(docKey) ?? 0;
				const latestContent = await this.getContent(document);
				this.assertCurrent(document);
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
				if (revisionAfterRead !== revisionBeforeRead
					|| (this.externalChangeRevisions.get(docKey) ?? 0) !== revisionAfterRead) {
					continue;
				}
				state.content = content;
				state.dirty = false;
				state.externalConflict = false;
				state.lastDiskContent = content;
				this.notifyStateChanged(document, state);
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

	private async runRefreshFromDisk(document: vscode.CustomDocument, requestId: string): Promise<void> {
		const docKey = document.uri.toString();
		const invocationBefore = this.reloadInvocationCounts.get(docKey) ?? 0;
		this.refreshRequestIds.set(docKey, requestId);
		try {
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
		this.assertCurrent(document);
		if (this.isBusy(docKey)) {
			return Promise.reject(new Error('Save cancelled because the document is being reloaded from disk.'));
		}
		if (destination.toString() === docKey && this.getState(document).externalConflict) {
			const error = new Error(
				'The mind map changed on disk while this editor had unsaved changes. Reload from disk or use Save As to avoid overwriting external edits.'
			);
			void vscode.window.showErrorMessage(error.message);
			return Promise.reject(error);
		}
		this.rejectPendingSave(docKey, new Error('A newer save request replaced the previous request.'), document);
		if (cancellation.isCancellationRequested) {
			return Promise.reject(new Error('Save cancelled.'));
		}
		const panel = this.host.getActivePanel(document);
		if (!panel) {
			return this.persistContent(document, destination, this.getState(document).content);
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
			void panel.webview.postMessage({ command: 'requestSave', protocolVersion: 1, requestId }).then((delivered) => {
				if (!delivered) {
					this.rejectPendingSave(
						docKey,
						new Error('Webview save request was not delivered.'),
						document,
						requestId
					);
				}
			}, (error) => {
				this.rejectPendingSave(
					docKey,
					error instanceof Error ? error : new Error(String(error)),
					document,
					requestId
				);
			});
		});
	}

	private persistContent(
		document: vscode.CustomDocument,
		destination: vscode.Uri,
		content: string
	): Promise<void> {
		return this.enqueueIo(document, () => this.persistContentNow(document, destination, content));
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
		const extension = path.extname(destination.fsPath) || path.extname(document.uri.fsPath);
		await this.importExport.writeDocument(destination.fsPath, extension, content);
		if (writesOriginal) {
			const state = this.getState(document);
			state.content = content;
			state.dirty = false;
			state.externalConflict = false;
			state.lastDiskContent = content;
			this.lastRenderedHashes.set(document.uri.toString(), this.hashContent(content));
			this.notifyStateChanged(document, state);
		}
	}

	private notifyStateChanged(document: vscode.CustomDocument, state: DocumentState): void {
		this.host.onDocumentStateChanged?.(document, state);
	}

	private async assertDiskUnchanged(document: vscode.CustomDocument): Promise<void> {
		const state = this.getState(document);
		let diskContent: string;
		try {
			diskContent = await this.getContent(document);
		} catch {
			await this.markExternalConflict(document, 'The mind map is no longer available on disk.');
			throw new Error('The mind map changed on disk before the save completed.');
		}
		if (diskContent !== state.lastDiskContent) {
			await this.markExternalConflict(document, 'The mind map changed on disk before the save completed.');
			throw new Error(
				'The mind map changed on disk before the save completed. Reload from disk or use Save As to preserve both versions.'
			);
		}
	}

	private enqueueIo(document: vscode.CustomDocument, operation: () => Promise<void>): Promise<void> {
		const docKey = document.uri.toString();
		const previousTail = this.documentIoTails.get(docKey) || Promise.resolve();
		const current = previousTail.then(() => {
			this.assertCurrent(document);
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
		this.externalChangeRevisions.set(docKey, (this.externalChangeRevisions.get(docKey) ?? 0) + 1);
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
		if (this.documentOwners.get(docKey) !== document || this.isBusy(docKey)) {
			return;
		}
		const state = this.getState(document);
		if (deleted) {
			await this.markExternalConflict(document, 'The mind map was deleted outside InfiniteMap.');
			return;
		}
		const content = await this.getContent(document);
		const contentHash = this.hashContent(content);
		if (contentHash === this.lastRenderedHashes.get(docKey)) {
			state.externalConflict = false;
			state.lastDiskContent = content;
			state.content = content;
			this.notifyStateChanged(document, state);
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
		this.notifyStateChanged(document, state);
		await this.postImport(document, content);
	}

	private async markExternalConflict(document: vscode.CustomDocument, message: string): Promise<void> {
		const state = this.getState(document);
		if (state.externalConflict) {
			return;
		}
		state.externalConflict = true;
		this.notifyStateChanged(document, state);
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

	private disposeWatcher(docKey: string): void {
		const timer = this.externalChangeTimers.get(docKey);
		if (timer) {
			clearTimeout(timer);
			this.externalChangeTimers.delete(docKey);
		}
		this.documentWatchers.get(docKey)?.dispose();
		this.documentWatchers.delete(docKey);
		this.externalChangeRevisions.delete(docKey);
		this.lastRenderedHashes.delete(docKey);
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

	private rejectPendingImport(document: vscode.CustomDocument, importId: string, error: Error): void {
		const docKey = document.uri.toString();
		const pending = this.pendingImports.get(docKey);
		if (!pending || pending.document !== document || pending.importId !== importId) {
			return;
		}
		clearTimeout(pending.timer);
		this.pendingImports.delete(docKey);
		pending.reject(error);
	}

	private getContent(document: vscode.CustomDocument): Promise<string> {
		return this.importExport.readDocument(document.uri.fsPath, path.extname(document.uri.fsPath));
	}

	private hashContent(content: string): string {
		return crypto.createHash('sha256').update(content).digest('hex');
	}
}
