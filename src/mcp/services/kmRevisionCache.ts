import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface RevisionCacheEntry {
	mtimeMs: number;
	revision: string;
}

const revisionCache = new Map<string, RevisionCacheEntry>();

export async function getCachedKmFileRevision(filePath: string): Promise<string> {
	const resolved = path.resolve(filePath);
	const stat = await fs.promises.stat(resolved);
	const cached = revisionCache.get(resolved);
	if (cached && cached.mtimeMs === stat.mtimeMs) {
		return cached.revision;
	}
	const content = await fs.promises.readFile(resolved);
	const revision = crypto.createHash('sha256').update(content).digest('hex');
	revisionCache.set(resolved, { mtimeMs: stat.mtimeMs, revision });
	return revision;
}

export function invalidateKmFileRevision(filePath: string): void {
	revisionCache.delete(path.resolve(filePath));
}

export function clearKmFileRevisionCache(): void {
	revisionCache.clear();
}
