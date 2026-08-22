import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeAgentSessionAdapter, CLAUDE_API_KEY_SECRET } from './claude/ClaudeAgentSessionAdapter';
import { CodexAgentSessionAdapter } from './codex/CodexAgentSessionAdapter';
import { CodexRuntimeManager } from './codex/CodexRuntimeManager';
import { CopilotAgentSessionAdapter, COPILOT_GITHUB_TOKEN_SECRET } from './copilot/CopilotAgentSessionAdapter';
import { CopilotRuntimeManager } from './copilot/CopilotRuntimeManager';
import { CodexRuntimeInstaller, CodexRuntimeInstallerOptions } from './codexRuntimeInstaller';
import {
	CLAUDE_RUNTIME_ASSETS,
	CLAUDE_RUNTIME_VERSION,
	COPILOT_RUNTIME_ASSETS,
	COPILOT_RUNTIME_VERSION,
} from './managedProviderAssets';
import { ManagedNpmRuntimeInstaller } from './managedNpmRuntimeInstaller';
import {
	ProviderComponentApiV1,
	ProviderDescriptor,
	ProviderInstallationResult,
	ProviderInstallPhase,
	SessionCapabilities,
} from '../sessions/types';

const COMPONENT_ID = 'chanterxiao.infinite-map';

const PROVIDERS = [
	{ id: 'codex', displayName: 'Codex' },
	{ id: 'claudecode', displayName: 'Claude Agent' },
	{ id: 'copilot', displayName: 'Copilot' },
] as const;

type ProviderId = typeof PROVIDERS[number]['id'];
type Installer = {
	readonly executablePath: string;
	install(onStage?: (stage: 'downloading' | 'installing') => void): Promise<string>;
	isInstalled(): Promise<boolean>;
};

export interface ProviderComponentRegistryOptions {
	storagePath: string;
	secretStorage?: vscode.SecretStorage;
	explicitCodexExecutable?: string;
	experimentalCodexApi?: boolean;
	installer?: Installer;
	installers?: Partial<Record<ProviderId, Installer>>;
	componentFactory?: () => ProviderComponentApiV1;
	componentFactories?: Partial<Record<ProviderId, () => ProviderComponentApiV1>>;
	runtimeFactory?: (executable: string, storagePath: string) => CodexRuntimeManager;
	copilotRuntimeFactory?: (executable: string, storagePath: string) => CopilotRuntimeManager;
}

function unavailableCapabilities(): SessionCapabilities {
	return {
		availability: 'missing',
		lifecycle: {
			create: 'unsupported',
			resume: 'unsupported',
			list: 'unsupported',
			read: 'unsupported',
			interrupt: 'unsupported',
		},
		inputMode: 'next-turn-only',
		mutations: {
			rename: 'unsupported',
			setModel: 'unsupported',
			archive: 'unsupported',
		},
		toolPermissionModes: {
			select: 'unsupported',
			switching: 'unsupported',
		},
		canStream: false,
		kmTaskExecution: false,
		receiptMode: 'prompt-only',
		openTargets: ['infinite-map'],
		sessionOwnership: 'infinite-map',
	};
}

export class ProviderComponentRegistry implements vscode.Disposable {
	private readonly installers = new Map<ProviderId, Installer>();
	private readonly componentFactories = new Map<ProviderId, () => ProviderComponentApiV1>();
	private readonly components = new Map<ProviderId, ProviderComponentApiV1>();
	private codexRuntime: CodexRuntimeManager | undefined;
	private copilotRuntime: CopilotRuntimeManager | undefined;
	// Copilot-P1-01：监听 SecretStorage 变更（token 外部刷新时通知 SDK 重建 client）
	private secretStorageChangeSubscription: vscode.Disposable | undefined;
	// Main-P1-02：provider 状态变更事件（认证完成、安装完成时触发）
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly options: ProviderComponentRegistryOptions) {
		this.installers.set('codex', options.installers?.codex || options.installer || new CodexRuntimeInstaller({
			storagePath: options.storagePath,
			explicitExecutable: options.explicitCodexExecutable,
		} as CodexRuntimeInstallerOptions));
		this.installers.set('claudecode', options.installers?.claudecode || new ManagedNpmRuntimeInstaller({
			storagePath: options.storagePath,
			providerId: 'claudecode',
			version: CLAUDE_RUNTIME_VERSION,
			assets: CLAUDE_RUNTIME_ASSETS,
		}));
		this.installers.set('copilot', options.installers?.copilot || new ManagedNpmRuntimeInstaller({
			storagePath: options.storagePath,
			providerId: 'copilot',
			version: COPILOT_RUNTIME_VERSION,
			assets: COPILOT_RUNTIME_ASSETS,
		}));

		this.componentFactories.set('codex', options.componentFactories?.codex
			|| options.componentFactory
			|| (() => this.createCodexComponent()));
		this.componentFactories.set('claudecode', options.componentFactories?.claudecode
			|| (() => this.createClaudeComponent()));
		this.componentFactories.set('copilot', options.componentFactories?.copilot
			|| (() => this.createCopilotComponent()));
	}

	public async discover(): Promise<ProviderDescriptor[]> {
		return Promise.all(PROVIDERS.map(async (provider) => {
			const installer = this.requireInstaller(provider.id);
			if (!(await installer.isInstalled())) {
				return this.missingDescriptor(provider.id);
			}
			const component = this.components.get(provider.id);
			if (!component) {
				return {
					...this.missingDescriptor(provider.id),
					installState: 'installed_inactive' as const,
					capabilities: { ...unavailableCapabilities(), availability: 'starting' as const },
				};
			}
			return component.getDescriptor();
		}));
	}

	public async load(providerId: string): Promise<ProviderComponentApiV1> {
		const id = this.assertProvider(providerId);
		const installer = this.requireInstaller(id);
		if (!(await installer.isInstalled())) {
			throw this.withCode('PROVIDER_COMPONENT_MISSING', `${this.provider(id).displayName} runtime is not installed for InfiniteMap.`);
		}
		let component = this.components.get(id);
		if (!component) {
			component = this.requireComponentFactory(id)();
			this.components.set(id, component);
		}
		if (component.apiVersion !== '1') {
			throw this.withCode('PROVIDER_INCOMPATIBLE', `The built-in ${this.provider(id).displayName} Provider API is incompatible.`);
		}
		const descriptor = await component.getDescriptor();
		if (descriptor.id !== id || descriptor.componentExtensionId !== COMPONENT_ID) {
			throw this.withCode('PROVIDER_INCOMPATIBLE', `The built-in ${this.provider(id).displayName} Provider identity is invalid.`);
		}
		return component;
	}

	public async openInstallation(
		providerId: string,
		onProgress: (phase: ProviderInstallPhase) => void = () => undefined
	): Promise<ProviderInstallationResult> {
		const id = this.assertProvider(providerId);
		const provider = this.provider(id);
		const installer = this.requireInstaller(id);
		const alreadyInstalled = await installer.isInstalled();
		if (alreadyInstalled) {
			onProgress('verifying');
			const result = await this.verifyInstallation(id, true);
			this.changeEmitter.fire(); // Main-P1-02：安装已存在时也通知 UI 刷新
			return result;
		}

		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `InfiniteMap · ${provider.displayName}`,
			cancellable: false,
		}, async (progress) => {
			await installer.install((stage) => {
				if (stage === 'downloading') {
					onProgress('opening');
					progress.report({ increment: 33, message: `Downloading ${provider.displayName} runtime` });
				} else {
					onProgress('waiting');
					progress.report({ increment: 33, message: `Installing ${provider.displayName} runtime` });
				}
			});
			onProgress('verifying');
			progress.report({ increment: 34, message: `Verifying ${provider.displayName} runtime` });
			if (id === 'codex') {
				this.codexRuntime?.invalidate();
			} else if (id === 'copilot') {
				this.copilotRuntime?.invalidate();
			}
			const result = await this.verifyInstallation(id, false);
			this.changeEmitter.fire(); // Main-P1-02：安装完成后通知 UI 刷新 provider 状态
			return result;
		});
	}

	public dispose(): void {
		this.components.clear();
		this.codexRuntime?.dispose();
		this.codexRuntime = undefined;
		this.copilotRuntime?.dispose();
		this.copilotRuntime = undefined;
		this.secretStorageChangeSubscription?.dispose(); // Copilot-P1-01：释放 SecretStorage 订阅
		this.secretStorageChangeSubscription = undefined;
		this.changeEmitter.dispose();
	}

	private async verifyInstallation(id: ProviderId, alreadyInstalled: boolean): Promise<ProviderInstallationResult> {
		const component = await this.load(id);
		const descriptor = await component.getDescriptor();
		if (descriptor.installState === 'failed' || descriptor.installState === 'incompatible') {
			throw this.withCode('PROVIDER_INSTALL_FAILED', `${this.provider(id).displayName} runtime failed its startup check.`);
		}
		return {
			providerId: id,
			displayName: this.provider(id).displayName,
			alreadyInstalled,
			descriptor,
		};
	}

	private createCodexComponent(): ProviderComponentApiV1 {
		const installer = this.requireInstaller('codex');
		const runtimeFactory = this.options.runtimeFactory || ((executable: string, storagePath: string) =>
			new CodexRuntimeManager({
				explicitExecutable: executable,
				experimentalApi: this.options.experimentalCodexApi,
				storagePath: path.join(storagePath, 'codex-state'),
			})
		);
		this.codexRuntime = runtimeFactory(installer.executablePath, this.options.storagePath);
		return {
			apiVersion: '1',
			getDescriptor: async () => {
				const adapter = new CodexAgentSessionAdapter(this.codexRuntime as CodexRuntimeManager);
				try {
					return await adapter.getDescriptor();
				} finally {
					adapter.dispose();
				}
			},
			createAdapter: async () => new CodexAgentSessionAdapter(this.codexRuntime as CodexRuntimeManager),
		};
	}

	private createClaudeComponent(): ProviderComponentApiV1 {
		const installer = this.requireInstaller('claudecode');
		const createAdapter = () => new ClaudeAgentSessionAdapter({
			executable: installer.executablePath,
			secretStorage: this.options.secretStorage,
		});
		return {
			apiVersion: '1',
			getDescriptor: async () => {
				const adapter = createAdapter();
				try {
					return await adapter.getDescriptor();
				} finally {
					adapter.dispose();
				}
			},
			createAdapter: async () => createAdapter(),
			authenticate: async () => {
				const apiKey = await vscode.window.showInputBox({
					title: 'InfiniteMap · Claude Agent',
					prompt: 'Enter an Anthropic API key. It is stored in VS Code SecretStorage.',
					password: true,
					ignoreFocusOut: true,
				});
				if (!apiKey?.trim() || !this.options.secretStorage) {
					throw this.withCode('AUTH_REQUIRED', 'Claude Agent authentication was not completed.');
				}
				await this.options.secretStorage.store(CLAUDE_API_KEY_SECRET, apiKey.trim());
				this.changeEmitter.fire(); // Main-P1-02：认证完成后通知 UI 刷新 provider 状态
			},
		};
	}

	private createCopilotComponent(): ProviderComponentApiV1 {
		const installer = this.requireInstaller('copilot');
		const runtimeFactory = this.options.copilotRuntimeFactory || ((executable: string, storagePath: string) =>
			new CopilotRuntimeManager({
				executable,
				storagePath: path.join(storagePath, 'copilot-state'),
				tokenProvider: async () => (await this.options.secretStorage?.get(COPILOT_GITHUB_TOKEN_SECRET))
					|| process.env.COPILOT_GITHUB_TOKEN
					|| process.env.GH_TOKEN
					|| process.env.GITHUB_TOKEN,
			})
		);
		this.copilotRuntime = runtimeFactory(installer.executablePath, this.options.storagePath);
		// Copilot-P1-01：SecretStorage 中 Copilot token 变更时（例如外部工具刷新），通知 SDK 重建 client
		this.secretStorageChangeSubscription?.dispose();
		if (this.options.secretStorage) {
			this.secretStorageChangeSubscription = this.options.secretStorage.onDidChange((e) => {
				if (e.key === COPILOT_GITHUB_TOKEN_SECRET) {
					this.copilotRuntime?.invalidate();
				}
			});
		}
		return {
			apiVersion: '1',
			getDescriptor: async () => {
				const adapter = new CopilotAgentSessionAdapter(this.copilotRuntime as CopilotRuntimeManager);
				try {
					return await adapter.getDescriptor();
				} finally {
					adapter.dispose();
				}
			},
			createAdapter: async () => new CopilotAgentSessionAdapter(this.copilotRuntime as CopilotRuntimeManager),
			authenticate: async () => {
				const token = await vscode.window.showInputBox({
					title: 'InfiniteMap · Copilot',
					prompt: 'Enter a GitHub token for Copilot. It is stored in VS Code SecretStorage.',
					password: true,
					ignoreFocusOut: true,
				});
				if (!token?.trim() || !this.options.secretStorage) {
					throw this.withCode('AUTH_REQUIRED', 'Copilot authentication was not completed.');
				}
				await this.options.secretStorage.store(COPILOT_GITHUB_TOKEN_SECRET, token.trim());
				this.copilotRuntime?.invalidate();
				this.changeEmitter.fire(); // Main-P1-02：认证完成后通知 UI 刷新 provider 状态
			},
		};
	}

	private missingDescriptor(id: ProviderId): ProviderDescriptor {
		return {
			id,
			displayName: this.provider(id).displayName,
			componentExtensionId: COMPONENT_ID,
			installState: 'missing',
			models: [],
			permissionModes: [],
			capabilities: unavailableCapabilities(),
		};
	}

	private provider(id: ProviderId): typeof PROVIDERS[number] {
		return PROVIDERS.find((candidate) => candidate.id === id) as typeof PROVIDERS[number];
	}

	private assertProvider(providerId: string): ProviderId {
		const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
		if (!provider) {
			throw this.withCode('PROVIDER_COMPONENT_MISSING', `Provider is not built into InfiniteMap: ${providerId}`);
		}
		return provider.id;
	}

	private requireInstaller(id: ProviderId): Installer {
		const installer = this.installers.get(id);
		if (!installer) {
			throw this.withCode('PROVIDER_COMPONENT_MISSING', `Provider installer is unavailable: ${id}`);
		}
		return installer;
	}

	private requireComponentFactory(id: ProviderId): () => ProviderComponentApiV1 {
		const factory = this.componentFactories.get(id);
		if (!factory) {
			throw this.withCode('PROVIDER_COMPONENT_MISSING', `Provider adapter is unavailable: ${id}`);
		}
		return factory;
	}

	private withCode(code: string, message: string): Error {
		const error = new Error(message) as Error & { code?: string };
		error.code = code;
		return error;
	}
}
