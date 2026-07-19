import * as vscode from 'vscode';
import { MindEditorProvider } from './mindEditor';
import { extensionHostSessionId, logLifecycle, setLifecycleOutputChannel } from './lifecycle';

export function activate(context: vscode.ExtensionContext) {
	const lifecycleOutput = vscode.window.createOutputChannel('InfiniteMap Lifecycle');
	context.subscriptions.push(lifecycleOutput);
	setLifecycleOutputChannel(lifecycleOutput);
	logLifecycle('extension.activate.begin', {
		viewType: 'infinite-map.editor',
		activationEvent: 'onCustomEditor:infinite-map.editor',
	});
	try {
		context.subscriptions.push(MindEditorProvider.register(context, extensionHostSessionId));
		logLifecycle('extension.activate.providerRegistered', {
			viewType: 'infinite-map.editor',
			providerType: 'CustomEditorProvider',
		});
	} catch (error) {
		logLifecycle('extension.activate.providerRegistrationFailed', {
			viewType: 'infinite-map.editor',
			error: error instanceof Error ? error.stack || error.message : String(error),
		});
		throw error;
	}
}

export function deactivate() {
	logLifecycle('extension.deactivate', { viewType: 'infinite-map.editor' });
}
