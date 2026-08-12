import { ManagedNpmRuntimeAsset } from './managedNpmRuntimeInstaller';

export const CLAUDE_RUNTIME_VERSION = '0.3.227';
export const COPILOT_RUNTIME_VERSION = '1.0.78';

export const CLAUDE_RUNTIME_ASSETS: Record<string, ManagedNpmRuntimeAsset> = {
	'darwin-arm64': {
		packageName: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
		integrity: 'sha512-9iL2Q5QSLAVRgAZnXeSag6g2k9e7ZOHktYxL5LzTg05lbcYCeop4eVs7R8+qsJRIHtbGthA919hrnzkq1Ij9GQ==',
		executable: 'claude',
	},
	'darwin-x64': {
		packageName: '@anthropic-ai/claude-agent-sdk-darwin-x64',
		integrity: 'sha512-GDdYKtv3wC0kLGS5wrxUf5Oq2hkKW0Nw/CyqcxHEnmeuc8istbQM6dveTK66ufPyI5Q7FiHxmo/kL7YLlFdvtw==',
		executable: 'claude',
	},
	'linux-arm64': {
		packageName: '@anthropic-ai/claude-agent-sdk-linux-arm64',
		integrity: 'sha512-/Ve9ZVcULeYP6kxaEBFEwCDPAJRl/9O38PgXcOSCYIott6H3IA+4nb51Ee0ljITeA52IPyEo7stbduIjiPsp+g==',
		executable: 'claude',
	},
	'linux-x64': {
		packageName: '@anthropic-ai/claude-agent-sdk-linux-x64',
		integrity: 'sha512-eBSNIOauM5+crbIH/f8G1vgGMIMHVwh+NDH6esCRKdbRVvcnE4+urdVFSaKz0G7Ji8c6WGKLQYqrdrAVdPyODw==',
		executable: 'claude',
	},
	'win32-arm64': {
		packageName: '@anthropic-ai/claude-agent-sdk-win32-arm64',
		integrity: 'sha512-4vkR0Hn1TI6ypomZcpMTk7h8Wtk1iY59XDtpyk5bk7eMNxuNtlm8a4DX7OS00sn4/I3cUoDOhRpTVA4p7j5oxA==',
		executable: 'claude.exe',
	},
	'win32-x64': {
		packageName: '@anthropic-ai/claude-agent-sdk-win32-x64',
		integrity: 'sha512-iCEk00U8o8Y+0fsSCFbFGWGRokrfxo9kCwzBuKPjzvQEux06g7ps/O+Y0q9Nw/4iPCTXgUbekiSNcqg9CWaN9A==',
		executable: 'claude.exe',
	},
};

export const COPILOT_RUNTIME_ASSETS: Record<string, ManagedNpmRuntimeAsset> = {
	'darwin-arm64': {
		packageName: '@github/copilot-darwin-arm64',
		integrity: 'sha512-P11+VyWg8ad0WlywGtO2d7AxqTLJv4hkUicFg6Ycth5lfk00aCu/74YOOZSPO6C2bBBJhAza7oAdmauM6KEojw==',
		executable: 'copilot',
	},
	'darwin-x64': {
		packageName: '@github/copilot-darwin-x64',
		integrity: 'sha512-stimP3WDFs2GU8nJzTJbtRpZViV4bsf80yg7QrFq+G4RISQ3Nihg/3/H0U6UQF1+txMJ/Ohmb5RFYxSw1Hj2sw==',
		executable: 'copilot',
	},
	'linux-arm64': {
		packageName: '@github/copilot-linux-arm64',
		integrity: 'sha512-K31PRKGTm252V1Lof7ypjg283R2QSm3BgoCvZfX2taos4wqC3SaTozSQKwW3dgrAx7A3G3SGEoilVCNqfigdZA==',
		executable: 'copilot',
	},
	'linux-x64': {
		packageName: '@github/copilot-linux-x64',
		integrity: 'sha512-QK3oMtAn9dIv+1u1kx0xNpZNtZxdI+uZVIyLl7myp+Oh2Uj8BLagVv6a7uP0cDphO3TgfIdlvpepCe5MIcx0fw==',
		executable: 'copilot',
	},
	'win32-arm64': {
		packageName: '@github/copilot-win32-arm64',
		integrity: 'sha512-ktDkFXaaecEKD3hpM6ydM9lKOdoCfsQsXCmzLzE7DCmSpbbMCdfPfWfZ7MOclmKmpZ5/MNfr4U2l8CUqGerzYA==',
		executable: 'copilot.exe',
	},
	'win32-x64': {
		packageName: '@github/copilot-win32-x64',
		integrity: 'sha512-Gd8l2T4eqYEWlOEPd0SZznQ+YYgYrwOkE0QXodMkhCBbPdgu/uTzb7mnISWwnVAgqs7pONdF1GOpHkTo+ay8CQ==',
		executable: 'copilot.exe',
	},
};
