import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	RootNameSyncEventGuard,
	RootNameSyncPlan,
	getKmFileStem,
	getKmRootText,
	planFileRenameAfterRootEdit,
	planRootUpdateAfterFileRename,
	replaceKmRootText,
} from './rootNameSync';
import {
	LOCK_EXPIRE_MS,
	LOCK_RETRY_INTERVAL_MS,
	LOCK_RETRY_LIMIT,
	atomicWriteJsonFile,
	getLockPath,
	withKmFileLock,
} from './mcp/services/kmExecState';

type RenamePlan = Extract<RootNameSyncPlan, { kind: 'rename-file' }>;

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath, fs.constants.F_OK);
		return true;
	} catch (error) {
		if (isMissingFile(error)) {
			return false;
		}
		throw error;
	}
}

async function isSameFile(leftPath: string, rightPath: string): Promise<boolean> {
	try {
		const [left, right] = await Promise.all([
			fs.promises.stat(leftPath),
			fs.promises.stat(rightPath),
		]);
		return left.dev === right.dev && left.ino === right.ino;
	} catch (error) {
		if (isMissingFile(error)) {
			return false;
		}
		throw error;
	}
}

async function wait(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function acquireKmLock(kmPath: string): Promise<() => Promise<void>> {
	const lockPath = getLockPath(kmPath);
	for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
		try {
			const handle = await fs.promises.open(lockPath, 'wx');
			await handle.writeFile(JSON.stringify({
				pid: process.pid,
				acquiredAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + LOCK_EXPIRE_MS).toISOString(),
			}));
			await handle.close();
			return async () => {
				await fs.promises.unlink(lockPath).catch((error) => {
					if (!isMissingFile(error)) {
						throw error;
					}
				});
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
			try {
				const holder = JSON.parse(await fs.promises.readFile(lockPath, 'utf8')) as { expiresAt?: unknown };
				if (typeof holder.expiresAt === 'string' && Date.parse(holder.expiresAt) < Date.now()) {
					await fs.promises.unlink(lockPath);
					continue;
				}
			} catch (lockError) {
				if (isMissingFile(lockError)) {
					continue;
				}
			}
			await wait(LOCK_RETRY_INTERVAL_MS);
		}
	}
	throw new Error(`Timed out waiting for another KM writer to finish: ${kmPath}`);
}

/**
 * Coordinates the pure root/name plans with VS Code file operations. Root edits
 * are validated before a save writes anything; the resulting rename happens
 * under the same sidecar lock used by KM MCP writers and never overwrites a
 * destination. Explorer renames use the filename as the authoritative value.
 */
export class RootNameSyncCoordinator implements vscode.Disposable {
	private readonly guard = new RootNameSyncEventGuard();
	private readonly renameSubscription: vscode.Disposable;

	constructor() {
		this.renameSubscription = vscode.workspace.onDidRenameFiles((event) => {
			for (const file of event.files) {
				void this.synchronizeRootAfterFileRename(file.oldUri, file.newUri).catch((error) => {
					void vscode.window.showErrorMessage(
						`Unable to synchronize the KM root name: ${error instanceof Error ? error.message : String(error)}`
					);
				});
			}
		});
	}

	dispose(): void {
		this.renameSubscription.dispose();
	}

	async planSavedContent(uri: vscode.Uri, content: string): Promise<RenamePlan | undefined> {
		if (uri.scheme !== 'file' || getKmFileStem(uri.fsPath) === undefined) {
			return undefined;
		}
		const plan = await planFileRenameAfterRootEdit(uri.fsPath, content, {
			exists: pathExists,
			isSameFile,
		});
		if (plan.kind === 'blocked') {
			throw new Error(plan.message);
		}
		return plan.kind === 'rename-file' ? plan : undefined;
	}

	async applySavedContentPlan(plan: RenamePlan): Promise<void> {
		const release = await acquireKmLock(plan.fromPath);
		try {
			const current = await fs.promises.readFile(plan.fromPath, 'utf8');
			if (current !== plan.content) {
				throw new Error('The KM file changed before its filename could be synchronized.');
			}
			this.guard.rememberRename(plan.fromPath, plan.toPath);
			const edit = new vscode.WorkspaceEdit();
			edit.renameFile(
				vscode.Uri.file(plan.fromPath),
				vscode.Uri.file(plan.toPath),
				{ overwrite: false, ignoreIfExists: false }
			);
			const applied = await vscode.workspace.applyEdit(edit);
			if (!applied) {
				throw new Error(`VS Code declined to rename the KM file to ${path.basename(plan.toPath)}.`);
			}
		} catch (error) {
			this.guard.consumeRename(plan.fromPath, plan.toPath);
			await this.restoreRootAfterFailedRename(plan).catch(() => undefined);
			throw error;
		} finally {
			await release();
		}
	}

	private async restoreRootAfterFailedRename(plan: RenamePlan): Promise<void> {
		if (!(await pathExists(plan.fromPath))) {
			return;
		}
		const current = await fs.promises.readFile(plan.fromPath, 'utf8');
		if (current !== plan.content) {
			return;
		}
		const originalStem = getKmFileStem(plan.fromPath);
		if (originalStem === undefined) {
			return;
		}
		atomicWriteJsonFile(plan.fromPath, replaceKmRootText(current, originalStem));
	}

	private async synchronizeRootAfterFileRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
		if (oldUri.scheme !== 'file' || newUri.scheme !== 'file') {
			return;
		}
		if (this.guard.consumeRename(oldUri.fsPath, newUri.fsPath)) {
			return;
		}
		if (getKmFileStem(newUri.fsPath) === undefined) {
			return;
		}

		withKmFileLock(newUri.fsPath, () => {
			const content = fs.readFileSync(newUri.fsPath, 'utf8');
			const plan = planRootUpdateAfterFileRename(newUri.fsPath, content);
			if (plan.kind === 'blocked') {
				throw new Error(plan.message);
			}
			if (plan.kind !== 'update-root') {
				return;
			}
			if (fs.readFileSync(newUri.fsPath, 'utf8') !== plan.expectedContent) {
				throw new Error('The KM file changed while its root name was being synchronized.');
			}
			this.guard.rememberRootWrite(newUri.fsPath, plan.rootText);
			atomicWriteJsonFile(newUri.fsPath, plan.content);
			if (getKmRootText(fs.readFileSync(newUri.fsPath, 'utf8')) !== plan.rootText) {
				throw new Error('The KM root name could not be verified after writing.');
			}
		});
	}
}
