import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { KmMcpClient } from '../mcpClient/kmMcpClient';
import { sessionDeepLinkStore } from './sessionDeepLinkStore';

export class SessionUriHandler implements vscode.UriHandler {
	constructor(private readonly extensionPath: string) {}

	public async handleUri(uri: vscode.Uri): Promise<void> {
		if (uri.authority !== 'chanterxiao.infinite-map' || uri.path !== '/session/open') {
			throw new Error('Unsupported InfiniteMap session URI.');
		}
		const params = new URLSearchParams(uri.query);
		if (params.get('v') !== '1') {
			throw new Error('Unsupported InfiniteMap session URI version.');
		}
		const executionId = this.required(params.get('executionId'), 'executionId');
		const nodeId = this.required(params.get('nodeId'), 'nodeId');
		const mapHint = this.required(params.get('map'), 'map');
		for (const key of [...params.keys()]) {
			if (!['v', 'executionId', 'map', 'nodeId'].includes(key)) {
				throw new Error(`InfiniteMap session URI contains an unsupported parameter: ${key}`);
			}
		}
		if (path.isAbsolute(mapHint) || mapHint.split(/[\\/]/).includes('..')) {
			throw new Error('InfiniteMap session URI contains an unsafe map path.');
		}

		const mapUri = this.resolveWorkspaceMap(mapHint);
		await this.validateExecution(mapUri, nodeId, executionId);
		sessionDeepLinkStore.set({ documentUri: mapUri.toString(), nodeId, executionId });
		await vscode.commands.executeCommand('vscode.openWith', mapUri, 'infinite-map.editor');
		void vscode.window.showInformationMessage(
			`Opened InfiniteMap session history context for node ${nodeId} (${executionId}).`
		);
	}

	private async validateExecution(mapUri: vscode.Uri, nodeId: string, executionId: string): Promise<void> {
		const workspace = vscode.workspace.getWorkspaceFolder(mapUri);
		if (!workspace) {
			throw new Error('The InfiniteMap session is outside the current workspace.');
		}
		const client = KmMcpClient.forWorkspace(workspace.uri.toString(), { extensionPath: this.extensionPath });
		let cursor: string | undefined;
		do {
				const response = await client.callTool({
					name: 'km_list_node_sessions',
					arguments: { filePath: mapUri.fsPath, nodeId, cursor, limit: 100 },
				});
				const page = this.parseToolResult(response) as {
					sessions?: Array<{ executionId?: string }>;
					nextCursor?: string | null;
				};
				if ((page.sessions || []).some((record) => record.executionId === executionId)) {
					return;
				}
				cursor = page.nextCursor || undefined;
		} while (cursor);
		throw new Error('The InfiniteMap session reference is unavailable or does not match this node.');
	}

	private parseToolResult(raw: unknown): unknown {
		const result = raw as { content?: Array<{ type?: string; text?: string }> };
		const text = result.content?.find((item) => item.type === 'text')?.text;
		if (!text) {
			throw new Error('InfiniteMap MCP returned an invalid session-history response.');
		}
		return JSON.parse(text);
	}

	private resolveWorkspaceMap(mapHint: string): vscode.Uri {
		for (const folder of vscode.workspace.workspaceFolders || []) {
			if (folder.uri.scheme !== 'file') {
				continue;
			}
			const candidate = path.resolve(folder.uri.fsPath, mapHint);
			const relative = path.relative(folder.uri.fsPath, candidate);
			if (!relative.startsWith('..') && !path.isAbsolute(relative)
				&& path.extname(candidate).toLowerCase() === '.km' && fs.existsSync(candidate)) {
				return vscode.Uri.file(candidate);
			}
		}
		throw new Error('The InfiniteMap file referenced by this session is unavailable in the current workspace.');
	}

	private required(value: string | null, name: string): string {
		const normalized = (value || '').trim();
		if (!normalized) {
			throw new Error(`InfiniteMap session URI is missing ${name}.`);
		}
		return normalized;
	}
}
