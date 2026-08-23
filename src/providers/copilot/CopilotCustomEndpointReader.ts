import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CopilotCustomEndpointModel {
	/** Stable id exposed to the InfiniteMap model selector. */
	selectionId: string;
	/** Name of the VS Code custom endpoint contribution. */
	endpointName: string;
	/** Model id sent on the wire to the endpoint. */
	modelId: string;
	label: string;
	baseUrl: string;
	wireApi: 'completions' | 'responses';
	apiKey?: string;
	apiKeyReference?: string;
	toolCalling?: boolean;
	vision?: boolean;
	maxInputTokens?: number;
	maxOutputTokens?: number;
}

interface RawModel {
	id?: unknown;
	name?: unknown;
	url?: unknown;
	toolCalling?: unknown;
	vision?: unknown;
	maxInputTokens?: unknown;
	maxOutputTokens?: unknown;
}

interface RawEndpoint {
	name?: unknown;
	vendor?: unknown;
	apiType?: unknown;
	apiKey?: unknown;
	models?: unknown;
}

/**
 * Reads the public VS Code user configuration used by the customendpoint
 * language-model contribution. Secrets are intentionally not read from VS
 * Code's private extension storage; literal keys are accepted and secret
 * references are retained as references for a caller supplied resolver.
 */
export class CopilotCustomEndpointReader {
	public static read(filePath = CopilotCustomEndpointReader.defaultPath()): CopilotCustomEndpointModel[] {
		try {
			const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			if (!Array.isArray(value)) {
				return [];
			}
			return value.flatMap((endpoint) => CopilotCustomEndpointReader.mapEndpoint(endpoint as RawEndpoint));
		} catch {
			return [];
		}
	}

	public static defaultPath(platform = process.platform, homeDirectory = os.homedir()): string {
		if (platform === 'win32') {
			return path.join(process.env.APPDATA || path.join(homeDirectory, 'AppData', 'Roaming'), 'Code', 'User', 'chatLanguageModels.json');
		}
		if (platform === 'darwin') {
			return path.join(homeDirectory, 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json');
		}
		return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDirectory, '.config'), 'Code', 'User', 'chatLanguageModels.json');
	}

	private static mapEndpoint(endpoint: RawEndpoint): CopilotCustomEndpointModel[] {
		if (endpoint.vendor !== 'customendpoint' || !Array.isArray(endpoint.models)) {
			return [];
		}
		const endpointName = typeof endpoint.name === 'string' && endpoint.name.trim()
			? endpoint.name.trim()
			: 'customendpoint';
		const apiType = endpoint.apiType === 'responses' ? 'responses' : 'chat-completions';
		const apiKey = typeof endpoint.apiKey === 'string' ? endpoint.apiKey : undefined;
		const apiKeyReference = apiKey && /^\$\{[^}]+\}$/.test(apiKey) ? apiKey : undefined;
		const literalApiKey = apiKeyReference ? undefined : apiKey;
		return endpoint.models.flatMap((raw) => {
			const model = raw as RawModel;
			if (typeof model.id !== 'string' || typeof model.url !== 'string' || !model.id.trim() || !model.url.trim()) {
				return [];
			}
			const modelId = model.id.trim();
			return [{
				selectionId: `customendpoint/${endpointName}/${modelId}`,
				endpointName,
				modelId,
				label: typeof model.name === 'string' && model.name.trim() ? `${endpointName} · ${model.name.trim()}` : `${endpointName} · ${modelId}`,
				baseUrl: CopilotCustomEndpointReader.normalizeBaseUrl(model.url.trim()),
				wireApi: apiType === 'responses' ? 'responses' : 'completions',
				...(literalApiKey ? { apiKey: literalApiKey } : {}),
				...(apiKeyReference ? { apiKeyReference } : {}),
				...(typeof model.toolCalling === 'boolean' ? { toolCalling: model.toolCalling } : {}),
				...(typeof model.vision === 'boolean' ? { vision: model.vision } : {}),
				...(typeof model.maxInputTokens === 'number' ? { maxInputTokens: model.maxInputTokens } : {}),
				...(typeof model.maxOutputTokens === 'number' ? { maxOutputTokens: model.maxOutputTokens } : {}),
			}];
		});
	}

	private static normalizeBaseUrl(rawUrl: string): string {
		try {
			const url = new URL(rawUrl);
			url.search = '';
			url.hash = '';
			const suffixes = ['/chat/completions', '/responses', '/completions'];
			for (const suffix of suffixes) {
				if (url.pathname.endsWith(suffix)) {
					url.pathname = url.pathname.slice(0, -suffix.length) || '/';
					return url.toString().replace(/\/$/, '');
				}
			}
			if (!url.pathname || url.pathname === '/') {
				url.pathname = '/v1';
			}
			return url.toString().replace(/\/$/, '');
		} catch {
			return rawUrl.replace(/\/(chat\/completions|responses|completions)\/?$/, '');
		}
	}
}
