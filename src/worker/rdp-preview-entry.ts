/// <reference path="./rdp-client/modules.d.ts" />
// Only the explicit test deployment bundles the un-signed program that was just built from this checkout.
import { rdpWorker } from './rdp-entry';
import preview from './rdp-client/connector-preview.generated.rdp-bin';
export { MCPExecutionDO, RdpAuthorityDO, SSHSessionDO, SSHShareDO, UserDBDO } from './rdp-entry';
export default rdpWorker(preview);
