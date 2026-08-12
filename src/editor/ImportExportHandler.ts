import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logLifecycle } from '../lifecycle';
import { changeSvgImg, getRootUri, selectFile } from '../util';

const fontPath = path.join(__dirname, '../webui/resvg-js/fonts/Alibaba_PuHuiTi_2.0_45_Light_45_Light.ttf');

interface XmindParser {
	xmindToJSON(filePath: string): Promise<any>;
	JSONToXmind(content: any, filePath: string): Promise<void>;
}

interface ResvgRuntime {
	Resvg: new (svg: string, options?: Record<string, unknown>) => { render(): { asPng(): Uint8Array } };
	initWasm(input: Uint8Array): Promise<void>;
}

export class ImportExportHandler {
	private parser: XmindParser | undefined;
	private resvgRuntime: ResvgRuntime | undefined;
	private resvgInitialization: Promise<void> | undefined;

	public async handleImportFile(
		panel: vscode.WebviewPanel,
		documentUri: string,
		panelId: number
	): Promise<void> {
		const importFileUri = await selectFile({
			canSelectFiles: false,
			canSelectFolders: false,
			filters: { file: ['km', 'txt', 'md', 'json', 'xmind'] },
		});
		if (!importFileUri) {
			return;
		}
		const basename = path.extname(importFileUri.fsPath).toLowerCase();
		if (!['.md', '.txt', '.km', '.json', '.xmind'].includes(basename)) {
			return;
		}
		try {
			const content = basename === '.xmind'
				? await this.getParser().xmindToJSON(importFileUri.fsPath)
				: await fs.promises.readFile(importFileUri.fsPath, 'utf8');
			await panel.webview.postMessage({
				command: 'importNewData',
				protocolVersion: 1,
				content,
				basename,
			});
		} catch (error) {
			logLifecycle('webview.importFile.failed', {
				documentUri,
				panelId,
				error: error instanceof Error ? error.stack || error.message : String(error),
			});
			void vscode.window.showErrorMessage(
				`Unable to import the mind map: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	public async handleExport(
		message: any,
		config: vscode.WorkspaceConfiguration,
		documentUri: string,
		panelId: number
	): Promise<void> {
		try {
			const filters: Record<string, string[]> = { 'All Files': ['*'] };
			if (message.type === 'xmind') {
				filters['Text Files'] = ['xmind'];
			} else if (message.type === 'png') {
				filters['Images Files'] = ['png'];
			}
			const rootUri = getRootUri();
			if (!rootUri) {
				return;
			}
			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(path.join(rootUri.fsPath, `${message.filename}.${message.type}`)),
				filters,
			});
			if (!uri) {
				return;
			}
			if (message.type === 'xmind') {
				await this.getParser().JSONToXmind(JSON.parse(message.content), uri.fsPath);
			} else if (message.type === 'png') {
				const { Resvg } = await this.getResvgRuntime();
				const svg = await changeSvgImg(message.content);
				if (svg) {
					const fontBuffer = await fs.promises.readFile(path.resolve(fontPath));
					const resvg = new Resvg(svg, {
						background: config.get<string>('imageBackgroundColor', '#ffffff'),
						fitTo: { mode: 'zoom', value: config.get<number>('imageScaleSize', 2) },
						font: { fontBuffers: [fontBuffer], loadSystemFonts: false },
					});
					await fs.promises.writeFile(uri.fsPath, resvg.render().asPng());
				}
			} else if (message.type === 'json') {
				await fs.promises.writeFile(
					uri.fsPath,
					JSON.stringify(JSON.parse(message.content), null, '\t'),
					'utf8'
				);
			} else {
				await fs.promises.writeFile(uri.fsPath, message.content, 'utf8');
			}
		} catch (error) {
			logLifecycle('webview.export.failed', {
				documentUri,
				panelId,
				exportType: message.type ?? null,
				error: error instanceof Error ? error.stack || error.message : String(error),
			});
			void vscode.window.showErrorMessage(
				`Unable to export the mind map: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	public async readDocument(filePath: string, extension: string): Promise<string> {
		switch (extension.toLowerCase()) {
			case '.xmind': {
				const data = await this.getParser().xmindToJSON(filePath);
				return JSON.stringify(data) || '{}';
			}
			case '.km':
			case '.svg':
				return (await fs.promises.readFile(filePath, 'utf8')) || '{}';
			default:
				return '';
		}
	}

	public async writeDocument(filePath: string, extension: string, content: string): Promise<void> {
		if (extension.toLowerCase() === '.xmind') {
			await this.getParser().JSONToXmind(JSON.parse(content), filePath);
			return;
		}
		await fs.promises.writeFile(filePath, content, 'utf8');
	}

	private getParser(): XmindParser {
		if (!this.parser) {
			try {
				const Parser = require('../xmindparser');
				this.parser = new Parser();
				logLifecycle('runtime.xmindParser.initialized');
			} catch (error) {
				logLifecycle('runtime.xmindParser.failed', {
					error: error instanceof Error ? error.stack || error.message : String(error),
				});
				throw error;
			}
		}
		return this.parser!;
	}

	private async getResvgRuntime(): Promise<ResvgRuntime> {
		if (!this.resvgRuntime) {
			try {
				this.resvgRuntime = require('../wasm') as ResvgRuntime;
				logLifecycle('runtime.resvg.loaded');
			} catch (error) {
				logLifecycle('runtime.resvg.loadFailed', {
					error: error instanceof Error ? error.stack || error.message : String(error),
				});
				throw error;
			}
		}
		if (!this.resvgInitialization) {
			try {
				const wasmPath = path.join(__dirname, '../webui/resvg-js/index_bg.wasm');
				this.resvgInitialization = this.resvgRuntime.initWasm(fs.readFileSync(wasmPath)).then(() => {
					logLifecycle('runtime.resvg.initialized');
				});
			} catch (error) {
				logLifecycle('runtime.resvg.initializationFailed', {
					error: error instanceof Error ? error.stack || error.message : String(error),
				});
				throw error;
			}
		}
		await this.resvgInitialization;
		return this.resvgRuntime;
	}
}
