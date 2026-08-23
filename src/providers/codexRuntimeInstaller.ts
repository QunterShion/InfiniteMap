import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const CODEX_VERSION = '0.147.0';
const RELEASE_BASE_URL = `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}`;

export type CodexInstallStage = 'downloading' | 'installing';

export interface CodexReleaseComponent {
	fileName: string;
	sha256: string;
	format: 'tar.gz' | 'executable';
	archiveExecutable?: string;
}

export interface CodexReleaseAsset extends CodexReleaseComponent {
	codeModeHost: CodexReleaseComponent;
}

const RELEASE_ASSETS: Record<string, CodexReleaseAsset> = {
	'darwin-arm64': {
		fileName: 'codex-aarch64-apple-darwin.tar.gz',
		sha256: '75984b81f92a71b0c0f4b3b5cad80e5c57177e4d8c8b4b1e13db703b20dc4358',
		format: 'tar.gz',
		archiveExecutable: 'codex-aarch64-apple-darwin',
		codeModeHost: {
			fileName: 'codex-code-mode-host-aarch64-apple-darwin.tar.gz',
			sha256: '56cdbf6187bf914108d3b7feeea5a34ffba15e5c162bedce69e062ee92ddfb5e',
			format: 'tar.gz',
			archiveExecutable: 'codex-code-mode-host-aarch64-apple-darwin',
		},
	},
	'darwin-x64': {
		fileName: 'codex-x86_64-apple-darwin.tar.gz',
		sha256: '36e782f71d8164cc37c2b89c64948f2180e9a2f8456b27e660da75bc6b5574e2',
		format: 'tar.gz',
		archiveExecutable: 'codex-x86_64-apple-darwin',
		codeModeHost: {
			fileName: 'codex-code-mode-host-x86_64-apple-darwin.tar.gz',
			sha256: '7131a0508de4dea60f79c816188b0b06b17f6ed417d9b3a1865b0a4927fbc48a',
			format: 'tar.gz',
			archiveExecutable: 'codex-code-mode-host-x86_64-apple-darwin',
		},
	},
	'linux-arm64': {
		fileName: 'codex-aarch64-unknown-linux-musl.tar.gz',
		sha256: 'eb677c80f666b1ab8b4b1d083b66e8d614b1281d960bb6f9fd8ca98f58b38b90',
		format: 'tar.gz',
		archiveExecutable: 'codex-aarch64-unknown-linux-musl',
		codeModeHost: {
			fileName: 'codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz',
			sha256: 'dfd4ff98ea4db30ed078af9c31b6f86e3da4836d0573aa87e225e5a5b54d3c7c',
			format: 'tar.gz',
			archiveExecutable: 'codex-code-mode-host-aarch64-unknown-linux-musl',
		},
	},
	'linux-x64': {
		fileName: 'codex-x86_64-unknown-linux-musl.tar.gz',
		sha256: '0246e2e773834e07f0fb5249ed6ebad12e4591e608f8c7bb97dd6a9690544c36',
		format: 'tar.gz',
		archiveExecutable: 'codex-x86_64-unknown-linux-musl',
		codeModeHost: {
			fileName: 'codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz',
			sha256: '0146adfaac8363ec9fcdb5895f7624db5b2e8617a283887938b7fb97a1dd4356',
			format: 'tar.gz',
			archiveExecutable: 'codex-code-mode-host-x86_64-unknown-linux-musl',
		},
	},
	'win32-arm64': {
		fileName: 'codex-aarch64-pc-windows-msvc.exe',
		sha256: '1f0e8c2dd3c6b471e985fac76908366c1cf31155094fde606fb2d3052cf00584',
		format: 'executable',
		codeModeHost: {
			fileName: 'codex-code-mode-host-aarch64-pc-windows-msvc.exe',
			sha256: 'd322d6d721cf7f7ae523bfe31a504875611ec21bbf9b2bffca4b9fd30bdb1675',
			format: 'executable',
		},
	},
	'win32-x64': {
		fileName: 'codex-x86_64-pc-windows-msvc.exe',
		sha256: '935a1911ed2556e4ffcec995f4886ac2ac425863ba26fed264df62e30272ad9d',
		format: 'executable',
		codeModeHost: {
			fileName: 'codex-code-mode-host-x86_64-pc-windows-msvc.exe',
			sha256: '37c23a542037e1bcfd0fa7eb4a150c697229d7ff31bf675c519d5bff7226b191',
			format: 'executable',
		},
	},
};

type DownloadFile = (url: string, destination: string) => Promise<void>;
type VerifyExecutable = (executable: string) => Promise<string>;

export interface CodexRuntimeInstallerOptions {
	storagePath: string;
	explicitExecutable?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	asset?: CodexReleaseAsset;
	downloadFile?: DownloadFile;
	verifyExecutable?: VerifyExecutable;
	verifyCodeModeHost?: VerifyExecutable;
}

export class CodexRuntimeInstaller {
	private readonly platform: NodeJS.Platform;
	private readonly arch: string;
	private readonly asset: CodexReleaseAsset;
	private readonly downloadFile: DownloadFile;
	private readonly verifyExecutable: VerifyExecutable;
	private readonly verifyCodeModeHost: VerifyExecutable;

	constructor(private readonly options: CodexRuntimeInstallerOptions) {
		this.platform = options.platform || process.platform;
		this.arch = options.arch || process.arch;
		const key = `${this.platform}-${this.arch}`;
		const asset = options.asset || RELEASE_ASSETS[key];
		if (!asset) {
			throw new Error(`Codex app-server is not available for ${key}.`);
		}
		this.asset = asset;
		this.downloadFile = options.downloadFile || downloadHttpsFile;
		this.verifyExecutable = options.verifyExecutable || verifyCodexExecutable;
		this.verifyCodeModeHost = options.verifyCodeModeHost || verifyCodexCodeModeHost;
	}

	public get executablePath(): string {
		const explicit = this.options.explicitExecutable?.trim();
		if (explicit) {
			return path.resolve(explicit);
		}
		return path.join(
			this.options.storagePath,
			'codex',
			CODEX_VERSION,
			`${this.platform}-${this.arch}`,
			this.platform === 'win32' ? 'codex.exe' : 'codex'
		);
	}

	public get codeModeHostPath(): string {
		return path.join(
			path.dirname(this.executablePath),
			this.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
		);
	}

	public async isInstalled(): Promise<boolean> {
		try {
			await fs.promises.access(this.executablePath, fs.constants.X_OK);
			if (!this.options.explicitExecutable?.trim()) {
				await fs.promises.access(this.codeModeHostPath, fs.constants.X_OK);
			}
			return true;
		} catch {
			return false;
		}
	}

	public async install(onStage: (stage: CodexInstallStage) => void = () => undefined): Promise<string> {
		if (await this.isInstalled()) {
			return this.executablePath;
		}
		if (this.options.explicitExecutable?.trim()) {
			throw new Error(`Configured Codex executable does not exist: ${this.executablePath}`);
		}

		const codexRoot = path.join(this.options.storagePath, 'codex');
		await fs.promises.mkdir(codexRoot, { recursive: true });
		const temporaryRoot = path.join(codexRoot, `.install-${randomUUID()}`);
		const downloadPath = path.join(temporaryRoot, `codex-${this.asset.fileName}`);
		const codeModeHostDownloadPath = path.join(temporaryRoot, `code-mode-host-${this.asset.codeModeHost.fileName}`);
		const stagedExecutable = path.join(
			temporaryRoot,
			this.platform === 'win32' ? 'codex.exe' : 'codex'
		);
		const stagedCodeModeHost = path.join(
			temporaryRoot,
			this.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
		);
		try {
			await fs.promises.mkdir(temporaryRoot, { recursive: true });
			onStage('downloading');
			await Promise.all([
				this.downloadFile(`${RELEASE_BASE_URL}/${this.asset.fileName}`, downloadPath),
				this.downloadFile(`${RELEASE_BASE_URL}/${this.asset.codeModeHost.fileName}`, codeModeHostDownloadPath),
			]);
			await Promise.all([
				this.assertChecksum(downloadPath, this.asset.sha256),
				this.assertChecksum(codeModeHostDownloadPath, this.asset.codeModeHost.sha256),
			]);

			onStage('installing');
			await this.stageComponent(this.asset, downloadPath, stagedExecutable, path.join(temporaryRoot, 'codex-extract'));
			await this.stageComponent(
				this.asset.codeModeHost,
				codeModeHostDownloadPath,
				stagedCodeModeHost,
				path.join(temporaryRoot, 'code-mode-host-extract')
			);
			if (this.platform !== 'win32') {
				await Promise.all([
					fs.promises.chmod(stagedExecutable, 0o755),
					fs.promises.chmod(stagedCodeModeHost, 0o755),
				]);
			}
			await Promise.all([
				this.verifyExecutable(stagedExecutable),
				this.verifyCodeModeHost(stagedCodeModeHost),
			]);

			const destinationDirectory = path.dirname(this.executablePath);
			await fs.promises.mkdir(destinationDirectory, { recursive: true });
			await Promise.all([
				fs.promises.rm(this.executablePath, { force: true }),
				fs.promises.rm(this.codeModeHostPath, { force: true }),
			]);
			await fs.promises.rename(stagedExecutable, this.executablePath);
			await fs.promises.rename(stagedCodeModeHost, this.codeModeHostPath);
			await fs.promises.writeFile(path.join(destinationDirectory, 'install.json'), JSON.stringify({
				version: CODEX_VERSION,
				platform: this.platform,
				arch: this.arch,
				asset: this.asset.fileName,
				sha256: this.asset.sha256,
				codeModeHostAsset: this.asset.codeModeHost.fileName,
				codeModeHostSha256: this.asset.codeModeHost.sha256,
				installedAt: new Date().toISOString(),
			}, null, 2), 'utf8');
			return this.executablePath;
		} finally {
			await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async stageComponent(
		component: CodexReleaseComponent,
		downloadPath: string,
		stagedPath: string,
		extractionDirectory: string
	): Promise<void> {
		if (component.format === 'executable') {
			await fs.promises.rename(downloadPath, stagedPath);
			return;
		}
		await fs.promises.mkdir(extractionDirectory, { recursive: true });
		await execFileAsync('tar', ['-xzf', downloadPath, '-C', extractionDirectory], { timeout: 60_000 });
		const archiveExecutable = path.join(extractionDirectory, component.archiveExecutable as string);
		await fs.promises.rename(archiveExecutable, stagedPath);
	}

	private async assertChecksum(filePath: string, expected: string): Promise<void> {
		const hash = createHash('sha256');
		await new Promise<void>((resolve, reject) => {
			const stream = fs.createReadStream(filePath);
			stream.on('data', (chunk) => hash.update(chunk));
			stream.once('error', reject);
			stream.once('end', resolve);
		});
		const actual = hash.digest('hex');
		if (actual !== expected) {
			throw new Error(`Codex download checksum mismatch: expected ${expected}, received ${actual}.`);
		}
	}
}

async function verifyCodexExecutable(executable: string): Promise<string> {
	const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 10_000 });
	const version = stdout.trim();
	if (!version) {
		throw new Error('Installed Codex runtime returned an empty version.');
	}
	return version;
}

async function verifyCodexCodeModeHost(executable: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync(executable, ['--help'], { timeout: 10_000 });
	const help = `${stdout}\n${stderr}`.trim();
	if (!help.includes('codex-code-mode-host')) {
		throw new Error('Installed Codex code-mode host returned unexpected help output.');
	}
	return help;
}

async function downloadHttpsFile(url: string, destination: string, redirects = 0): Promise<void> {
	if (redirects > 5) {
		throw new Error('Codex download exceeded the redirect limit.');
	}
	await new Promise<void>((resolve, reject) => {
		const request = https.get(url, {
			headers: { 'User-Agent': 'InfiniteMap/1.0.0 Codex installer' },
		}, (response) => {
			const location = response.headers.location;
			if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
				response.resume();
				const redirected = new URL(location, url).toString();
				downloadHttpsFile(redirected, destination, redirects + 1).then(resolve, reject);
				return;
			}
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`Codex download failed with HTTP ${response.statusCode || 'unknown'}.`));
				return;
			}
			const output = fs.createWriteStream(destination, { flags: 'wx' });
			response.pipe(output);
			output.once('finish', () => output.close(() => resolve()));
			output.once('error', reject);
			response.once('error', reject);
		});
		request.once('error', reject);
		request.setTimeout(120_000, () => request.destroy(new Error('Codex download timed out.')));
	});
}

export const CODEX_RUNTIME_VERSION = CODEX_VERSION;
