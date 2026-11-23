import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = {
  'sdl-freerdp.rdp-bin': 24 * 1024 * 1024,
  'sdl-freerdp.rdp-text': 2 * 1024 * 1024,
  'licenses.rdp-text': 2 * 1024 * 1024,
};

function readFile(dir, name, limit) {
  const path = join(dir, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size === 0 || stat.size > limit) {
    throw new Error(`Invalid RDP preview asset: ${name}`);
  }
  return readFileSync(path);
}

const [mode, cache, output, desktopSource] = process.argv.slice(2);
if ((mode !== 'record' && mode !== 'stage') || !cache || !output || !desktopSource) {
  throw new Error('Usage: node preview-cache.mjs record|stage <cache> <output> <desktop-source>');
}
const manifest = mode === 'stage' ? JSON.parse(readFile(cache, 'sha256.json', 1024).toString()) : {};
for (const [name, limit] of Object.entries(files)) {
  const contents = readFile(cache, name, limit);
  const hash = createHash('sha256').update(contents).digest('hex');
  if (mode === 'record') manifest[name] = hash;
  else if (manifest?.[name] !== hash) throw new Error(`RDP preview checksum mismatch: ${name}`);
  if (name.endsWith('.rdp-bin') && !WebAssembly.validate(contents)) {
    throw new Error('Invalid RDP preview WASM');
  }
}
if (mode === 'record') writeFileSync(join(cache, 'sha256.json'), `${JSON.stringify(manifest)}\n`);

mkdirSync(output, { recursive: true });
for (const name of Object.keys(files)) copyFileSync(join(cache, name), join(output, name));
// UI sources are intentionally never cached: even a cache hit packages this commit's page.
copyFileSync(join(desktopSource, 'index.html'), join(output, 'index.rdp-text'));
copyFileSync(join(desktopSource, 'desktop.js'), join(output, 'desktop.rdp-text'));
