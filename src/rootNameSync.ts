import * as path from 'path';

const KM_EXTENSION = '.km';
const DEFAULT_GUARD_TTL_MS = 5000;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
const PORTABLE_FORBIDDEN_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/;

export type RootNameSyncBlockCode =
	| 'invalid-document'
	| 'invalid-root-name'
	| 'target-collision';

export type RootNameSyncPlan =
	| {
		kind: 'noop';
		reason: 'already-synchronized' | 'not-a-km-file';
		filePath: string;
	}
	| {
		kind: 'update-root';
		filePath: string;
		expectedContent: string;
		content: string;
		rootText: string;
	}
	| {
		kind: 'rename-file';
		fromPath: string;
		toPath: string;
		content: string;
		rootText: string;
		caseOnly: boolean;
	}
	| {
		kind: 'blocked';
		code: RootNameSyncBlockCode;
		filePath: string;
		message: string;
		targetPath?: string;
	};

export interface RootNamePathProbe {
	exists(filePath: string): Promise<boolean>;
	isSameFile?(leftPath: string, rightPath: string): Promise<boolean>;
}

export interface RootNameValidation {
	valid: boolean;
	message?: string;
}

interface JsonPropertyNode {
	key: string;
	value: JsonSyntaxNode;
}

interface JsonSyntaxNode {
	type: 'array' | 'object' | 'primitive' | 'string';
	start: number;
	end: number;
	properties?: JsonPropertyNode[];
}

/**
 * Builds just enough JSON syntax information to replace one string token.
 * JSON.parse validates the source first, so this parser never normalizes or
 * serializes unrelated data (including integers beyond JS's safe range).
 */
class JsonSyntaxParser {
	private offset = 0;

	constructor(private readonly source: string) {}

	parse(): JsonSyntaxNode {
		this.skipWhitespace();
		const node = this.parseValue();
		this.skipWhitespace();
		if (this.offset !== this.source.length) {
			throw new Error('Unexpected content after the JSON value.');
		}
		return node;
	}

	private parseValue(): JsonSyntaxNode {
		const character = this.source[this.offset];
		if (character === '{') {
			return this.parseObject();
		}
		if (character === '[') {
			return this.parseArray();
		}
		if (character === '"') {
			return this.parseString();
		}

		const start = this.offset;
		while (this.offset < this.source.length && !/[\s,\]}]/.test(this.source[this.offset])) {
			this.offset += 1;
		}
		return { type: 'primitive', start, end: this.offset };
	}

	private parseObject(): JsonSyntaxNode {
		const start = this.offset;
		const properties: JsonPropertyNode[] = [];
		this.offset += 1;
		this.skipWhitespace();
		if (this.source[this.offset] === '}') {
			this.offset += 1;
			return { type: 'object', start, end: this.offset, properties };
		}

		while (this.offset < this.source.length) {
			const keyNode = this.parseString();
			const key = JSON.parse(this.source.slice(keyNode.start, keyNode.end)) as string;
			this.skipWhitespace();
			if (this.source[this.offset] !== ':') {
				throw new Error('Expected a colon after an object key.');
			}
			this.offset += 1;
			this.skipWhitespace();
			properties.push({ key, value: this.parseValue() });
			this.skipWhitespace();
			if (this.source[this.offset] === '}') {
				this.offset += 1;
				return { type: 'object', start, end: this.offset, properties };
			}
			if (this.source[this.offset] !== ',') {
				throw new Error('Expected a comma between object properties.');
			}
			this.offset += 1;
			this.skipWhitespace();
		}
		throw new Error('Unterminated JSON object.');
	}

	private parseArray(): JsonSyntaxNode {
		const start = this.offset;
		this.offset += 1;
		this.skipWhitespace();
		if (this.source[this.offset] === ']') {
			this.offset += 1;
			return { type: 'array', start, end: this.offset };
		}

		while (this.offset < this.source.length) {
			this.parseValue();
			this.skipWhitespace();
			if (this.source[this.offset] === ']') {
				this.offset += 1;
				return { type: 'array', start, end: this.offset };
			}
			if (this.source[this.offset] !== ',') {
				throw new Error('Expected a comma between array values.');
			}
			this.offset += 1;
			this.skipWhitespace();
		}
		throw new Error('Unterminated JSON array.');
	}

	private parseString(): JsonSyntaxNode {
		const start = this.offset;
		if (this.source[this.offset] !== '"') {
			throw new Error('Expected a JSON string.');
		}
		this.offset += 1;
		while (this.offset < this.source.length) {
			const character = this.source[this.offset];
			this.offset += 1;
			if (character === '\\') {
				this.offset += 1;
				continue;
			}
			if (character === '"') {
				return { type: 'string', start, end: this.offset };
			}
		}
		throw new Error('Unterminated JSON string.');
	}

	private skipWhitespace(): void {
		while (this.offset < this.source.length && /\s/.test(this.source[this.offset])) {
			this.offset += 1;
		}
	}
}

function findLastProperty(node: JsonSyntaxNode, key: string): JsonSyntaxNode | undefined {
	const properties = node.type === 'object' ? node.properties || [] : [];
	for (let index = properties.length - 1; index >= 0; index -= 1) {
		if (properties[index].key === key) {
			return properties[index].value;
		}
	}
	return undefined;
}

function findRootTextNode(content: string): JsonSyntaxNode {
	// Validate first. The syntax parser deliberately assumes valid JSON so it can
	// stay small and preserve every unrelated byte exactly as authored.
	const documentValue = JSON.parse(content) as unknown;
	if (!documentValue || typeof documentValue !== 'object' || Array.isArray(documentValue)) {
		throw new Error('The .km document must contain a JSON object.');
	}
	const rootValue = (documentValue as { root?: unknown }).root;
	if (!rootValue || typeof rootValue !== 'object' || Array.isArray(rootValue)) {
		throw new Error('The .km document is missing root.');
	}
	const dataValue = (rootValue as { data?: unknown }).data;
	if (!dataValue || typeof dataValue !== 'object' || Array.isArray(dataValue)) {
		throw new Error('The .km root is missing data.');
	}
	if (typeof (dataValue as { text?: unknown }).text !== 'string') {
		throw new Error('The .km root text must be a string.');
	}

	const syntaxRoot = new JsonSyntaxParser(content).parse();
	const rootNode = findLastProperty(syntaxRoot, 'root');
	const dataNode = rootNode && findLastProperty(rootNode, 'data');
	const textNode = dataNode && findLastProperty(dataNode, 'text');
	if (!textNode || textNode.type !== 'string') {
		throw new Error('The .km root text token could not be located.');
	}
	return textNode;
}

function blocked(
	filePath: string,
	code: RootNameSyncBlockCode,
	message: string,
	targetPath?: string
): RootNameSyncPlan {
	return { kind: 'blocked', code, filePath, message, ...(targetPath ? { targetPath } : {}) };
}

function kmExtension(filePath: string): string | undefined {
	const extension = path.extname(filePath);
	return extension.toLowerCase() === KM_EXTENSION ? extension : undefined;
}

export function getKmFileStem(filePath: string): string | undefined {
	const extension = kmExtension(filePath);
	if (!extension) {
		return undefined;
	}
	return path.basename(filePath).slice(0, -extension.length);
}

export function getKmRootText(content: string): string {
	const node = findRootTextNode(content);
	return JSON.parse(content.slice(node.start, node.end)) as string;
}

export function replaceKmRootText(content: string, rootText: string): string {
	const node = findRootTextNode(content);
	return content.slice(0, node.start) + JSON.stringify(rootText) + content.slice(node.end);
}

/**
 * Restricts generated names to the portable intersection of macOS, Linux and
 * Windows. Invalid input is rejected, never silently sanitized, so root text
 * and the resulting filename cannot diverge.
 */
export function validateKmRootName(rootText: string): RootNameValidation {
	if (rootText.length === 0) {
		return { valid: false, message: 'The root text cannot be empty.' };
	}
	if (rootText === '.' || rootText === '..') {
		return { valid: false, message: 'The root text cannot be . or ...' };
	}
	if (PORTABLE_FORBIDDEN_CHARACTERS.test(rootText)) {
		return { valid: false, message: 'The root text contains characters that are not valid in portable filenames.' };
	}
	if (/[. ]$/.test(rootText)) {
		return { valid: false, message: 'The root text cannot end with a period or space.' };
	}
	if (WINDOWS_RESERVED_NAME.test(rootText)) {
		return { valid: false, message: 'The root text is reserved as a device filename on Windows.' };
	}
	if (Buffer.byteLength(rootText + KM_EXTENSION, 'utf8') > 255) {
		return { valid: false, message: 'The generated .km filename exceeds 255 UTF-8 bytes.' };
	}
	return { valid: true };
}

/**
 * File rename is authoritative: only the root string token changes. The
 * expectedContent field is a compare-and-swap precondition for integration;
 * a caller must not overwrite the file if its content changed after planning.
 */
export function planRootUpdateAfterFileRename(newFilePath: string, content: string): RootNameSyncPlan {
	const fileStem = getKmFileStem(newFilePath);
	if (fileStem === undefined) {
		return { kind: 'noop', reason: 'not-a-km-file', filePath: newFilePath };
	}

	let currentRoot: string;
	try {
		currentRoot = getKmRootText(content);
	} catch (error) {
		return blocked(
			newFilePath,
			'invalid-document',
			`Cannot synchronize the renamed file because ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (currentRoot === fileStem) {
		return { kind: 'noop', reason: 'already-synchronized', filePath: newFilePath };
	}
	return {
		kind: 'update-root',
		filePath: newFilePath,
		expectedContent: content,
		content: replaceKmRootText(content, fileStem),
		rootText: fileStem,
	};
}

/**
 * Root edit is authoritative: return a collision-checked rename plan. The
 * actual integration must use a no-replace rename primitive; a preflight
 * exists check alone is not sufficient to prevent a TOCTOU overwrite.
 */
export async function planFileRenameAfterRootEdit(
	filePath: string,
	content: string,
	probe: RootNamePathProbe
): Promise<RootNameSyncPlan> {
	const extension = kmExtension(filePath);
	const fileStem = getKmFileStem(filePath);
	if (!extension || fileStem === undefined) {
		return { kind: 'noop', reason: 'not-a-km-file', filePath };
	}

	let rootText: string;
	try {
		rootText = getKmRootText(content);
	} catch (error) {
		return blocked(
			filePath,
			'invalid-document',
			`Cannot derive a filename because ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (rootText === fileStem) {
		return { kind: 'noop', reason: 'already-synchronized', filePath };
	}

	const validation = validateKmRootName(rootText);
	if (!validation.valid) {
		return blocked(filePath, 'invalid-root-name', validation.message || 'The root text is not a valid filename.');
	}

	const targetPath = path.join(path.dirname(filePath), rootText + extension);
	const occupied = await probe.exists(targetPath);
	let sameFile = false;
	if (occupied && probe.isSameFile) {
		sameFile = await probe.isSameFile(filePath, targetPath);
	}
	if (occupied && !sameFile) {
		return blocked(
			filePath,
			'target-collision',
			`A file already exists at ${targetPath}.`,
			targetPath
		);
	}

	return {
		kind: 'rename-file',
		fromPath: filePath,
		toPath: targetPath,
		content,
		rootText,
		caseOnly: occupied && sameFile,
	};
}

/**
 * One-shot event guard for the rename/write notifications caused by our own
 * synchronization. Equality planning remains the final backstop after expiry.
 */
export class RootNameSyncEventGuard {
	private readonly expectedRenames = new Map<string, number>();
	private readonly expectedRootWrites = new Map<string, { rootText: string; expiresAt: number }>();

	constructor(
		private readonly now: () => number = () => Date.now(),
		private readonly ttlMs = DEFAULT_GUARD_TTL_MS
	) {}

	rememberRename(fromPath: string, toPath: string): void {
		this.expectedRenames.set(this.renameKey(fromPath, toPath), this.now() + this.ttlMs);
	}

	consumeRename(fromPath: string, toPath: string): boolean {
		const key = this.renameKey(fromPath, toPath);
		const expiresAt = this.expectedRenames.get(key);
		this.expectedRenames.delete(key);
		return expiresAt !== undefined && expiresAt >= this.now();
	}

	rememberRootWrite(filePath: string, rootText: string): void {
		this.expectedRootWrites.set(path.resolve(filePath), {
			rootText,
			expiresAt: this.now() + this.ttlMs,
		});
	}

	consumeRootWrite(filePath: string, rootText: string): boolean {
		const key = path.resolve(filePath);
		const expected = this.expectedRootWrites.get(key);
		this.expectedRootWrites.delete(key);
		return Boolean(expected && expected.expiresAt >= this.now() && expected.rootText === rootText);
	}

	private renameKey(fromPath: string, toPath: string): string {
		return JSON.stringify([path.resolve(fromPath), path.resolve(toPath)]);
	}
}
