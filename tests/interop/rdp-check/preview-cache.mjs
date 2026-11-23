import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

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
let wasm;
let glue;
for (const [name, limit] of Object.entries(files)) {
  const contents = readFile(cache, name, limit);
  const hash = createHash('sha256').update(contents).digest('hex');
  if (mode === 'record') manifest[name] = hash;
  else if (manifest?.[name] !== hash) throw new Error(`RDP preview checksum mismatch: ${name}`);
  if (name === 'sdl-freerdp.rdp-bin') {
    if (!WebAssembly.validate(contents)) throw new Error('Invalid RDP preview WASM');
    wasm = contents;
  }
  if (name === 'sdl-freerdp.rdp-text') glue = contents.toString('utf8');
}
// The pinned Emscripten glue prestarts 32 workers and waits for all of them.
// Keep its dynamic growth behavior, but only wait for four before starting FreeRDP.
const pool = 'initMainThread(){var pthreadPoolSize=32;';
if (!glue || glue.split(pool).length !== 2 || !wasm) {
  throw new Error('Unexpected FreeRDP browser glue; recheck the pinned thread pool');
}
if (!glue.includes('takeWindowsPassword') || !glue.includes('onWindowsFirstFrame')) {
  throw new Error('Missing FreeRDP browser credential/first-frame bridge');
}
const tunedGlue = glue.replace(pool, 'initMainThread(){var pthreadPoolSize=4;');
if (mode === 'record') writeFileSync(join(cache, 'sha256.json'), `${JSON.stringify(manifest)}\n`);

mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'sdl-freerdp.rdp-text'), tunedGlue);
writeFileSync(join(output, 'sdl-freerdp.rdp-bin'), wasm);
writeFileSync(join(output, 'sdl-freerdp-gzip.rdp-bin'), gzipSync(wasm, { level: 9 }));
const tags = [tunedGlue, wasm].map((bytes) => createHash('sha256').update(bytes).digest('hex'));
writeFileSync(join(output, 'client-tags.rdp-text'), JSON.stringify(tags));
copyFileSync(join(cache, 'licenses.rdp-text'), join(output, 'licenses.rdp-text'));
// UI sources are intentionally never cached: even a cache hit packages this commit's page.
copyFileSync(join(desktopSource, 'index.html'), join(output, 'index.rdp-text'));
copyFileSync(join(desktopSource, 'desktop.js'), join(output, 'desktop.rdp-text'));
