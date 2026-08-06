import * as fs from 'fs';
import * as path from 'path';

const FALLBACK_NODE_NAME = 'split-node';
const MAX_FILENAME_LENGTH = 80;

export function prepareSplitContent(content: unknown): string {
	if (typeof content !== 'string') {
		throw new Error('The split node payload is missing.');
	}

	let parsed: any;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error('The split node payload is not valid JSON.');
	}

	if (!parsed || typeof parsed !== 'object' || !parsed.root || typeof parsed.root !== 'object') {
		throw new Error('The split node payload does not contain a root node.');
	}
	if (!parsed.root.data || typeof parsed.root.data !== 'object') {
		throw new Error('The split node root does not contain node data.');
	}

	return JSON.stringify(parsed, null, '\t');
}

export function suggestSplitPath(sourcePath: string, nodeText: unknown): string {
	const rawName = typeof nodeText === 'string' ? nodeText.trim() : '';
	const safeName = rawName
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
		.replace(/[. ]+$/g, '')
		.slice(0, MAX_FILENAME_LENGTH) || FALLBACK_NODE_NAME;
	return path.join(path.dirname(sourcePath), `${safeName}.km`);
}

export function assertDifferentSplitDestination(sourcePath: string, destinationPath: string): void {
	if (path.extname(destinationPath).toLowerCase() !== '.km') {
		throw new Error('Choose a file name ending in .km.');
	}
	const normalize = (value: string) => {
		let resolved = path.resolve(value);
		try {
			resolved = fs.realpathSync.native(resolved);
		} catch {
			// A new destination has no real path yet; the resolved path remains comparable.
		}
		return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
	};
	const source = normalize(sourcePath);
	const destination = normalize(destinationPath);
	if (source === destination) {
		throw new Error('Choose a different file name so the current mind map is not overwritten.');
	}
}

export async function writeSplitFile(destinationPath: string, content: unknown): Promise<void> {
	const prepared = prepareSplitContent(content);
	const temporaryPath = `${destinationPath}.${process.pid}.${Date.now()}.infinite-map-tmp`;
	let temporaryHandle: fs.promises.FileHandle | undefined;
	try {
		temporaryHandle = await fs.promises.open(temporaryPath, 'wx', 0o600);
		await temporaryHandle.writeFile(prepared, 'utf8');
		await temporaryHandle.sync();
		await temporaryHandle.close();
		temporaryHandle = undefined;
		await fs.promises.rename(temporaryPath, destinationPath);
		const persisted = await fs.promises.readFile(destinationPath, 'utf8');
		if (persisted !== prepared) {
			throw new Error('The split mind map could not be verified after writing.');
		}
	} finally {
		if (temporaryHandle) {
			await temporaryHandle.close().catch(() => undefined);
		}
		await fs.promises.unlink(temporaryPath).catch(() => undefined);
	}
}
