import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requiredFiles = [
  'webui/main.js',
  'webui/mindmap.html',
  'webui/refreshBtn.js',
  'webui/dist/kityminder.editor.min.js',
  'webui/dist/kityminder.editor.min.css',
  'webui/package-lock.json',
  'webui/resvg-js/index_bg.wasm',
  'webui/resvg-js/fonts/Alibaba_PuHuiTi_2.0_45_Light_45_Light.ttf',
  'webui/resvg-js/wasm/index_bg.wasm',
];

const errors = [];
for (const relativePath of requiredFiles) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) {
    errors.push(`missing required asset: ${relativePath}`);
  } else if (statSync(absolutePath).size === 0) {
    errors.push(`empty required asset: ${relativePath}`);
  }
}

function findPartFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'bower_components') {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      findPartFiles(absolutePath);
    } else if (entry.name.endsWith('.part')) {
      errors.push(`partial migration file remains: ${absolutePath.slice(root.length + 1)}`);
    }
  }
}

findPartFiles(join(root, 'webui'));

const mainScript = readFileSync(join(root, 'webui/main.js'), 'utf8');
for (const command of ['requestSave', 'ping', 'pong', 'loaded', 'reconnect', 'draft', 'importResult']) {
  if (!mainScript.includes(command)) {
    errors.push(`webui/main.js is missing the ${command} message handler`);
  }
}
if (!/command\s*:\s*['"]loaded['"]/.test(mainScript)) {
  errors.push('webui/main.js must send the legacy-compatible loaded handshake');
}
if (!mainScript.includes('mindmapSuppressDraft')) {
  errors.push('webui/main.js must suppress draft events during programmatic imports');
}

const refreshScript = readFileSync(join(root, 'webui/refreshBtn.js'), 'utf8');
for (const refreshContractToken of [
  'refresh-from-disk-btn',
  'aria-label=',
  "command: 'refresh', requestId",
  'refreshResult',
  'mindmap-refresh-icon',
  'MutationObserver',
]) {
  if (!refreshScript.includes(refreshContractToken)) {
    errors.push(`webui/refreshBtn.js is missing ${refreshContractToken}`);
  }
}

const editorSource = readFileSync(join(root, 'src/mindEditor.ts'), 'utf8');
for (const handshake of ["case 'loaded':", "case 'ready':", "case 'importResult':", "case 'refresh':"]) {
  if (!editorSource.includes(handshake)) {
    errors.push(`src/mindEditor.ts is missing the ${handshake} compatibility branch`);
  }
}
const draftStart = editorSource.indexOf("case 'draft':");
const draftEnd = editorSource.indexOf("case 'clicklink':", draftStart);
const draftHandler = editorSource.slice(draftStart, draftEnd);
if (draftStart < 0 || draftEnd < 0) {
  errors.push('src/mindEditor.ts is missing the draft message handler');
} else if (/writeFile|writeContent|persistContent|updateDocument/.test(draftHandler)) {
  errors.push('the draft handler must keep unsaved content in memory instead of writing to disk');
}
for (const saveContractToken of [
  'backupCustomDocument',
  'revertCustomDocument',
  'saveCustomDocumentAs',
  'SAVE_TIMEOUT_MS',
  'CustomDocumentContentChangeEvent',
]) {
  if (!editorSource.includes(saveContractToken)) {
    errors.push(`src/mindEditor.ts is missing ${saveContractToken}`);
  }
}
for (const refreshContractToken of [
  'refreshFromDisk',
  'pendingImports',
  'reloadInvocationCounts',
  'Save cancelled because the document is being reloaded from disk',
]) {
  if (!editorSource.includes(refreshContractToken)) {
    errors.push(`src/mindEditor.ts is missing ${refreshContractToken}`);
  }
}
if (editorSource.includes("throw new Error('Method not implemented.')")) {
  errors.push('src/mindEditor.ts still contains an unimplemented custom-document operation');
}

const html = readFileSync(join(root, 'webui/mindmap.html'), 'utf8');
const refreshIndex = html.indexOf('/refreshBtn.js');
const mainIndex = html.indexOf('/main.js');
if (refreshIndex < 0 || mainIndex < 0 || refreshIndex > mainIndex) {
  errors.push('webui/mindmap.html must load refreshBtn.js before main.js');
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Verified ${requiredFiles.length} runtime assets and Webview message wiring.`);
}
