import { SSHChannel } from '../ssh/channel';
import { SFTPClient } from '../ssh/sftp';
import {
  SSH_FXP_STATUS,
  SSH_FXP_HANDLE,
  SSH_FXP_DATA,
  SSH_FXP_NAME,
  SSH_FXP_ATTRS,
  SSH_FX_OK,
  SSH_FX_EOF,
  SSH_FXF_READ,
  SSH_FXF_WRITE,
  SSH_FXF_CREAT,
  SSH_FXF_TRUNC,
  getFileTypeFromPermissions,
  formatPermissions,
  formatFileSize,
  formatTimestamp,
  type SFTPFileEntry,
  type SFTPFileAttributes,
} from '../ssh/sftp-types';

export interface SFTPMessage {
  type: string;
  [key: string]: any;
}

const UPLOAD_CHUNK_SIZE = 32768;
const DOWNLOAD_CHUNK_SIZE = 32768;
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB limit

type SendEncryptedFn = (payload: Uint8Array) => Promise<void>;
type SendJSONFn = (msg: any) => void;
type SendBinaryFn = (data: Uint8Array) => void;
type SendDebugFn = (message: string) => void;

export class SFTPHandler {
  private channelID: number;
  private channel: SSHChannel;
  private sftp: SFTPClient;
  private sendEncrypted: SendEncryptedFn;
  private sendJSON: SendJSONFn;
  private sendBinary: SendBinaryFn;
  private sendDebug: SendDebugFn;
  private ready: boolean = false;

  // Upload state
  private uploadHandle: Uint8Array | null = null;
  private uploadOffset: number = 0;
  private uploadTotalSize: number = 0;
  private uploadPath: string = '';

  // SFTP channel data send (wraps SFTP packets in CHANNEL_DATA)
  private channelDataSend = (data: Uint8Array): void => {
    this.sendDebug(`[SFTP] channelDataSend: dataLen=${data.length}`);
    const chunk = this.channel.takeChannelDataChunk(data);
    if (chunk) {
      const packet = this.buildChannelDataPacket(chunk);
      this.sendDebug(`[SFTP] Built CHANNEL_DATA: len=${packet.length}, remoteChID=${this.channel.getRemoteChannelID()}`);
      // Fire and forget - sendEncrypted handles ordering via mutex
      this.sendEncrypted(packet).catch(err => {
        this.sendDebug(`[SFTP] channelDataSend FAILED: ${err}`);
      });
    } else {
      this.sendDebug(`[SFTP] channelDataSend: takeChannelDataChunk returned null!`);
    }
  };

  private buildChannelDataPacket(chunk: { source: Uint8Array; sourceOffset: number; bytesConsumed: number }): Uint8Array {
    const { source, sourceOffset, bytesConsumed } = chunk;
    const payload = new Uint8Array(9 + bytesConsumed);
    payload[0] = 94; // SSH_MSG_CHANNEL_DATA
    this.writeUint32BE(payload, 1, this.channel.getRemoteChannelID());
    this.writeUint32BE(payload, 5, bytesConsumed);
    payload.set(source.subarray(sourceOffset, sourceOffset + bytesConsumed), 9);
    return payload;
  }

  private writeUint32BE(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = (val >>> 24) & 0xff;
    buf[offset + 1] = (val >>> 16) & 0xff;
    buf[offset + 2] = (val >>> 8) & 0xff;
    buf[offset + 3] = val & 0xff;
  }

  constructor(
    channelID: number,
    channel: SSHChannel,
    sendEncrypted: SendEncryptedFn,
    sendJSON: SendJSONFn,
    sendBinary: SendBinaryFn,
    sendDebug: SendDebugFn,
  ) {
    this.channelID = channelID;
    this.channel = channel;
    this.sftp = new SFTPClient();
    this.sendEncrypted = sendEncrypted;
    this.sendJSON = sendJSON;
    this.sendBinary = sendBinary;
    this.sendDebug = sendDebug;

    this.sftp.setSendCallback(this.channelDataSend);
    this.sftp.setDebugCallback(sendDebug);
    this.sftp.setVersionCallback((version: number) => {
      this.sendDebug(`[SFTP] Version callback: ${version}`);
      if (!this.ready) {
        this.ready = true;
        this.sendDebug(`[SFTP] Version OK (late)`);
        this.sendJSON({ type: 'sftp_ready' });
      }
    });
  }

  getChannelID(): number {
    return this.channelID;
  }

  isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    this.ready = false;
    this.uploadHandle = null;
    this.sftp.dispose();
  }

  // Called when CHANNEL_SUCCESS is received for the SFTP subsystem request
  async onSubsystemReady(): Promise<void> {
    const initPacket = this.sftp.buildInit();
    this.sendDebug(`[SFTP] onSubsystemReady: initLen=${initPacket.length}, bytes=[${Array.from(initPacket).join(',')}]`);

    this.sendDebug(`[SFTP] Sending init packet...`);
    this.channelDataSend(initPacket);

    try {
      this.sendDebug(`[SFTP] Waiting for version...`);
      await this.sftp.waitForVersion();
      this.ready = true;
      this.sendDebug(`[SFTP] Version OK`);
      this.sendJSON({ type: 'sftp_ready' });
    } catch (e) {
      this.sendDebug(`[SFTP] Version timeout, waiting for late response...`);
      // Don't send error yet - wait for late VERSION response
      // The versionResolve callback in SFTPClient will handle late responses
      this.waitForLateVersion();
    }
  }

  private async waitForLateVersion(): Promise<void> {
    // Wait up to 120 seconds for late VERSION response
    const maxWait = 120000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (this.ready) {
        // VERSION response was received late and processed
        return;
      }
      // Check if channel is still open
      if (this.channel.isClosed()) {
        this.sendDebug(`[SFTP] Channel closed while waiting for late VERSION`);
        this.sendJSON({ type: 'sftp_error', message: 'SFTP 通道已关闭' });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Timed out waiting for late response
    this.sendDebug(`[SFTP] No late VERSION response received`);
    this.sendJSON({ type: 'sftp_error', message: 'SFTP 版本协商超时' });
  }

  // Called when CHANNEL_DATA is received for the SFTP channel
  onChannelData(data: Uint8Array): void {
    this.sendDebug(`[SFTP] onChannelData: len=${data.length}, first=[${Array.from(data.slice(0, 5)).join(',')}]`);
    this.sftp.feed(data);
    this.sftp.processReceivedPackets();
  }

  onChannelEof(): void {
    this.sendJSON({ type: 'sftp_closed', message: 'SFTP 通道已关闭' });
  }

  onChannelClosed(): void {
    this.ready = false;
    this.sendJSON({ type: 'sftp_closed', message: 'SFTP 通道已关闭' });
  }

  onWindowAdjust(): void {
    // Flush any pending SFTP data if needed
  }

  // List directory
  async listDirectory(path: string): Promise<void> {
    if (!this.ready) {
      this.sendJSON({ type: 'sftp_error', message: 'SFTP 未就绪' });
      return;
    }

    try {
      this.sendDebug(`[SFTP] listDirectory: path="${path}"`);

      // Handle ~ as home directory - use realpath(".") to get current dir
      let resolvePath = path;
      if (path === '~' || path === '~/') {
        resolvePath = '.';
        this.sendDebug(`[SFTP] ~ detected, using "." to get home dir`);
      }

      // Resolve absolute path first
      const realPathResp = await this.sftp.realpath(resolvePath);
      const realPathType = realPathResp[0];
      let resolvedPath = path;
      if (realPathType === SSH_FXP_NAME) {
        const entries = this.sftp.parseNameResponse(realPathResp);
        this.sendDebug(`[SFTP] realpath entries: ${JSON.stringify(entries.map(e => e.filename))}`);
        if (entries.length > 0) {
          resolvedPath = entries[0].filename;
          this.sendDebug(`[SFTP] resolved path: "${resolvedPath}"`);
        }
      } else if (realPathType === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(realPathResp);
        this.sendDebug(`[SFTP] realpath failed: code=${status.code}, msg=${status.message}`);
      }

      // Open directory
      const openResp = await this.sftp.openDir(resolvedPath);
      const openType = openResp[0];

      if (openType === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(openResp);
        this.sendJSON({ type: 'sftp_error', message: status.message });
        return;
      }

      if (openType !== SSH_FXP_HANDLE) {
        this.sendJSON({ type: 'sftp_error', message: '打开目录失败' });
        return;
      }

      const handle = this.sftp.parseHandleResponse(openResp);

      // Read all entries
      const entries = await this.sftp.listAllEntries(handle);

      // Close handle
      await this.sftp.closeHandle(handle);

      // Format and send results
      const formatted = entries
        .filter(e => e.filename !== '.' && e.filename !== '..')
        .map(e => this.formatEntry(e));

      this.sendJSON({
        type: 'sftp_list_result',
        path: resolvedPath,
        entries: formatted,
      });
    } catch (e) {
      this.sendJSON({ type: 'sftp_error', message: '列出目录失败: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  // Stat a file
  async stat(path: string): Promise<void> {
    if (!this.ready) {
      this.sendJSON({ type: 'sftp_error', message: 'SFTP 未就绪' });
      return;
    }

    try {
      const resp = await this.sftp.stat(path);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        this.sendJSON({ type: 'sftp_error', message: status.message });
        return;
      }

      if (type === SSH_FXP_ATTRS) {
        const attrs = this.sftp.parseAttrsResponse(resp);
        this.sendJSON({ type: 'sftp_stat_result', path, attrs: this.formatAttrs(attrs) });
      }
    } catch (e) {
      this.sendJSON({ type: 'sftp_error', message: '获取文件信息失败: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  // Download a file
  async downloadFile(path: string): Promise<void> {
    if (!this.ready) {
      this.sendJSON({ type: 'sftp_error', message: 'SFTP 未就绪' });
      return;
    }

    try {
      // Get file size first
      const statResp = await this.sftp.stat(path);
      const statType = statResp[0];
      let fileSize = 0;
      if (statType === SSH_FXP_ATTRS) {
        const attrs = this.sftp.parseAttrsResponse(statResp);
        fileSize = attrs.size || 0;
      }

      if (fileSize > MAX_FILE_SIZE) {
        this.sendJSON({ type: 'sftp_error', message: `文件过大 (${formatFileSize(fileSize)})，最大支持 ${formatFileSize(MAX_FILE_SIZE)}` });
        return;
      }

      // Open file for reading
      const openResp = await this.sftp.openFile(path, SSH_FXF_READ);
      const openType = openResp[0];

      if (openType === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(openResp);
        this.sendJSON({ type: 'sftp_error', message: status.message });
        return;
      }

      if (openType !== SSH_FXP_HANDLE) {
        this.sendJSON({ type: 'sftp_error', message: '打开文件失败' });
        return;
      }

      const handle = this.sftp.parseHandleResponse(openResp);
      const filename = path.split('/').pop() || path;

      // Notify frontend download started
      this.sendJSON({ type: 'sftp_download_start', filename, size: fileSize });

      // Read file in chunks
      let offset = 0;
      while (true) {
        const readResp = await this.sftp.readFile(handle, offset, DOWNLOAD_CHUNK_SIZE);
        const readType = readResp[0];

        if (readType === SSH_FXP_STATUS) {
          const status = this.sftp.parseStatusResponse(readResp);
          if (status.code === SSH_FX_EOF) break;
          this.sendJSON({ type: 'sftp_error', message: status.message });
          break;
        }

        if (readType === SSH_FXP_DATA) {
          const chunkData = this.sftp.parseDataResponse(readResp);
          if (chunkData.length === 0) break;

          // Send binary chunk to frontend
          this.sendBinary(chunkData);
          offset += chunkData.length;

          // Send progress
          if (fileSize > 0) {
            this.sendJSON({ type: 'sftp_download_progress', loaded: offset, total: fileSize });
          }
        }
      }

      // Close handle
      await this.sftp.closeHandle(handle);

      // Notify frontend download complete
      this.sendJSON({ type: 'sftp_download_done', filename, size: offset });
    } catch (e) {
      this.sendJSON({ type: 'sftp_error', message: '下载文件失败: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  // Start file upload
  async uploadStart(path: string, totalSize: number): Promise<void> {
    if (!this.ready) {
      this.sendJSON({ type: 'sftp_error', message: 'SFTP 未就绪' });
      return;
    }

    try {
      this.uploadPath = path;
      this.uploadTotalSize = totalSize;
      this.uploadOffset = 0;

      const openResp = await this.sftp.openFile(path, SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_TRUNC);
      const openType = openResp[0];

      if (openType === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(openResp);
        this.sendJSON({ type: 'sftp_error', message: status.message });
        this.uploadHandle = null;
        return;
      }

      if (openType !== SSH_FXP_HANDLE) {
        this.sendJSON({ type: 'sftp_error', message: '创建文件失败' });
        this.uploadHandle = null;
        return;
      }

      this.uploadHandle = this.sftp.parseHandleResponse(openResp);
      this.sendJSON({ type: 'sftp_upload_ready', path });
    } catch (e) {
      this.sendJSON({ type: 'sftp_error', message: '创建文件失败: ' + (e instanceof Error ? e.message : String(e)) });
      this.uploadHandle = null;
    }
  }

  // Handle upload chunk (binary data from frontend)
  async onUploadChunk(data: Uint8Array): Promise<void> {
    if (!this.uploadHandle) {
      this.sendJSON({ type: 'sftp_error', message: '上传未初始化' });
      return;
    }

    try {
      const resp = await this.sftp.writeFile(this.uploadHandle, this.uploadOffset, data);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          this.sendJSON({ type: 'sftp_error', message: status.message });
          return;
        }
      }

      this.uploadOffset += data.length;

      if (this.uploadTotalSize > 0) {
        this.sendJSON({
          type: 'sftp_upload_progress',
          loaded: this.uploadOffset,
          total: this.uploadTotalSize,
        });
      }
    } catch (e) {
      this.sendJSON({ type: 'sftp_error', message: '写入文件失败: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  // Finish upload
  async uploadEnd(): Promise<void> {
    if (this.uploadHandle) {
      try {
        await this.sftp.closeHandle(this.uploadHandle);
      } catch {}
    }

    this.sendJSON({
      type: 'sftp_upload_complete',
      path: this.uploadPath,
      size: this.uploadOffset,
    });

    this.uploadHandle = null;
    this.uploadOffset = 0;
    this.uploadPath = '';
    this.uploadTotalSize = 0;
  }

  // Cancel upload
  uploadCancel(): void {
    if (this.uploadHandle) {
      void this.sftp.closeHandle(this.uploadHandle).catch(() => {});
    }

    this.uploadHandle = null;
    this.uploadOffset = 0;
    this.uploadPath = '';
    this.uploadTotalSize = 0;

    this.sendJSON({ type: 'sftp_upload_cancelled' });
  }

  // Delete file
  async deletePath(path: string): Promise<void> {
    if (!this.ready) {
      this.sendJSON({ type: 'sftp_error', message: 'SFTP 未就绪' });
      return;
    }

    try {
      const resp = await this.sftp.removeFile(path);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          this.sendJSON({ type: 'sftp_error', message: status.message });
          return;
        }
      }

      this.sendJSON({ type: 'sftp_delete_result', path, success: true });
    } catch (e) {
      this.sendJSON({ type: 'sftp_error', message: '删除失败: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  // Rename
  async renamePath(oldPath: string, newPath: string): Promise<void> {
    if (!this.ready) {
      this.sendJSON({ type: 'sftp_error', message: 'SFTP 未就绪' });
      return;
    }

    try {
      const resp = await this.sftp.rename(oldPath, newPath);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          this.sendJSON({ type: 'sftp_error', message: status.message });
          return;
        }
      }

      this.sendJSON({ type: 'sftp_rename_result', oldPath, newPath, success: true });
    } catch (e) {
      this.sendJSON({ type: 'sftp_error', message: '重命名失败: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  // Create directory
  async makeDirectory(path: string): Promise<void> {
    if (!this.ready) {
      this.sendJSON({ type: 'sftp_error', message: 'SFTP 未就绪' });
      return;
    }

    try {
      const resp = await this.sftp.mkdir(path);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          this.sendJSON({ type: 'sftp_error', message: status.message });
          return;
        }
      }

      this.sendJSON({ type: 'sftp_mkdir_result', path, success: true });
    } catch (e) {
      this.sendJSON({ type: 'sftp_error', message: '创建目录失败: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  // Remove directory
  async removeDirectory(path: string): Promise<void> {
    if (!this.ready) {
      this.sendJSON({ type: 'sftp_error', message: 'SFTP 未就绪' });
      return;
    }

    try {
      const resp = await this.sftp.rmdir(path);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          this.sendJSON({ type: 'sftp_error', message: status.message });
          return;
        }
      }

      this.sendJSON({ type: 'sftp_rmdir_result', path, success: true });
    } catch (e) {
      this.sendJSON({ type: 'sftp_error', message: '删除目录失败: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  // Format a directory entry for the frontend
  private formatEntry(entry: SFTPFileEntry): any {
    const type = entry.attrs.permissions !== undefined
      ? getFileTypeFromPermissions(entry.attrs.permissions)
      : 'file';

    return {
      name: entry.filename,
      type,
      size: entry.attrs.size || 0,
      sizeFormatted: formatFileSize(entry.attrs.size || 0),
      permissions: entry.attrs.permissions !== undefined ? formatPermissions(entry.attrs.permissions) : '---------',
      permissionsRaw: entry.attrs.permissions || 0,
      modifiedTime: entry.attrs.mtime || 0,
      modifiedTimeFormatted: entry.attrs.mtime ? formatTimestamp(entry.attrs.mtime) : '',
      isDir: type === 'dir',
      isLink: type === 'link',
    };
  }

  private formatAttrs(attrs: SFTPFileAttributes): any {
    const type = attrs.permissions !== undefined
      ? getFileTypeFromPermissions(attrs.permissions)
      : 'file';

    return {
      type,
      size: attrs.size || 0,
      sizeFormatted: formatFileSize(attrs.size || 0),
      permissions: attrs.permissions !== undefined ? formatPermissions(attrs.permissions) : '---------',
      modifiedTime: attrs.mtime || 0,
      modifiedTimeFormatted: attrs.mtime ? formatTimestamp(attrs.mtime) : '',
    };
  }
}
