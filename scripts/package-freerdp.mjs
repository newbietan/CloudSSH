import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [script, wasm, licenses, output] = process.argv.slice(2);
if (!script || !wasm || !licenses || !output) throw new Error('Pass compiled JS, WASM, licenses and output directory');
function bounded(path, bytes) {
  if (statSync(path).size > bytes) throw new Error('FreeRDP artifact exceeds its size budget');
  return readFileSync(path);
}
let glue = bounded(script, 2 * 1024 * 1024).toString('utf8');
const module = bounded(wasm, 24 * 1024 * 1024);
const notice = bounded(licenses, 2 * 1024 * 1024).toString('utf8').replace(/[ \t]+(?=\r?$)/gm, '');
if (!WebAssembly.validate(module)) throw new Error('Invalid WASM');
if (['takeWindowsPassword', 'onWindowsFirstFrame', 'onWindowsCertificate', 'onWindowsDisplayControl', '_cloudssh_take_rdp_rtt'].some((hook) => !glue.includes(hook))) {
  throw new Error('Missing browser bridge');
}
function patch(needle, replacement) {
  if (glue.split(needle).length !== 2) throw new Error(`Recheck pinned Emscripten ABI: ${needle}`);
  glue = glue.replace(needle, replacement);
}
patch('initMainThread(){var pthreadPoolSize=32;', 'initMainThread(){var pthreadPoolSize=4;');
patch('ws=new WebSocketConstructor(url,opts);', 'ws=Module["createRdpSocket"](url);');
patch('sock.recv_queue.unshift(queued)}return res}}};', 'sock.recv_queue.unshift(queued)}SOCKFS.websocket_sock_ops.getPeer(sock,queued.addr,queued.port)?.socket.consumed(bytesRead);return res}}};');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const gzip = gzipSync(module, { level: 9 });
if (gzip.length > 5 * 1024 * 1024) throw new Error('Compressed FreeRDP module exceeds 5 MiB');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'sdl-freerdp.rdp-text'), glue);
writeFileSync(join(output, 'sdl-freerdp-gzip.rdp-bin'), gzip);
writeFileSync(join(output, 'licenses.rdp-text'), notice);
writeFileSync(join(output, 'client-tags.rdp-text'), JSON.stringify([sha(glue), sha(module)]));
writeFileSync(join(output, 'sha256.json'), JSON.stringify({ glue: sha(glue), wasm: sha(gzip), licenses: sha(notice) }) + '\n');
