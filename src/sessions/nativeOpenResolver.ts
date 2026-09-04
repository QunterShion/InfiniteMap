import { createHash } from 'crypto';
import * as vscode from 'vscode';
import {
	AgentSessionErrorCode,
	AgentSessionRef,
	NativeOpenCapability,
	NativeOpenDescriptor,
	OpenTarget,
	SessionOpenResult,
} from './types';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CODEX_EXTENSION_IDS = ['openai.chatgpt', 'openai.chat'] as const;
const CODEX_VIEW_TYPE = 'chatgpt.conversationEditor';
const CODEX_MIN_VERSION = '26.5825.51511';
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CLAUDE_COMMAND = 'claude-vscode.primaryEditor.open';
const CLAUDE_MIN_VERSION = '2.1.239';

interface CachedCapability {
	expiresAt: number;
	value: NativeOpenCapability;
}

export interface NativeOpenProbeInput {
	provider: string;
	session: AgentSessionRef;
	requestedTarget: OpenTarget;
}

export interface NativeOpenResolverOptions {
	cacheTtlMs?: number;
	now?: () => number;
	log?: (entry: Record<string, unknown>) => void;
	versionAllowlists?: Partial<Record<'codex' | 'claudecode', readonly string[]>>;
}

/**
 * Resolves private/experimental Provider UI contracts without reading any
 * Provider storage. Probing is side-effect free; only open() launches UI.
 */
export class NativeOpenResolver implements vscode.Disposable {
	private readonly cache = new Map<string, CachedCapability>();
	private readonly changeSubscription: vscode.Disposable | undefined;

	constructor(private readonly options: NativeOpenResolverOptions = {}) {
		const onDidChange = (vscode.extensions as typeof vscode.extensions & {
			onDidChange?: vscode.Event<void>;
		}).onDidChange;
		this.changeSubscription = onDidChange?.(() => this.invalidate());
	}

	public async probe(input: NativeOpenProbeInput): Promise<NativeOpenCapability> {
		this.canonicalSessionId(input.session);
		if (input.requestedTarget !== 'provider-ide') {
			return this.unsupported('Native capability probing only applies to the Provider IDE target.');
		}
		if (!this.configuration().get<boolean>('nativeOpenEnabled', true)) {
			return this.unsupported('Native Provider opening is disabled by configuration.');
		}
		const now = this.now();
		const cached = this.cache.get(input.provider);
		if (cached && cached.expiresAt > now) {
			return { ...cached.value };
		}
		const value = await this.probeProvider(input.provider);
		const expiresAt = now + (this.options.cacheTtlMs ?? CACHE_TTL_MS);
		value.expiresAt = new Date(expiresAt).toISOString();
		this.cache.set(input.provider, { expiresAt, value: { ...value } });
		return value;
	}

	public async open(input: {
		executionId: string;
		session: AgentSessionRef;
	}): Promise<SessionOpenResult> {
		const sessionId = this.canonicalSessionId(input.session);
		const capability = await this.probe({
			provider: input.session.provider,
			session: input.session,
			requestedTarget: 'provider-ide',
		});
		if (!capability.available || !capability.contract) {
			throw this.withCode(
				capability.errorCode || 'NATIVE_OPEN_UNSUPPORTED',
				capability.reason || `Provider native opening is unavailable: ${input.session.provider}`,
				false
			);
		}

		const descriptor = this.descriptor(capability, sessionId);
		this.log(input, capability, 'attempted');
		try {
			if (capability.contract === 'codex-vscode-private-uri-v1') {
				const uri = vscode.Uri.from({
					scheme: 'openai-codex',
					authority: 'route',
					path: `/local/${encodeURIComponent(sessionId)}`,
				});
				await vscode.commands.executeCommand('vscode.openWith', uri, CODEX_VIEW_TYPE);
			} else if (capability.contract === 'claude-vscode-command-v1') {
				await vscode.commands.executeCommand(CLAUDE_COMMAND, sessionId);
			} else {
				throw this.withCode('NATIVE_OPEN_UNSUPPORTED', 'The detected Provider contract is not executable.', false);
			}
		} catch (error) {
			this.invalidate(input.session.provider);
			this.log(input, capability, 'failed', error);
			const detail = error as Error & { code?: AgentSessionErrorCode; retryable?: boolean };
			if (detail.code && detail.code !== 'NATIVE_OPEN_FAILED') {
				throw detail;
			}
			throw this.withCode(
				'NATIVE_OPEN_FAILED',
				`The ${input.session.provider} VS Code client rejected the session open request: ${detail.message || String(error)}`,
				true
			);
		}

		input.session.nativeOpen = descriptor;
		this.log(input, capability, 'accepted');
		return {
			opened: true,
			executionId: input.executionId,
			provider: input.session.provider,
			sessionId,
			target: 'provider-ide',
			method: capability.contract === 'claude-vscode-command-v1' ? 'provider-command' : 'provider-uri',
			capability: capability.level,
			extensionId: capability.extensionId,
			extensionVersion: capability.extensionVersion,
			fallbackAvailable: true,
			warning: 'The Provider accepted the open request; session ownership was not transferred.',
		};
	}

	public invalidate(provider?: string): void {
		if (provider) {
			this.cache.delete(provider);
		} else {
			this.cache.clear();
		}
	}

	public dispose(): void {
		this.changeSubscription?.dispose();
		this.cache.clear();
	}

	private async probeProvider(provider: string): Promise<NativeOpenCapability> {
		if (provider === 'codex') {
			return this.probeCodex();
		}
		if (provider === 'claudecode') {
			return this.probeClaude();
		}
		if (provider === 'copilot') {
			return this.unsupported(
				'Copilot SDK sessions are not proven to be discoverable by the VS Code Copilot UI.'
			);
		}
		return this.unsupported(`Provider does not define a native open contract: ${provider}`);
	}

	private probeCodex(): NativeOpenCapability {
		const extension = this.findExtension(CODEX_EXTENSION_IDS);
		if (!extension) {
			return this.unavailable('NATIVE_CLIENT_MISSING', 'The Codex VS Code extension is not installed.');
		}
		const version = String(extension.packageJSON?.version || '');
		if (!this.versionAllowed('codex', version, ['26.'])) {
			return this.unavailable(
				'NATIVE_CLIENT_INCOMPATIBLE',
				`Codex extension ${version || '(unknown)'} is outside the private-contract allowlist.`,
				extension.id,
				version
			);
		}
		const editors = extension.packageJSON?.contributes?.customEditors;
		const editor = Array.isArray(editors)
			? editors.find((candidate: any) => candidate?.viewType === CODEX_VIEW_TYPE)
			: undefined;
		const selectors = editor?.selector;
		const declaresScheme = Array.isArray(selectors)
			&& selectors.some((candidate: any) => String(candidate?.filenamePattern || '').startsWith('openai-codex:'));
		if (!editor || !declaresScheme) {
			return this.unavailable(
				'NATIVE_CLIENT_INCOMPATIBLE',
				'The Codex extension no longer declares the verified conversation editor contract.',
				extension.id,
				version
			);
		}
		return {
			available: true,
			level: 'experimental',
			extensionId: extension.id,
			extensionVersion: version,
			contract: 'codex-vscode-private-uri-v1',
			viewType: CODEX_VIEW_TYPE,
			minExtensionVersion: CODEX_MIN_VERSION,
		};
	}

	private async probeClaude(): Promise<NativeOpenCapability> {
		const extension = this.findExtension([CLAUDE_EXTENSION_ID]);
		if (!extension) {
			return this.unavailable('NATIVE_CLIENT_MISSING', 'The Claude Code VS Code extension is not installed.');
		}
		const version = String(extension.packageJSON?.version || '');
		if (!this.versionAllowed('claudecode', version, ['2.1.'])) {
			return this.unavailable(
				'NATIVE_CLIENT_INCOMPATIBLE',
				`Claude Code extension ${version || '(unknown)'} is outside the experimental-contract allowlist.`,
				extension.id,
				version
			);
		}
		const getCommands = (vscode.commands as typeof vscode.commands & {
			getCommands?: (filterInternal?: boolean) => Thenable<string[]>;
		}).getCommands;
		const commands = getCommands
			? await getCommands(true)
			: (extension.packageJSON?.contributes?.commands || []).map((entry: any) => entry?.command);
		if (!commands.includes(CLAUDE_COMMAND)) {
			return this.unavailable(
				'NATIVE_CLIENT_INCOMPATIBLE',
				'The Claude Code extension does not expose the verified primary editor command.',
				extension.id,
				version
			);
		}
		return {
			available: true,
			level: 'experimental',
			extensionId: extension.id,
			extensionVersion: version,
			contract: 'claude-vscode-command-v1',
			command: CLAUDE_COMMAND,
			minExtensionVersion: CLAUDE_MIN_VERSION,
		};
	}

	private descriptor(capability: NativeOpenCapability, sessionId: string): NativeOpenDescriptor {
		const verifiedAt = new Date(this.now()).toISOString();
		return {
			target: 'provider-ide',
			contract: capability.contract as NativeOpenDescriptor['contract'],
			...(capability.contract === 'codex-vscode-private-uri-v1'
				? { uri: `openai-codex://route/local/${encodeURIComponent(sessionId)}` }
				: {}),
			...(capability.command ? { command: capability.command } : {}),
			...(capability.viewType ? { viewType: capability.viewType } : {}),
			...(capability.minExtensionVersion ? { minExtensionVersion: capability.minExtensionVersion } : {}),
			...(capability.extensionVersion ? { detectedExtensionVersion: capability.extensionVersion } : {}),
			verifiedAt,
		};
	}

	private canonicalSessionId(session: AgentSessionRef): string {
		const value = String(session.threadId || session.sessionId || '').trim();
		if (!value) {
			throw this.withCode('SESSION_ID_MISSING', 'The recorded Provider session does not have a canonical session ID.', false);
		}
		if (value.length > 512 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
			throw this.withCode('SESSION_ID_MISSING', 'The recorded Provider session ID is not safe to open.', false);
		}
		return value;
	}

	private configuration(): { get<T>(key: string, defaultValue: T): T } {
		return vscode.workspace.getConfiguration('infiniteMap.agentSession');
	}

	private versionAllowed(
		provider: 'codex' | 'claudecode',
		version: string,
		defaults: readonly string[]
	): boolean {
		const configured = this.options.versionAllowlists?.[provider]
			|| this.configuration().get<string[]>(
				provider === 'codex' ? 'codexVersionAllowlist' : 'claudeVersionAllowlist',
				[...defaults]
			);
		return Boolean(version) && configured.some((prefix) => Boolean(prefix) && version.startsWith(prefix));
	}

	private findExtension(ids: readonly string[]): vscode.Extension<unknown> | undefined {
		for (const id of ids) {
			const candidate = vscode.extensions.getExtension?.(id)
				|| vscode.extensions.all.find((extension) => extension.id.toLowerCase() === id.toLowerCase());
			if (candidate) {
				return candidate;
			}
		}
		return undefined;
	}

	private unavailable(
		errorCode: AgentSessionErrorCode,
		reason: string,
		extensionId?: string,
		extensionVersion?: string
	): NativeOpenCapability {
		return { available: false, level: 'unsupported', errorCode, reason, extensionId, extensionVersion };
	}

	private unsupported(reason: string): NativeOpenCapability {
		return this.unavailable('NATIVE_OPEN_UNSUPPORTED', reason);
	}

	private withCode(code: AgentSessionErrorCode, message: string, retryable: boolean): Error {
		const error = new Error(message) as Error & { code: AgentSessionErrorCode; retryable: boolean };
		error.code = code;
		error.retryable = retryable;
		return error;
	}

	private now(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	private log(
		input: { executionId: string; session: AgentSessionRef },
		capability: NativeOpenCapability,
		phase: 'attempted' | 'accepted' | 'failed',
		error?: unknown
	): void {
		const entry = {
			event: 'agent-session-native-open',
			phase,
			provider: input.session.provider,
			executionId: input.executionId,
			sessionIdHash: createHash('sha256').update(this.canonicalSessionId(input.session)).digest('hex').slice(0, 16),
			extensionId: capability.extensionId,
			extensionVersion: capability.extensionVersion,
			contract: capability.contract,
			...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
		};
		if (this.options.log) {
			this.options.log(entry);
		} else {
			console.info(`[InfiniteMap] ${JSON.stringify(entry)}`);
		}
	}
}
