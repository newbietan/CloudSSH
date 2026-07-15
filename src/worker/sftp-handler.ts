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
  type SFTPFileEntry,
  type SFTPFileAttributes,
} from '../ssh/sftp-types';

const DOWNLOAD_CHUNK_SIZE = 128 * 1024;
const DOWNLOAD_CONCURRENCY = 8;
const DOWNLOAD_PROGRESS_CHUNKS = 8;
const UPLOAD_PROGRESS_CHUNKS = 8;
const MAX_SFTP_FILE_SIZE = 500 * 1024 * 1024; // 500MB limit

type SendEncryptedFn = (payload: Uint8Array) => Promise<void>;
type SendJSONFn = (msg: any) => void;
type SendBinaryFn = (data: Uint8Array) => void;
type SendDebugFn = (message: string) => void;
type SFTPOperation = 'init' | 'list' | 'stat' | 'download' | 'upload' | 'delete' | 'rename' | 'mkdir' | 'rmdir';

export class SFTPHandler {
  private channelID: number;
  private channel: SSHChannel;
  private sftp: SFTPClient;
  private sendEncrypted: SendEncryptedFn;
  private sendJSON: SendJSONFn;
  private sendBinary: SendBinaryFn;
  private sendDebug: SendDebugFn;
  private debugEnabled: boolean;
  private ready: boolean = false;
  private sftpSendQueue: Array<{ data: Uint8Array; offset: number }> = [];
  private sftpSendQueueHead: number = 0;
  private sftpSendFlushInProgress: boolean = false;
  private downloadCancelled: boolean = false;

  // Upload state
  private uploadHandle: Uint8Array | null = null;
  private uploadOffset: number = 0;
  private uploadBytesWritten: number = 0;
  private uploadChunksSinceProgress: number = 0;
  private uploadTotalSize: number = 0;
  private uploadPath: string = '';
  private uploadWritePromises: Set<Promise<void>> = new Set();
  private uploadError: Error | null = null;

  // SFTP channel data send (wraps SFTP packets in CHANNEL_DATA)
  private channelDataSend = (data: Uint8Array): void => {
    if (this.debugEnabled) this.sendDebug(`[SFTP] channelDataSend: dataLen=${data.length}`);
    this.sftpSendQueue.push({ data, offset: 0 });
    void this.flushSFTPSendQueue();
  };

  private async flushSFTPSendQueue(): Promise<void> {
    if (this.sftpSendFlushInProgress) return;

    this.sftpSendFlushInProgress = true;
    try {
      while (this.sftpSendQueueHead < this.sftpSendQueue.length) {
        const current = this.sftpSendQueue[this.sftpSendQueueHead];
        const chunk = this.channel.takeChannelDataChunk(current.data, current.offset);
        if (!chunk) {
          if (this.debugEnabled) this.sendDebug(`[SFTP] send queue paused: offset=${current.offset}, dataLen=${current.data.length}`);
          break;
        }

        const packet = this.buildChannelDataPacket(chunk);
        if (this.debugEnabled) this.sendDebug(`[SFTP] Built CHANNEL_DATA: len=${packet.length}, remoteChID=${this.channel.getRemoteChannelID()}`);
        await this.sendEncrypted(packet);

        current.offset += chunk.bytesConsumed;
        if (current.offset >= current.data.length) {
          this.sftpSendQueueHead++;
        }
      }

      if (this.sftpSendQueueHead > 0) {
        this.sftpSendQueue = this.sftpSendQueue.slice(this.sftpSendQueueHead);
        this.sftpSendQueueHead = 0;
      }
    } catch (err) {
      this.sendDebug(`[SFTP] flushSFTPSendQueue FAILED: ${err}`);
    } finally {
      this.sftpSendFlushInProgress = false;
    }
  }

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
    debugEnabled: boolean = false,
  ) {
    this.channelID = channelID;
    this.channel = channel;
    this.sftp = new SFTPClient();
    this.sendEncrypted = sendEncrypted;
    this.sendJSON = sendJSON;
    this.sendBinary = sendBinary;
    this.sendDebug = sendDebug;
    this.debugEnabled = debugEnabled;

    this.sftp.setSendCallback(this.channelDataSend);
    this.sftp.setDebugCallback(sendDebug, debugEnabled);
  }

  getChannelID(): number {
    return this.channelID;
  }

  isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    this.ready = false;
    this.downloadCancelled = true;
    this.resetUploadState();
    this.sftpSendQueue = [];
    this.sftpSendQueueHead = 0;
    this.sftp.dispose();
  }

  private resetUploadState(): void {
    this.uploadHandle = null;
    this.uploadOffset = 0;
    this.uploadBytesWritten = 0;
    this.uploadChunksSinceProgress = 0;
    this.uploadTotalSize = 0;
    this.uploadPath = '';
    this.uploadWritePromises.clear();
    this.uploadError = null;
  }

  private sendError(operation: SFTPOperation, message: string): void {
    this.sendJSON({ type: 'sftp_error', operation, message });
  }

  private trackUploadWrite(writePromise: Promise<void>): Promise<void> {
    this.uploadWritePromises.add(writePromise);

    writePromise
      .catch((e) => {
        const error = e instanceof Error ? e : new Error(String(e));
        if (!this.uploadError) {
          this.uploadError = error;
          this.sendError('upload', '写入文件失败: ' + error.message);
        }
      })
      .finally(() => {
        this.uploadWritePromises.delete(writePromise);
      });

    return writePromise;
  }

  private async drainUploadWrites(): Promise<void> {
    if (this.uploadWritePromises.size > 0) {
      await Promise.allSettled(Array.from(this.uploadWritePromises));
    }
  }

  private async closeUploadHandle(): Promise<void> {
    const handle = this.uploadHandle;
    this.uploadHandle = null;
    if (handle) {
      await this.sftp.closeHandle(handle).catch(() => {});
    }
  }

  private async removeIncompleteUpload(): Promise<void> {
    const path = this.uploadPath;
    if (!path) return;

    try {
      const resp = await this.sftp.removeFile(path);
      const type = resp[0];
      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          this.sendDebug(`SFTP incomplete upload cleanup failed: ${status.message}`);
        }
      }
    } catch (e) {
      this.sendDebug('SFTP incomplete upload cleanup failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // Called when CHANNEL_SUCCESS is received for the SFTP subsystem request
  async onSubsystemReady(): Promise<void> {
    const initPacket = this.sftp.buildInit();
    if (this.debugEnabled) this.sendDebug(`[SFTP] onSubsystemReady: initLen=${initPacket.length}`);

    const versionPromise = this.sftp.waitForVersion();

    if (this.debugEnabled) this.sendDebug(`[SFTP] Sending init packet...`);
    this.channelDataSend(initPacket);

    try {
      if (this.debugEnabled) this.sendDebug(`[SFTP] Waiting for version...`);
      await versionPromise;
      if (!this.ready) {
        this.ready = true;
        if (this.debugEnabled) this.sendDebug(`[SFTP] Version OK`);
        this.sendJSON({ type: 'sftp_ready' });
      }
    } catch (e) {
      this.sendError('init', 'SFTP 版本协商失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // Called when CHANNEL_DATA is received for the SFTP channel
  onChannelData(data: Uint8Array): void {
    if (this.debugEnabled) this.sendDebug(`[SFTP] onChannelData: len=${data.length}`);
    this.sftp.feed(data);
    this.sftp.processReceivedPackets();
  }

  onChannelEof(): void {
    this.ready = false;
    this.sendJSON({ type: 'sftp_closed', message: 'SFTP 通道已关闭' });
  }

  onChannelClosed(): void {
    this.ready = false;
    this.sendJSON({ type: 'sftp_closed', message: 'SFTP 通道已关闭' });
  }

  onWindowAdjust(): void {
    void this.flushSFTPSendQueue();
  }

  // List directory
  async listDirectory(path: string): Promise<void> {
    if (!this.ready) {
      this.sendError('list', 'SFTP 未就绪');
      return;
    }

    try {
      if (this.debugEnabled) this.sendDebug(`[SFTP] listDirectory: path="${path}"`);

      // Handle ~ as home directory - use realpath(".") to get current dir
      let resolvePath = path;
      if (path === '~' || path === '~/') {
        resolvePath = '.';
        if (this.debugEnabled) this.sendDebug(`[SFTP] ~ detected, using "." to get home dir`);
      }

      // Resolve absolute path first
      const realPathResp = await this.sftp.realpath(resolvePath);
      const realPathType = realPathResp[0];
      let resolvedPath = path;
      if (realPathType === SSH_FXP_NAME) {
        const entries = this.sftp.parseNameResponse(realPathResp);
        if (this.debugEnabled) this.sendDebug(`[SFTP] realpath entries: ${JSON.stringify(entries.map(e => e.filename))}`);
        if (entries.length > 0) {
          resolvedPath = entries[0].filename;
          if (this.debugEnabled) this.sendDebug(`[SFTP] resolved path: "${resolvedPath}"`);
        }
      } else if (realPathType === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(realPathResp);
        if (this.debugEnabled) this.sendDebug(`[SFTP] realpath failed: code=${status.code}, msg=${status.message}`);
      }

      // Open directory
      const openResp = await this.sftp.openDir(resolvedPath);
      const openType = openResp[0];

      if (openType === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(openResp);
        this.sendError('list', status.message);
        return;
      }

      if (openType !== SSH_FXP_HANDLE) {
        this.sendError('list', '打开目录失败');
        return;
      }

      const handle = this.sftp.parseHandleResponse(openResp);
      let entries: SFTPFileEntry[];
      let isTruncated = false;
      try {
        const result = await this.sftp.listAllEntries(handle, 2000); // 限制最多2000项
        entries = result.entries;
        isTruncated = result.isTruncated;
      } finally {
        await this.sftp.closeHandle(handle).catch(() => {});
      }

      // Format and send results
      const formatted = entries
        .filter(e => e.filename !== '.' && e.filename !== '..')
        .map(e => this.formatEntry(e));

      this.sendJSON({
        type: 'sftp_list_result',
        path: resolvedPath,
        entries: formatted,
        isTruncated,
      });
    } catch (e) {
      this.sendError('list', '列出目录失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // Stat a file
  async stat(path: string): Promise<void> {
    if (!this.ready) {
      this.sendError('stat', 'SFTP 未就绪');
      return;
    }

    try {
      const resp = await this.sftp.stat(path);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        this.sendError('stat', status.message);
        return;
      }

      if (type === SSH_FXP_ATTRS) {
        const attrs = this.sftp.parseAttrsResponse(resp);
        this.sendJSON({ type: 'sftp_stat_result', path, attrs: this.formatAttrs(attrs) });
      }
    } catch (e) {
      this.sendError('stat', '获取文件信息失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // Download a file
  async downloadFile(path: string): Promise<void> {
    if (!this.ready) {
      this.sendError('download', 'SFTP 未就绪');
      return;
    }

    this.downloadCancelled = false;

    try {
      // Get file size first
      const statResp = await this.sftp.stat(path);
      const statType = statResp[0];
      let fileSize = 0;
      if (statType === SSH_FXP_ATTRS) {
        const attrs = this.sftp.parseAttrsResponse(statResp);
        fileSize = attrs.size || 0;
      }

      if (fileSize > MAX_SFTP_FILE_SIZE) {
        this.sendError('download', `文件过大 (${formatFileSize(fileSize)})，最大支持 ${formatFileSize(MAX_SFTP_FILE_SIZE)}`);
        return;
      }

      this.throwIfDownloadCancelled();

      // Open file for reading
      const openResp = await this.sftp.openFile(path, SSH_FXF_READ);
      const openType = openResp[0];

      if (openType === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(openResp);
        this.sendError('download', status.message);
        return;
      }

      if (openType !== SSH_FXP_HANDLE) {
        this.sendError('download', '打开文件失败');
        return;
      }

      const handle = this.sftp.parseHandleResponse(openResp);
      const filename = path.split('/').pop() || path;
      this.throwIfDownloadCancelled();

      // Notify frontend download started
      this.sendJSON({ type: 'sftp_download_start', filename, size: fileSize });

      let offset = 0;
      try {
        offset = fileSize > 0
          ? await this.downloadKnownSize(handle, fileSize)
          : await this.downloadUntilEOF(handle);
      } finally {
        await this.sftp.closeHandle(handle).catch(() => {});
      }

      this.throwIfDownloadCancelled();

      // Notify frontend download complete
      this.sendJSON({ type: 'sftp_download_done', filename, size: offset });
    } catch (e) {
      if (this.downloadCancelled) {
        this.sendJSON({ type: 'sftp_download_cancelled' });
        return;
      }
      this.sendError('download', '下载文件失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      this.downloadCancelled = false;
    }
  }

  private async downloadKnownSize(handle: Uint8Array, fileSize: number): Promise<number> {
    let nextReadOffset = 0;
    let nextSendOffset = 0;
    let loaded = 0;
    let chunksSinceProgress = 0;
    const inFlight = new Map<number, { length: number; promise: Promise<Uint8Array> }>();

    const scheduleReads = (): void => {
      while (!this.downloadCancelled && inFlight.size < DOWNLOAD_CONCURRENCY && nextReadOffset < fileSize) {
        const length = Math.min(DOWNLOAD_CHUNK_SIZE, fileSize - nextReadOffset);
        const offset = nextReadOffset;
        inFlight.set(offset, {
          length,
          promise: this.readBlock(handle, offset, length),
        });
        nextReadOffset += length;
      }
    };

    scheduleReads();

    try {
      while (inFlight.size > 0) {
        this.throwIfDownloadCancelled();
        const current = inFlight.get(nextSendOffset);
        if (!current) break;

        const chunkData = await current.promise;
        inFlight.delete(nextSendOffset);
        this.throwIfDownloadCancelled();

        if (chunkData.length > 0) {
          this.sendBinary(chunkData);
          loaded += chunkData.length;
          chunksSinceProgress++;
          if (chunksSinceProgress >= DOWNLOAD_PROGRESS_CHUNKS || loaded >= fileSize) {
            this.sendJSON({ type: 'sftp_download_progress', loaded, total: fileSize });
            chunksSinceProgress = 0;
          }
        }

        nextSendOffset += current.length;
        scheduleReads();
      }
    } catch (error) {
      await Promise.allSettled(Array.from(inFlight.values(), ({ promise }) => promise));
      throw error;
    }

    if (chunksSinceProgress > 0) {
      this.sendJSON({ type: 'sftp_download_progress', loaded, total: fileSize });
    }
    return loaded;
  }

  private async downloadUntilEOF(handle: Uint8Array): Promise<number> {
    let offset = 0;
    while (true) {
      this.throwIfDownloadCancelled();
      const chunkData = await this.readBlock(handle, offset, DOWNLOAD_CHUNK_SIZE);
      this.throwIfDownloadCancelled();
      if (chunkData.length === 0) break;

      this.sendBinary(chunkData);
      offset += chunkData.length;
    }

    return offset;
  }

  cancelDownload(): void {
    this.downloadCancelled = true;
  }

  private throwIfDownloadCancelled(): void {
    if (this.downloadCancelled) {
      throw new Error('Download cancelled');
    }
  }

  private async readBlock(handle: Uint8Array, offset: number, length: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (loaded < length) {
      this.throwIfDownloadCancelled();
      const readResp = await this.sftp.readFile(handle, offset + loaded, length - loaded);
      this.throwIfDownloadCancelled();
      const readType = readResp[0];

      if (readType === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(readResp);
        if (status.code === SSH_FX_EOF) break;
        throw new Error(status.message);
      }

      if (readType !== SSH_FXP_DATA) {
        throw new Error('读取文件失败');
      }

      const chunkData = this.sftp.parseDataResponse(readResp);
      if (chunkData.length === 0) break;

      chunks.push(chunkData);
      loaded += chunkData.length;
    }

    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];

    const block = new Uint8Array(loaded);
    let writeOffset = 0;
    for (const chunk of chunks) {
      block.set(chunk, writeOffset);
      writeOffset += chunk.length;
    }
    return block;
  }

  // Start file upload
  async uploadStart(path: string, totalSize: number): Promise<void> {
    if (!this.ready) {
      this.sendError('upload', 'SFTP 未就绪');
      return;
    }

    if (totalSize > MAX_SFTP_FILE_SIZE) {
      this.sendError('upload', `文件过大 (${formatFileSize(totalSize)})，最大支持 ${formatFileSize(MAX_SFTP_FILE_SIZE)}`);
      return;
    }

    try {
      this.resetUploadState();
      this.uploadPath = path;
      this.uploadTotalSize = totalSize;

      const openResp = await this.sftp.openFile(path, SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_TRUNC);
      const openType = openResp[0];

      if (openType === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(openResp);
        this.sendError('upload', status.message);
        this.uploadHandle = null;
        return;
      }

      if (openType !== SSH_FXP_HANDLE) {
        this.sendError('upload', '创建文件失败');
        this.uploadHandle = null;
        return;
      }

      this.uploadHandle = this.sftp.parseHandleResponse(openResp);
      this.sendJSON({ type: 'sftp_upload_ready', path });
    } catch (e) {
      this.sendError('upload', '创建文件失败: ' + (e instanceof Error ? e.message : String(e)));
      this.uploadHandle = null;
    }
  }

  // Handle upload chunk (binary data from frontend)
  async onUploadChunk(data: Uint8Array): Promise<void> {
    if (!this.uploadHandle) {
      this.sendError('upload', '上传未初始化');
      return;
    }

    if (this.uploadError) {
      throw this.uploadError;
    }

    const handle = this.uploadHandle;
    const writeOffset = this.uploadOffset;
    this.uploadOffset += data.length;

    const writePromise = (async () => {
      const resp = await this.sftp.writeFile(handle, writeOffset, data);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          throw new Error(status.message);
        }
      }

      this.uploadBytesWritten += data.length;
      this.uploadChunksSinceProgress++;

      if (
        this.uploadTotalSize > 0 &&
        (this.uploadChunksSinceProgress >= UPLOAD_PROGRESS_CHUNKS || this.uploadBytesWritten >= this.uploadTotalSize)
      ) {
        this.sendJSON({
          type: 'sftp_upload_progress',
          loaded: this.uploadBytesWritten,
          total: this.uploadTotalSize,
        });
        this.uploadChunksSinceProgress = 0;
      }
    })();

    await this.trackUploadWrite(writePromise);
  }

  // Finish upload
  async uploadEnd(): Promise<void> {
    await this.drainUploadWrites();

    const error = this.uploadError;

    await this.closeUploadHandle();

    if (error) {
      await this.removeIncompleteUpload();
      this.sendError('upload', '上传失败: ' + error.message);
    } else {
      if (this.uploadTotalSize > 0 && this.uploadChunksSinceProgress > 0) {
        this.sendJSON({
          type: 'sftp_upload_progress',
          loaded: this.uploadBytesWritten,
          total: this.uploadTotalSize,
        });
      }
      this.sendJSON({
        type: 'sftp_upload_complete',
        path: this.uploadPath,
        size: this.uploadBytesWritten,
      });
    }

    this.resetUploadState();
  }

  // Cancel upload
  async uploadCancel(): Promise<void> {
    try {
      await this.drainUploadWrites();
      await this.closeUploadHandle();
      await this.removeIncompleteUpload();
    } catch (e) {
      this.sendDebug('SFTP uploadCancel cleanup error: ' + (e instanceof Error ? e.message : String(e)));
    }

    this.resetUploadState();

    this.sendJSON({ type: 'sftp_upload_cancelled' });
  }

  // Delete file
  async deletePath(path: string): Promise<void> {
    if (!this.ready) {
      this.sendError('delete', 'SFTP 未就绪');
      return;
    }

    try {
      const resp = await this.sftp.removeFile(path);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          this.sendError('delete', status.message);
          return;
        }
      }

      this.sendJSON({ type: 'sftp_delete_result', path, success: true });
    } catch (e) {
      this.sendError('delete', '删除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // Rename
  async renamePath(oldPath: string, newPath: string): Promise<void> {
    if (!this.ready) {
      this.sendError('rename', 'SFTP 未就绪');
      return;
    }

    try {
      const resp = await this.sftp.rename(oldPath, newPath);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          this.sendError('rename', status.message);
          return;
        }
      }

      this.sendJSON({ type: 'sftp_rename_result', oldPath, newPath, success: true });
    } catch (e) {
      this.sendError('rename', '重命名失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // Create directory
  async makeDirectory(path: string): Promise<void> {
    if (!this.ready) {
      this.sendError('mkdir', 'SFTP 未就绪');
      return;
    }

    try {
      const resp = await this.sftp.mkdir(path);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          this.sendError('mkdir', status.message);
          return;
        }
      }

      this.sendJSON({ type: 'sftp_mkdir_result', path, success: true });
    } catch (e) {
      this.sendError('mkdir', '创建目录失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // Remove directory
  async removeDirectory(path: string): Promise<void> {
    if (!this.ready) {
      this.sendError('rmdir', 'SFTP 未就绪');
      return;
    }

    try {
      const resp = await this.sftp.rmdir(path);
      const type = resp[0];

      if (type === SSH_FXP_STATUS) {
        const status = this.sftp.parseStatusResponse(resp);
        if (status.code !== SSH_FX_OK) {
          this.sendError('rmdir', status.message);
          return;
        }
      }

      this.sendJSON({ type: 'sftp_rmdir_result', path, success: true });
    } catch (e) {
      this.sendError('rmdir', '删除目录失败: ' + (e instanceof Error ? e.message : String(e)));
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
    };
  }
}
