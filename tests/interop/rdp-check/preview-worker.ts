/// <reference path="./preview-assets.d.ts" />
import type { Env } from '../../../src/types';
import app from '../../../src/worker/index';
import { openDesktop } from './desktop';
import boot from './preview-build/desktop.rdp-text';
import page from './preview-build/index.rdp-text';
import licenses from './preview-build/licenses.rdp-text';
import freeRdpWasmGzip from './preview-build/sdl-freerdp-gzip.rdp-bin';
import freeRdpScript from './preview-build/sdl-freerdp.rdp-text';
import { createPreviewHandler, type PreviewBindings, verifyPreviewSession } from './preview-handler';

// The test entry preserves the exact same Durable Object names, bindings, and migrations.
export { MCPExecutionDO, SSHSessionDO, SSHShareDO, UserDBDO } from '../../../src/worker/index';

export default {
  fetch: createPreviewHandler<Env & PreviewBindings, ExecutionContext>({
    main: (request, env, ctx) => app.fetch(request, env, ctx),
    isAuthenticated: verifyPreviewSession,
    open: openDesktop,
    gzipWasm: freeRdpWasmGzip,
    files: new Map([
      ['/index.html', [page, 'text/html; charset=utf-8']],
      ['/desktop.js', [boot, 'text/javascript; charset=utf-8']],
      ['/sdl-freerdp.js', [freeRdpScript, 'text/javascript; charset=utf-8']],
      ['/licenses.txt', [licenses, 'text/plain; charset=utf-8']],
    ]),
  }),
};
