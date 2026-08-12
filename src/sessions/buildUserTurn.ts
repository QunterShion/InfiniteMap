import * as path from 'path';

export function normalizeKmPath(kmPath: string): string {
	const normalized = path.resolve(kmPath);
	if (path.extname(normalized).toLowerCase() !== '.km') {
		throw new Error('Agent sessions require a local .km document.');
	}
	return normalized;
}

export function buildUserTurn(text: string, kmPath: string): string {
	const trustedPath = normalizeKmPath(kmPath);
	const prompt = text.trim();
	return prompt.length === 0 ? trustedPath : `${prompt}\n\n${trustedPath}`;
}

