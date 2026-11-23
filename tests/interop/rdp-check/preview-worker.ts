/// <reference path="./preview-assets.d.ts" />
import type { Env } from '../../../src/types';
import {
  getAuthenticatedUser,
  initializeAccessIdentity,
  userDbRouteKey,
} from '../../../src/worker/auth';
import app from '../../../src/worker/index';
import { openDesktop } from './desktop';
import boot from './preview-build/desktop.rdp-text';
import page from './preview-build/index.rdp-text';
import licenses from './preview-build/licenses.rdp-text';
import freeRdpWasm from './preview-build/sdl-freerdp.rdp-bin';
import freeRdpScript from './preview-build/sdl-freerdp.rdp-text';
import { createPreviewHandler, type PreviewBindings } from './preview-handler';

// The test entry preserves the exact same Durable Object names, bindings, and migrations.
export { MCPExecutionDO, SSHSessionDO, SSHShareDO, UserDBDO } from '../../../src/worker/index';

export default {
  fetch: createPreviewHandler<Env & PreviewBindings, ExecutionContext>({
    main: (request, env, ctx) => app.fetch(request, env, ctx),
    async getOwner(request, env, ctx) {
      await initializeAccessIdentity(request, ctx);
      const user = await getAuthenticatedUser(request, env);
      return user ? userDbRouteKey(user) : null;
    },
    open: openDesktop,
    files: new Map([
      ['/index.html', [page, 'text/html; charset=utf-8']],
      ['/desktop.js', [boot, 'text/javascript; charset=utf-8']],
      ['/sdl-freerdp.js', [freeRdpScript, 'text/javascript; charset=utf-8']],
      ['/sdl-freerdp.wasm', [freeRdpWasm, 'application/wasm']],
      ['/licenses.txt', [licenses, 'text/plain; charset=utf-8']],
    ]),
  }),
};
