import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ClaudeUserConfig {
	model?: string;
	effortLevel?: string;
	baseUrl?: string;
	authToken?: string;
}

/**
 * 读取用户的 Claude CLI 配置文件，与 Claude Code 插件共享配置
 * 支持读取 ~/.claude/config.json 和 ~/.claude/settings.json
 */
export class ClaudeConfigReader {
	private static CONFIG_PATHS = [
		path.join(os.homedir(), '.claude', 'config.json'),
		path.join(os.homedir(), '.claude', 'settings.json'),
	];

	/**
	 * 读取并合并用户配置
	 * 优先级: config.json > settings.json
	 */
	public static readConfig(): ClaudeUserConfig {
		const merged: ClaudeUserConfig = {};

		// 倒序读取，优先级高的后读取可覆盖
		for (const configPath of [...this.CONFIG_PATHS].reverse()) {
			try {
				if (fs.existsSync(configPath)) {
					const content = fs.readFileSync(configPath, 'utf-8');
					const config = JSON.parse(content);

					// config.json 格式
					if (config.model) {
						merged.model = config.model;
					}
					if (config.effortLevel || config.effort) {
						merged.effortLevel = config.effortLevel || config.effort;
					}
					if (config.env?.ANTHROPIC_BASE_URL) {
						merged.baseUrl = config.env.ANTHROPIC_BASE_URL;
					}
					if (config.env?.ANTHROPIC_AUTH_TOKEN) {
						merged.authToken = config.env.ANTHROPIC_AUTH_TOKEN;
					}

					// settings.json 格式 (primaryApiKey 字段)
					if (config.primaryApiKey && !merged.authToken) {
						merged.authToken = config.primaryApiKey;
					}
				}
			} catch (error) {
				console.warn(`[ClaudeConfigReader] Failed to read config from ${configPath}:`, error);
			}
		}

		return merged;
	}

	/**
	 * 归一化模型 ID，支持简写形式
	 * 映射规则:
	 * - "opus[1m]" -> "claude-opus-5[1m]"
	 * - "opus" -> "claude-opus-4-6"
	 * - "sonnet[1m]" -> "claude-sonnet-5[1m]"
	 * - "sonnet" -> "claude-sonnet-4-6"
	 * - "haiku" -> "claude-haiku-4-5"
	 * - 其他直接返回（支持完整 ID 如 "claude-opus-4-7"）
	 */
	public static normalizeModelId(userModel?: string): string | undefined {
		if (!userModel) {
			return undefined;
		}

		const mapping: Record<string, string> = {
			'opus[1m]': 'claude-opus-5[1m]',
			'opus': 'claude-opus-4-6',
			'sonnet[1m]': 'claude-sonnet-5[1m]',
			'sonnet': 'claude-sonnet-4-6',
			'haiku': 'claude-haiku-4-5',
			'fable': 'claude-fable-5',
		};

		return mapping[userModel.toLowerCase()] || userModel;
	}

	/**
	 * 格式化模型显示名称
	 */
	public static formatModelLabel(modelId: string, isUserConfig: boolean): string {
		if (isUserConfig) {
			return `${modelId} (用户配置)`;
		}
		return modelId;
	}
}
