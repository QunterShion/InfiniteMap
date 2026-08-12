import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type ManagedRuntimeInstallStage = 'downloading' | 'installing';

export interface ManagedNpmRuntimeAsset {
	packageName: string;
	integrity: string;
	executable: string;
}

export interface ManagedNpmRuntimeInstallerOptions {
	storagePath: string;
	providerId: string;
	version: string;
	assets: Record<string, ManagedNpmRuntimeAsset>;
	platform?: NodeJS.Platform;
	arch?: string;
	downloadFile?: (url: string, destination: string) => Promise<void>;
	verifyExecutable?: (executable: string) => Promise<string>;
}

export class ManagedNpmRuntimeInstaller {
	private readonly platform: NodeJS.Platform;
	private readonly arch: string;
	private readonly asset: ManagedNpmRuntimeAsset;
	private readonly downloadFile: (url: string, destination: string) => Promise<void>;
	private readonly verifyExecutable: (executable: string) => Promise<string>;

	constructor(private readonly options: ManagedNpmRuntimeInstallerOptions) {
		this.platform = options.platform || process.platform;
		this.arch = options.arch || process.arch;
		const key = `${this.platform}-${this.arch}`;
		const asset = options.assets[key];
		if (!asset) {
			throw new Error(`${options.providerId} runtime is not available for ${key}.`);
		}
		this.asset = asset;
		this.downloadFile = options.downloadFile || downloadHttpsFile;
		this.verifyExecutable = options.verifyExecutable || verifyRuntimeExecutable;
	}

	public get executablePath(): string {
		return path.join(this.runtimeDirectory, 'package', this.asset.executable);
	}

	public async isInstalled(): Promise<boolean> {
		try {
			await fs.promises.access(this.executablePath, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	public async install(
		onStage: (stage: ManagedRuntimeInstallStage) => void = () => undefined
	): Promise<string> {
		if (await this.isInstalled()) {
			return this.executablePath;
		}
		const providerRoot = path.join(this.options.storagePath, 'runtimes', this.options.providerId);
		await fs.promises.mkdir(providerRoot, { recursive: true });
		const temporaryRoot = path.join(providerRoot, `.install-${randomUUID()}`);
		const archivePath = path.join(temporaryRoot, 'runtime.tgz');
		try {
			await fs.promises.mkdir(temporaryRoot, { recursive: true });
			onStage('downloading');
			await this.downloadFile(this.tarballUrl, archivePath);
			await this.assertIntegrity(archivePath);

			onStage('installing');
			await execFileAsync('tar', ['-xzf', archivePath, '-C', temporaryRoot], { timeout: 180_000 });
			const stagedExecutable = path.join(temporaryRoot, 'package', this.asset.executable);
			if (this.platform !== 'win32') {
				await fs.promises.chmod(stagedExecutable, 0o755);
			}
			await this.verifyExecutable(stagedExecutable);
			await fs.promises.rm(archivePath, { force: true });

			await fs.promises.mkdir(path.dirname(this.runtimeDirectory), { recursive: true });
			try {
				await fs.promises.rename(temporaryRoot, this.runtimeDirectory);
			} catch (error) {
				if (!(await this.isInstalled())) {
					throw error;
				}
			}
			await fs.promises.writeFile(path.join(this.runtimeDirectory, 'install.json'), JSON.stringify({
				providerId: this.options.providerId,
				version: this.options.version,
				platform: this.platform,
				arch: this.arch,
				packageName: this.asset.packageName,
				integrity: this.asset.integrity,
				installedAt: new Date().toISOString(),
			}, null, 2), 'utf8');
			return this.executablePath;
		} finally {
			await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private get runtimeDirectory(): string {
		return path.join(
			this.options.storagePath,
			'runtimes',
			this.options.providerId,
			this.options.version,
			`${this.platform}-${this.arch}`
		);
	}

	private get tarballUrl(): string {
		const packageLeaf = this.asset.packageName.slice(this.asset.packageName.lastIndexOf('/') + 1);
		return `https://registry.npmjs.org/${this.asset.packageName}/-/${packageLeaf}-${this.options.version}.tgz`;
	}

	private async assertIntegrity(filePath: string): Promise<void> {
		const expected = this.asset.integrity.replace(/^sha512-/, '');
		const hash = createHash('sha512');
		await new Promise<void>((resolve, reject) => {
			const stream = fs.createReadStream(filePath);
			stream.on('data', (chunk) => hash.update(chunk));
			stream.once('error', reject);
			stream.once('end', resolve);
		});
		const actual = hash.digest('base64');
		if (actual !== expected) {
			throw new Error(`${this.options.providerId} download integrity mismatch.`);
		}
	}
}

async function verifyRuntimeExecutable(executable: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync(executable, ['--version'], { timeout: 15_000 });
	const version = `${stdout || ''}${stderr || ''}`.trim();
	if (!version) {
		throw new Error('Managed Provider runtime returned an empty version.');
	}
	return version;
}

async function downloadHttpsFile(url: string, destination: string, redirects = 0): Promise<void> {
	if (redirects > 5) {
		throw new Error('Provider runtime download exceeded the redirect limit.');
	}
	await new Promise<void>((resolve, reject) => {
		const request = https.get(url, {
			headers: { 'User-Agent': 'InfiniteMap/1.0.0 Provider runtime installer' },
		}, (response) => {
			const location = response.headers.location;
			if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
				response.resume();
				downloadHttpsFile(new URL(location, url).toString(), destination, redirects + 1).then(resolve, reject);
				return;
			}
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`Provider runtime download failed with HTTP ${response.statusCode || 'unknown'}.`));
				return;
			}
			const output = fs.createWriteStream(destination, { flags: 'wx' });
			response.pipe(output);
			output.once('finish', () => output.close(() => resolve()));
			output.once('error', reject);
			response.once('error', reject);
		});
		request.once('error', reject);
		request.setTimeout(300_000, () => request.destroy(new Error('Provider runtime download timed out.')));
	});
}
