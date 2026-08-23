import { CopilotClient, ModelInfo, RuntimeConnection } from '@github/copilot-sdk';
import { CopilotCustomEndpointModel, CopilotCustomEndpointReader } from './CopilotCustomEndpointReader';

export interface CopilotRuntimeProbe {
	client: CopilotClient;
	authenticated: boolean;
	models: ModelInfo[];
	customEndpointModels: CopilotCustomEndpointModel[];
}

export interface CopilotRuntimeManagerOptions {
	executable: string;
	storagePath: string;
	tokenProvider?: () => Promise<string | undefined>;
	customEndpointReader?: () => CopilotCustomEndpointModel[];
	customEndpointSecretProvider?: (reference: string) => Promise<string | undefined>;
	clientFactory?: (options: ConstructorParameters<typeof CopilotClient>[0]) => CopilotClient;
}

export class CopilotRuntimeManager {
	private probe: Promise<CopilotRuntimeProbe> | undefined;
	private client: CopilotClient | undefined;

	constructor(private readonly options: CopilotRuntimeManagerOptions) {}

	public ensureProbe(): Promise<CopilotRuntimeProbe> {
		if (!this.probe) {
			this.probe = this.start();
		}
		return this.probe;
	}

	public invalidate(): void {
		const client = this.client;
		this.client = undefined;
		this.probe = undefined;
		if (client) {
			void client.stop().catch(() => undefined);
		}
	}

	public dispose(): void {
		this.invalidate();
	}

	private async start(): Promise<CopilotRuntimeProbe> {
		const token = await this.options.tokenProvider?.();
		const configuredCustomModels = (this.options.customEndpointReader || CopilotCustomEndpointReader.read)();
		const customEndpointModels = await Promise.all(configuredCustomModels.map(async (model) => {
			if (model.apiKey || !model.apiKeyReference || !this.options.customEndpointSecretProvider) {
				return model;
			}
			const reference = model.apiKeyReference
				.replace(/^\$\{/, '')
				.replace(/\}$/, '')
				.replace(/^input:/, '');
			const apiKey = await this.options.customEndpointSecretProvider(reference).catch(() => undefined);
			return apiKey ? { ...model, apiKey } : model;
		}));
		const connection = RuntimeConnection.forStdio({ path: this.options.executable });
		const clientOptions: ConstructorParameters<typeof CopilotClient>[0] = {
			connection,
			baseDirectory: this.options.storagePath,
			logLevel: 'error',
			...(token ? { gitHubToken: token, useLoggedInUser: false } : { useLoggedInUser: true }),
		};
		const client = this.options.clientFactory
			? this.options.clientFactory(clientOptions)
			: new CopilotClient(clientOptions);
		this.client = client;
		try {
			await client.start();
			const auth = await client.getAuthStatus();
			const models = auth.isAuthenticated ? await client.listModels() : [];
			return { client, authenticated: auth.isAuthenticated, models, customEndpointModels };
		} catch (error) {
			this.client = undefined;
			this.probe = undefined;
			await client.stop().catch(() => undefined);
			throw error;
		}
	}
}
