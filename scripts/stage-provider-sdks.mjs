import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'resources', 'provider-sdks');

await fs.mkdir(destination, { recursive: true });
await fs.copyFile(
	path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
	path.join(destination, 'claude-agent-sdk.mjs')
);
