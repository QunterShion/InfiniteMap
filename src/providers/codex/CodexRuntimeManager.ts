import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { CodexAppServerClient } from './CodexAppServerClient';
import {
	assertCodexGeneratedProtocolSurface,
	assertCodexGeneratedServerResponses,
	CODEX_METHODS,
	CodexModel,
} from './protocol';

const execFileAsync = promisify(execFile);

export interface CodexRuntimeProbe {
	executable: string;
	version: string;
	fingerprint: string;
	models: CodexModel[];
	authenticated: boolean;
	requiresOpenaiAuth: boolean;
	client: CodexAppServerClient;
}

export interface CodexRuntimeManagerOptions {
	explicitExecutable?: string;
	storagePath: string;
	environmentPath?: string;
}

export class CodexRuntimeManager {
	private probeResult: CodexRuntimeProbe | undefined;
	private probeOperation: Promise<CodexRuntimeProbe> | undefined;

	constructor(private readonly options: CodexRuntimeManagerOptions) {}

	public async probe(force = false): Promise<CodexRuntimeProbe> {
		if (!force && this.probeResult) {
			return this.probeResult;
		}
		if (!force && this.probeOperation) {
			return this.probeOperation;
		}
		const operation = this.runProbe();
		this.probeOperation = operation;
		try {
			const result = await operation;
			this.probeResult?.client.dispose();
			this.probeResult = result;
			return result;
		} finally {
			if (this.probeOperation === operation) {
				this.probeOperation = undefined;
			}
		}
	}

	public invalidate(): void {
		this.probeResult?.client.dispose();
		this.probeResult = undefined;
	}

	public dispose(): void {
		this.invalidate();
	}

	public async authenticate(openUrl: (url: string) => Promise<boolean>): Promise<void> {
		const probe = await this.probe();
		if (probe.authenticated) {
			return;
		}
		const response = await probe.client.request<{
			type: string;
			loginId?: string | null;
			authUrl?: string;
		}>(CODEX_METHODS.accountLoginStart, {
			type: 'chatgpt',
			useHostedLoginSuccessPage: true,
			appBrand: 'codex',
		});
		if (response?.type !== 'chatgpt' || !response.loginId || !response.authUrl) {
			throw new Error('Codex account/login/start response is missing loginId or authUrl.');
		}
		let removeListener: (() => void) | undefined;
		let removeDisconnectListener: (() => void) | undefined;
		let timer: NodeJS.Timeout | undefined;
		const completed = new Promise<void>((resolve, reject) => {
			removeListener = probe.client.onNotification((notification) => {
				if (notification.method !== CODEX_METHODS.accountLoginCompleted ||
					notification.params?.loginId !== response.loginId) {
					return;
				}
				if (notification.params?.success) {
					resolve();
				} else {
					reject(new Error(notification.params?.error || 'Codex authentication failed.'));
				}
			});
			removeDisconnectListener = probe.client.onDisconnect(reject);
			timer = setTimeout(() => reject(new Error('Codex authentication timed out.')), 300_000);
		});
		try {
			if (!(await openUrl(response.authUrl))) {
				throw new Error('Codex authentication URL could not be opened.');
			}
			await completed;
			this.invalidate();
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			removeListener?.();
			removeDisconnectListener?.();
		}
	}

	private async runProbe(): Promise<CodexRuntimeProbe> {
		const executable = await this.resolveExecutable();
		const [{ stdout }, stat] = await Promise.all([
			execFileAsync(executable, ['--version'], { timeout: 10_000 }),
			fs.promises.stat(executable),
		]);
		const version = stdout.trim();
		if (!version) {
			throw new Error('Codex runtime returned an empty version.');
		}
		const binaryHash = await this.hashFile(executable);
		const fingerprint = createHash('sha256').update(JSON.stringify({
			executable,
			version,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			binaryHash,
			experimentalApi: true,
		})).digest('hex');
		await this.ensureSchemas(executable, fingerprint);

		const client = new CodexAppServerClient({
			executable,
		});
		try {
			await client.start();
			const account = await client.request<{ account: unknown | null; requiresOpenaiAuth: boolean }>(
				CODEX_METHODS.accountRead,
				{ refreshToken: false }
			);
			const authenticated = account.account !== null || account.requiresOpenaiAuth === false;
			const models = authenticated ? await client.readModels() : [];
			return {
				executable,
				version,
				fingerprint,
				models,
				authenticated,
				requiresOpenaiAuth: account.requiresOpenaiAuth,
				client,
			};
		} catch (error) {
			client.dispose();
			throw error;
		}
	}

	private async resolveExecutable(): Promise<string> {
		const explicit = this.options.explicitExecutable?.trim();
		if (explicit) {
			return this.validateExecutable(explicit, true);
		}
		const pathValue = this.options.environmentPath ?? process.env.PATH ?? '';
		const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
		for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
			for (const name of names) {
				const candidate = path.join(directory, name);
				try {
					return await this.validateExecutable(candidate, true);
				} catch {
					// Continue through PATH candidates.
				}
			}
		}
		throw new Error('Codex runtime was not found. Configure infiniteMap.codex.executable or install codex on PATH.');
	}

	private async validateExecutable(candidate: string, rejectPrivateBundled: boolean): Promise<string> {
		const realpath = await fs.promises.realpath(path.resolve(candidate));
		if (rejectPrivateBundled && this.isPrivateExtensionBinary(realpath)) {
			throw new Error('Private Codex VS Code extension binaries cannot be used by the InfiniteMap managed runtime.');
		}
		await fs.promises.access(realpath, fs.constants.X_OK);
		return realpath;
	}

	private isPrivateExtensionBinary(candidate: string): boolean {
		const normalized = candidate.replace(/\\/g, '/').toLowerCase();
		return normalized.includes('/.vscode/extensions/openai.chatgpt-')
			|| normalized.includes('/.vscode-insiders/extensions/openai.chatgpt-');
	}

	private async ensureSchemas(executable: string, fingerprint: string): Promise<void> {
		const root = path.join(this.options.storagePath, 'schemas');
		const target = path.join(root, fingerprint);
		const marker = path.join(target, '.complete');
		try {
			await fs.promises.access(marker);
			await this.validateGeneratedSchemas(target);
			return;
		} catch {
			// Generate schemas below.
		}
		await fs.promises.mkdir(root, { recursive: true });
		const lockPath = path.join(root, `${fingerprint}.lock`);
		let lock: fs.promises.FileHandle | undefined;
		try {
			lock = await fs.promises.open(lockPath, 'wx');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
				await this.waitForSchemaGeneration(marker, lockPath);
				await this.validateGeneratedSchemas(target);
				return;
			}
			throw error;
		}
		await fs.promises.unlink(marker).catch(() => undefined);
		const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'infinite-map-codex-schema-'));
		try {
			await execFileAsync(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', temporary], {
				timeout: 60_000,
				maxBuffer: 8 * 1024 * 1024,
			});
			await this.validateGeneratedSchemas(temporary);
			await fs.promises.writeFile(path.join(temporary, '.complete'), fingerprint, 'utf8');
			await fs.promises.rm(target, { recursive: true, force: true });
			await fs.promises.rename(temporary, target);
			await this.validateGeneratedSchemas(target);
		} finally {
			await lock.close();
			await fs.promises.unlink(lockPath).catch(() => undefined);
			await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async validateGeneratedSchemas(root: string): Promise<void> {
		const protocolNames = {
			clientRequests: 'ClientRequest.json',
			clientNotifications: 'ClientNotification.json',
			serverRequests: 'ServerRequest.json',
			serverNotifications: 'ServerNotification.json',
		} as const;
		const protocolEntries = await Promise.all(Object.entries(protocolNames).map(async ([category, name]) => {
			const content = await fs.promises.readFile(path.join(root, name), 'utf8');
			return [category, JSON.parse(content)] as const;
		}));
		assertCodexGeneratedProtocolSurface(Object.fromEntries(protocolEntries) as {
			clientRequests: unknown;
			clientNotifications: unknown;
			serverRequests: unknown;
			serverNotifications: unknown;
		});
		const responseNames = {
			commandApproval: 'CommandExecutionRequestApprovalResponse.json',
			fileChangeApproval: 'FileChangeRequestApprovalResponse.json',
			requestUserInput: 'ToolRequestUserInputResponse.json',
			mcpElicitation: 'McpServerElicitationRequestResponse.json',
			permissionsApproval: 'PermissionsRequestApprovalResponse.json',
		} as const;
		const responseEntries = await Promise.all(Object.entries(responseNames).map(async ([category, name]) => {
			const content = await fs.promises.readFile(path.join(root, name), 'utf8');
			return [category, JSON.parse(content)] as const;
		}));
		assertCodexGeneratedServerResponses(Object.fromEntries(responseEntries) as {
			commandApproval: unknown;
			fileChangeApproval: unknown;
			requestUserInput: unknown;
			mcpElicitation: unknown;
			permissionsApproval: unknown;
		});
	}

	private async waitForSchemaGeneration(marker: string, lockPath: string): Promise<void> {
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				await fs.promises.access(lockPath);
			} catch {
				try {
					await fs.promises.access(marker);
					return;
				} catch {
					// The generator failed or has not published its validated cache yet.
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error('Timed out waiting for Codex schema generation.');
	}

	private async hashFile(filePath: string): Promise<string> {
		const hash = createHash('sha256');
		await new Promise<void>((resolve, reject) => {
			const stream = fs.createReadStream(filePath);
			stream.on('data', (chunk) => hash.update(chunk));
			stream.once('error', reject);
			stream.once('end', resolve);
		});
		return hash.digest('hex');
	}
}
