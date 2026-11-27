/// <reference path="./rdp-client/modules.d.ts" />
import type { Env } from '../types';
import app from './index';
import bootstrap from './rdp-client/desktop.rdp-text';
import page from './rdp-client/index.rdp-text';
import peer from './rdp-client/rdp-peer.rdp-text';
import socket from './rdp-client/rdp-socket.rdp-text';
import tags from './rdp-client/vendor/client-tags.rdp-text';
import license from './rdp-client/vendor/licenses.rdp-text';
import wasm from './rdp-client/vendor/sdl-freerdp-gzip.rdp-bin';
import freerdp from './rdp-client/vendor/sdl-freerdp.rdp-text';

// Keep built-in browser assets separate from the SSH inline bundle and do not enable
// Workers Static Assets, which does not pass native Access context through its router.
export { MCPExecutionDO, SSHSessionDO, SSHShareDO, UserDBDO } from './index';
export { RdpAuthorityDO } from './rdp-device-auth';
const assets = { page, bootstrap, socket, peer, freerdp, wasm, license, tags: JSON.parse(tags) as string[] };

export function rdpWorker(connectorPreview?: ArrayBuffer) {
  const packaged = { ...assets, connectorPreview };
  return {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return app.fetch(request, env, ctx, packaged);
    },
  };
}

export default rdpWorker();
