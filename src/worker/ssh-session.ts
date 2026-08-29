import {
  getCipherSpec,
  getMacAlgorithmsForCipher,
  getMacSpec,
  isCurve25519KEXAlgorithm,
  KEX_ALGORITHM_ECDH_NISTP256,
} from '../ssh/algorithms';
import { SSHAuth } from '../ssh/auth';
import { type ChannelDataChunk, SSHChannel } from '../ssh/channel';
import { SSHAESCTRCipher, SSHAESGCMCipher, SSHHMAC } from '../ssh/crypto';
import {
  filterExtInfo,
  KEXInitBuilder,
  negotiate,
  parseKEXInit,
  parseServerSigAlgs,
} from '../ssh/kex';
import { Curve25519KeyExchange, type Curve25519KeyPair } from '../ssh/kex-curve25519';
import { ECDHKeyExchange } from '../ssh/kex-ecdh';
import { KeyDerivation } from '../ssh/keys';
import { nextSequenceNumber, SSHPacketBuilder, SSHPacketParser } from '../ssh/packet';
import { SSHTransport } from '../ssh/transport';
import type { Env } from '../types';
import {
  normalizeTerminalSize,
  SESSION_RING_BUFFER_MAX_BYTES,
  type SessionKeys,
  type SSHSessionPolicy,
  SSH_MSG_CHANNEL_CLOSE,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_EOF,
  SSH_MSG_CHANNEL_EXTENDED_DATA,
  SSH_MSG_CHANNEL_FAILURE,
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION,
  SSH_MSG_CHANNEL_OPEN_FAILURE,
  SSH_MSG_CHANNEL_REQUEST,
  SSH_MSG_CHANNEL_SUCCESS,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_DEBUG,
  SSH_MSG_DISCONNECT,
  SSH_MSG_EXT_INFO,
  SSH_MSG_GLOBAL_REQUEST,
  SSH_MSG_IGNORE,
  SSH_MSG_KEX_ECDH_REPLY,
  SSH_MSG_KEXINIT,
  SSH_MSG_NEWKEYS,
  SSH_MSG_REQUEST_FAILURE,
  SSH_MSG_REQUEST_SUCCESS,
  SSH_MSG_SERVICE_ACCEPT,
  SSH_MSG_SERVICE_REQUEST,
  SSH_MSG_UNIMPLEMENTED,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_USERAUTH_INFO_REQUEST,
  SSH_MSG_USERAUTH_SUCCESS,
  type SSHConnectionConfig,
  type SSHPacket,
  type TerminalSize,
} from '../types';
import { AgentCore } from './agent/core';
import { AgentExecChannel } from './agent/exec-channel';
import { TerminalContext } from './agent/terminal-context';
import { DirectTcpipStream } from './direct-tcpip-stream';
import { DETECT_OS_COMMAND, isDetectedOS, parseDetectedOS } from './os-detect';
import { SFTPHandler } from './sftp-handler';

const LOCAL_WINDOW_ADJUST_THRESHOLD = 512 * 1024;
const KEEPALIVE_REQUEST_NAME = new TextEncoder().encode('keepalive@openssh.com');
const AUTH_CHALLENGE_ACK_TIMEOUT_MS = 10 * 1000;
const AUTH_CHALLENGE_RESPONSE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_KEYBOARD_INTERACTIVE_ROUNDS = 8;
const MAX_PARTIAL_AUTHENTICATION_STAGES = 8;
// Keep every JSON audit event safely below ShareDO's request-size ceiling even
// when the terminal output consists entirely of four-byte Unicode characters.
const SHARE_AUDIT_FLUSH_CHARS = 8 * 1024;
const SHARE_AUDIT_FLUSH_MS = 1000;
// Socket 写超时（write deadline）：弱网 TCP 半开时 write() 可能永不 settle，
// 超时即关闭底层 socket 会拒绝所有 pending 写，读循环随之走正常 close() 流程。
const SOCKET_WRITE_TIMEOUT_MS = 15_000;
// 被动存活看门狗：只依据最后入站数据时间戳（不依赖可能挂死的写路径），
// 链路死亡时可靠地终结僵尸会话。keepalive 每 25s 触发一次服务器应答，
// 60s 宽限 > 2 个 keepalive 周期，正常会话不会误杀。
const IDLE_WATCHDOG_CHECK_MS = 10_000;
const IDLE_WATCHDOG_GRACE_MS = 60_000;
// 浏览器→服务器终端输入队列上限：浏览器卡死时防止 channelDataQueue 无界堆积。
const MAX_INPUT_QUEUE_BYTES = 4 * 1024 * 1024;

type ActiveAuthMethod = 'none' | 'password' | 'publickey' | 'keyboard-interactive';

interface PendingAuthChallenge {
  id: string;
  prompts: Array<{ text: string; echo: boolean }>;
  phase: 'awaiting_ack' | 'awaiting_response';
  timeout: ReturnType<typeof setTimeout>;
}

export interface SSHSessionOptions {
  /** Tunnel hops authenticate without allocating a PTY, Shell, SFTP, or Agent. */
  openShellOnAuth?: boolean;
  /** Only the final nested session owns the browser WebSocket lifecycle. */
  ownsWebSocket?: boolean;
  /** Share routes disable interactive prompts on every jump hop as well as the target. */
  allowKeyboardInteractive?: boolean;
  /** Keeps final audit writes alive after a WebSocket/SSH close event returns. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export class SSHSession {
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder();
  private ws: WebSocket;
  private sftpWs: WebSocket | null = null;
  private socket: any;
  private config: SSHConnectionConfig;
  private strictHostKeyVerify: boolean;
  private sftpAttachUrl?: string;

  private transport: SSHTransport;
  private packetParser: SSHPacketParser;
  private channels: Map<number, SSHChannel> = new Map();
  private shellChannel: SSHChannel;
  private nextChannelID: number = 1; // Start from 1, shellChannel uses 0
  private sftpHandler: SFTPHandler | null = null;
  private sftpTaskQueue: Promise<void> = Promise.resolve();
  private encryptCipher: SSHAESGCMCipher | SSHAESCTRCipher | null = null;
  private decryptCipher: SSHAESGCMCipher | SSHAESCTRCipher | null = null;
  private encryptMac: SSHHMAC | null = null;
  private decryptMac: SSHHMAC | null = null;
  private derivedKeys: SessionKeys | null = null;

  private seqNumSend: number = 0;
  private sessionID: Uint8Array | null = null;
  private socketWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private sendMutex: Promise<void> = Promise.resolve();
  private channelDataQueue: Uint8Array[] = [];
  private channelDataQueueHead: number = 0;
  private channelDataQueueOffset: number = 0;
  private channelDataQueueBytes: number = 0;
  private channelDataFlushInProgress: boolean = false;

  private kexInitLocal: Uint8Array | null = null;
  private kexInitRemote: Uint8Array | null = null;

  private negotiatedKexAlgorithm: string | null = null;
  private ecdhKeyPair: CryptoKeyPair | null = null;
  private curve25519KeyPair: Curve25519KeyPair | null = null;
  private kexRawPublicKey: Uint8Array | null = null;

  /**
   * 服务端通过 SSH_MSG_EXT_INFO 公告的 server-sig-algs 列表（RFC 8332）。
   * 客户端公钥认证时据此选择 RSA 签名算法。为空数组表示未收到（含不支持 ext-info 的旧服务器）。
   */
  private serverSigAlgs: string[] = [];

  /** 当前认证方式用于区分 msg 60 在 publickey/password/RFC 4256 中的不同语义。 */
  private activeAuthMethod: ActiveAuthMethod | null = null;
  private attemptedAuthMethods: Set<ActiveAuthMethod> = new Set();
  private keyboardInteractiveRounds: number = 0;
  private partialAuthenticationStages: number = 0;
  private pendingAuthChallenge: PendingAuthChallenge | null = null;

  private state:
    | 'connecting'
    | 'version'
    | 'kex'
    | 'auth'
    | 'tunnel-ready'
    | 'shell'
    | 'shell-requested'
    | 'ready' = 'connecting';
  private hostKeyFingerprint: string = '';
  private hostKeyType: string = 'unknown';

  private versionRawBuffer: Uint8Array = new Uint8Array(0);
  private negotiatedCipherC2S: string = 'aes128-gcm@openssh.com';
  private negotiatedCipherS2C: string = 'aes128-gcm@openssh.com';
  private negotiatedMacC2S: string = 'none';
  private negotiatedMacS2C: string = 'none';

  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  private keepaliveFailCount: number = 0;
  private readonly maxKeepaliveFails: number = 3;
  private keepalivePending: boolean = false;
  private keepaliveTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastPacketAt: number = Date.now();
  private idleWatchdogInterval: ReturnType<typeof setInterval> | null = null;
  private shellReadyTimeout: ReturnType<typeof setTimeout> | null = null;
  private terminalSize: TerminalSize = { cols: 120, rows: 40 };
  private debugMode: boolean = false;

  // Agent integration
  private terminalContext: TerminalContext = new TerminalContext();
  private agentCore: AgentCore | null = null;
  private activeExecChannels: Map<number, AgentExecChannel> = new Map();
  private directTcpipStreams: Map<number, DirectTcpipStream> = new Map();
  private pendingDirectTcpip: Map<
    number,
    {
      resolve: (stream: DirectTcpipStream) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  private channelWindowWaiters: Map<number, Array<() => void>> = new Map();
  private confirmationResolve: ((approved: boolean) => void) | null = null;
  private env: Env | null = null;
  private userId: string | null = null;
  private githubId: string | null = null;
  private osDetectInProgress: boolean = false;
  private readonly auditTextDecoder = new TextDecoder();
  private shareAuditBuffer = '';
  private shareAuditFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private shareAuditWrite: Promise<boolean> = Promise.resolve(true);
  private shareAuditStarted = false;
  private shareAuditClosed = false;
  private shareSessionExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private shareExpiryWarningTimer: ReturnType<typeof setTimeout> | null = null;
  private sftpAuditContext = new Map<string, Record<string, unknown>>();
  private readonly openShellOnAuth: boolean;
  private readonly ownsWebSocket: boolean;
  private readonly allowKeyboardInteractive: boolean;
  private readonly waitUntil?: (promise: Promise<unknown>) => void;
  private authenticatedResolve!: () => void;
  private authenticatedReject!: (error: Error) => void;
  private readonly authenticatedPromise: Promise<void>;
  private authenticatedSettled = false;
  private closed = false;
  private detached: boolean = false;
  private detachedOutputBuffer: Uint8Array[] = [];
  private detachedBufferBytes: number = 0;
  private unadjustedDetachedBytes: number = 0;
  private static readonly MAX_DETACHED_BUFFER_BYTES = SESSION_RING_BUFFER_MAX_BYTES;

  constructor(
    ws: WebSocket,
    socket: any,
    config: SSHConnectionConfig,
    strictHostKeyVerify: boolean = true,
    debugMode: boolean = false,
    sftpAttachUrl?: string,
    env?: Env,
    userId?: string,
    githubId?: string,
    options: SSHSessionOptions = {}
  ) {
    this.ws = ws;
    this.socket = socket;
    this.config = config;
    this.strictHostKeyVerify = strictHostKeyVerify;
    this.debugMode = debugMode;
    this.sftpAttachUrl = sftpAttachUrl;
    this.env = env || null;
    this.userId = userId || null;
    this.githubId = githubId || null;
    this.openShellOnAuth = options.openShellOnAuth !== false;
    this.ownsWebSocket = options.ownsWebSocket !== false;
    this.allowKeyboardInteractive = options.allowKeyboardInteractive !== false;
    this.waitUntil = options.waitUntil;
    this.authenticatedPromise = new Promise<void>((resolve, reject) => {
      this.authenticatedResolve = resolve;
      this.authenticatedReject = reject;
    });
    void this.authenticatedPromise.catch(() => {});

    this.transport = new SSHTransport();
    this.packetParser = new SSHPacketParser();
    this.shellChannel = new SSHChannel();
    this.channels.set(0, this.shellChannel);
    this.updateTerminalSize(config.cols, config.rows);
  }

  async startHandshake(): Promise<void> {
    this.sendStatus('正在交换版本信息...', 'version_exchange');
    this.sendSFTPAttachUrl();
    this.state = 'version';

    await this.writeSocket(this.textEncoder.encode('SSH-2.0-CloudSSH_1.0\r\n'));

    this.startReading();
  }

  waitUntilAuthenticated(): Promise<void> {
    return this.authenticatedPromise;
  }

  belongsToShare(shareId: string): boolean {
    return (
      this.config.sessionPolicy?.source === 'share' && this.config.sessionPolicy.shareId === shareId
    );
  }

  /** Open an RFC 4254 direct-tcpip byte stream through an authenticated hop. */
  async openDirectTcpip(host: string, port: number): Promise<DirectTcpipStream> {
    if (this.state !== 'tunnel-ready') {
      throw new Error('SSH jump host is not ready for TCP forwarding');
    }
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid direct-tcpip destination');
    }

    const channelID = this.nextChannelID++;
    const channel = new SSHChannel();
    this.channels.set(channelID, channel);

    const stream = new DirectTcpipStream(
      (data) => this.sendDirectTcpipData(channelID, channel, data),
      () => this.closeDirectTcpipChannel(channelID, channel),
      (bytes) => this.queueLocalWindowAdjust(bytes, channel)
    );
    this.directTcpipStreams.set(channelID, stream);

    const opened = new Promise<DirectTcpipStream>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDirectTcpip.delete(channelID);
        this.directTcpipStreams.delete(channelID);
        this.channels.delete(channelID);
        stream.remoteClose(new Error('direct-tcpip channel open timed out'));
        reject(new Error('跳板服务器建立目标转发通道超时'));
      }, 15_000);
      this.pendingDirectTcpip.set(channelID, { resolve, reject, timeout });
    });

    try {
      await this.sendEncrypted(channel.buildOpenDirectTcpip(channelID, host, port));
    } catch (error) {
      const pending = this.pendingDirectTcpip.get(channelID);
      if (pending) clearTimeout(pending.timeout);
      this.pendingDirectTcpip.delete(channelID);
      this.directTcpipStreams.delete(channelID);
      this.channels.delete(channelID);
      stream.remoteClose(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    return opened;
  }

  attachSFTPWebSocket(ws: WebSocket): void {
    if (this.sftpWs && this.sftpWs !== ws) {
      try {
        this.sftpWs.close(1000, 'Replaced by new SFTP WebSocket');
      } catch (e) {
        this.sendDebug(() => `Close old SFTP ws: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.sftpWs = ws;
    try {
      ws.send(JSON.stringify({ type: 'sftp_socket_ready' }));
    } catch (e) {
      this.sendDebug(() => `Send sftp_socket_ready failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  detachSFTPWebSocket(ws: WebSocket, closeChannel: boolean = true): void {
    if (this.sftpWs === ws) {
      this.sftpWs = null;
      if (closeChannel) {
        this.closeSFTPChannel();
      }
    }
  }

  private async startReading(): Promise<void> {
    const reader = this.socket.readable.getReader();

    let leftover: Uint8Array | null = null;

    try {
      while (true) {
        let value: Uint8Array;
        if (leftover) {
          value = leftover;
          leftover = null;
        } else {
          const result = await reader.read();
          if (result.done) {
            this.sendError('SSH 服务器断开连接 (Socket closed by remote)', 'remote_closed');
            this.close();
            break;
          }
          value = result.value;
        }

        // 被动存活看门狗：任何入站数据都刷新最后活动时间戳（与写路径解耦）
        this.lastPacketAt = Date.now();

        if (this.state === 'version') {
          const merged = new Uint8Array(this.versionRawBuffer.length + value.length);
          merged.set(this.versionRawBuffer);
          merged.set(value, this.versionRawBuffer.length);
          this.versionRawBuffer = merged;

          let scanOffset = 0;
          let versionFound = false;
          let remaining: Uint8Array = new Uint8Array(0);

          while (scanOffset < this.versionRawBuffer.length) {
            let lfIndex = -1;
            for (let i = scanOffset; i < this.versionRawBuffer.length; i++) {
              if (this.versionRawBuffer[i] === 0x0a) {
                lfIndex = i;
                break;
              }
            }

            if (lfIndex === -1) {
              break;
            }

            const lineBytes = this.versionRawBuffer.subarray(scanOffset, lfIndex + 1);
            scanOffset = lfIndex + 1;

            let lineStr = this.textDecoder.decode(lineBytes);
            if (lineStr.endsWith('\n')) lineStr = lineStr.slice(0, -1);
            if (lineStr.endsWith('\r')) lineStr = lineStr.slice(0, -1);

            if (lineStr.startsWith('SSH-')) {
              this.transport.handleVersionExchange(`${lineStr}\r\n`);
              remaining = this.versionRawBuffer.subarray(scanOffset);
              versionFound = true;
              break;
            } else {
            }
          }

          if (versionFound) {
            this.versionRawBuffer = new Uint8Array(0);
            this.sendStatus('版本交换完成，正在密钥协商...', 'version_ready');
            this.state = 'kex';
            await this.startKEX();

            if (remaining.length > 0) {
              this.packetParser.feed(remaining);
              await this.processPackets();
            }
          } else if (scanOffset > 0) {
            this.versionRawBuffer = this.versionRawBuffer.subarray(scanOffset);
          }
        } else {
          this.packetParser.feed(value);
          await this.processPackets();
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      try {
        this.ws.send(JSON.stringify({ type: 'error', message: `SSH 连接异常: ${errMsg}` }));
      } catch (e) {
        this.sendDebug(() => `Send error to client failed: ${e instanceof Error ? e.message : e}`);
      }
      this.close();
    }
  }

  private async startKEX(): Promise<void> {
    this.kexInitLocal = KEXInitBuilder.build();

    const packet = await SSHPacketBuilder.build(this.kexInitLocal, 8, null, this.seqNumSend);
    this.seqNumSend = nextSequenceNumber(this.seqNumSend);
    await this.writeSocket(packet);
  }

  private async sendKEXECDHInit(): Promise<void> {
    if (!this.negotiatedKexAlgorithm) {
      throw new Error('KEX algorithm not negotiated');
    }

    let kexInit: Uint8Array;
    if (isCurve25519KEXAlgorithm(this.negotiatedKexAlgorithm)) {
      this.curve25519KeyPair = await Curve25519KeyExchange.generateKeyPair();
      this.ecdhKeyPair = null;
      this.kexRawPublicKey = await Curve25519KeyExchange.exportRawPublicKey(this.curve25519KeyPair);
      kexInit = Curve25519KeyExchange.buildInit(this.kexRawPublicKey);
    } else if (this.negotiatedKexAlgorithm === KEX_ALGORITHM_ECDH_NISTP256) {
      this.ecdhKeyPair = await ECDHKeyExchange.generateKeyPair();
      this.curve25519KeyPair = null;
      this.kexRawPublicKey = await ECDHKeyExchange.exportRawPublicKey(this.ecdhKeyPair);
      kexInit = ECDHKeyExchange.buildInit(this.kexRawPublicKey);
    } else {
      throw new Error(`Unsupported KEX algorithm: ${this.negotiatedKexAlgorithm}`);
    }

    const packet = await SSHPacketBuilder.build(kexInit, 8, null, this.seqNumSend);
    this.seqNumSend = nextSequenceNumber(this.seqNumSend);
    await this.writeSocket(packet);
  }

  /**
   * write deadline：弱网 TCP 半开时底层 write 可能永不 settle，导致 sendMutex
   * 链条整体卡死（keepalive、窗口调整、Agent 通道关闭全部失效）。
   * 超时即关闭底层 socket —— pending 写会立刻被拒绝，读循环收到关闭事件后
   * 走正常 close() 流程，会话不会僵死。
   */
  private async writeSocket(data: Uint8Array): Promise<void> {
    if (!this.socketWriter) {
      this.socketWriter = this.socket.writable.getWriter();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.socketWriter!.write(data),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.sendDebug('Socket write timeout — closing TCP socket');
            try {
              this.socket.close();
            } catch {
              /* socket already closed */
            }
            reject(new Error('Socket write timeout'));
          }, SOCKET_WRITE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async buildEncryptedPacket(payload: Uint8Array): Promise<Uint8Array> {
    if (!this.encryptCipher) {
      throw new Error('Encryption not initialized');
    }

    const cipher = getCipherSpec(this.negotiatedCipherC2S);
    const packet = await SSHPacketBuilder.build(
      payload,
      cipher.blockSize,
      (data, seq, aad) => this.encryptCipher!.encrypt(data, seq, aad),
      this.seqNumSend,
      cipher.aead,
      this.encryptMac ? (packetData, seq) => this.encryptMac!.sign(packetData, seq) : undefined
    );
    this.seqNumSend = nextSequenceNumber(this.seqNumSend);
    return packet;
  }

  private async buildEncryptedChannelDataPacket(
    chunk: ChannelDataChunk,
    channel: SSHChannel
  ): Promise<Uint8Array> {
    if (!this.encryptCipher) {
      throw new Error('Encryption not initialized');
    }

    const cipher = getCipherSpec(this.negotiatedCipherC2S);
    const packet = await SSHPacketBuilder.buildWithPayloadWriter(
      chunk.payloadLength,
      (packet, offset) =>
        channel.writeChannelDataPayload(
          packet,
          offset,
          chunk.source,
          chunk.sourceOffset,
          chunk.bytesConsumed
        ),
      cipher.blockSize,
      (data, seq, aad) => this.encryptCipher!.encrypt(data, seq, aad),
      this.seqNumSend,
      cipher.aead,
      this.encryptMac ? (packetData, seq) => this.encryptMac!.sign(packetData, seq) : undefined
    );
    this.seqNumSend = nextSequenceNumber(this.seqNumSend);
    return packet;
  }

  private async processPackets(): Promise<void> {
    while (true) {
      // Encryption state changes after handling SSH_MSG_NEWKEYS
      // (handlePacket -> enableEncryption). The first encrypted packet can
      // arrive in the same read chunk as NEWKEYS, so these parameters MUST be
      // recomputed for every packet. If they go stale, the ciphertext's first
      // bytes are misread as packet_length, e.g. "Packet length 965473881
      // exceeds maximum allowed size 262144".
      const cipher = this.decryptCipher ? getCipherSpec(this.negotiatedCipherS2C) : null;
      const blockSize = cipher ? cipher.blockSize : 8;
      const hasAuthTag = !!cipher?.aead;
      const macLength =
        this.decryptCipher && !hasAuthTag ? getMacSpec(this.negotiatedMacS2C).length : 0;
      const hasDecrypt = !!this.decryptCipher;
      this.sendDebug(
        () =>
          `processPackets: blockSize=${blockSize}, hasDecrypt=${hasDecrypt}, bufferLen=${this.packetParser.getBufferLength()}`
      );

      try {
        const packet = await this.packetParser.nextPacket(
          blockSize,
          this.decryptCipher
            ? (data, seq, aad, commit) => this.decryptCipher!.decrypt(data, seq, aad, commit)
            : (data) => data,
          hasAuthTag,
          macLength,
          this.decryptMac
            ? (packet, mac, seq) => this.decryptMac!.verify(packet, seq, mac)
            : undefined
        );

        if (!packet) {
          this.sendDebug(
            () => `No more packets, buffer remaining: ${this.packetParser.getBufferLength()}`
          );
          break;
        }

        this.sendDebug(
          () =>
            `Received msgType=${packet.payload[0]}, state=${this.state}, payloadLen=${packet.payload.length}`
        );
        await this.handlePacket(packet);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this.sendDebug(`processPackets ERROR: ${errMsg}`);
        this.sendError(`数据包处理异常: ${errMsg}`, 'packet_error', { message: errMsg });
        this.close();
        return;
      }
    }
  }

  private async handlePacket(packet: SSHPacket): Promise<void> {
    const msgType = packet.payload[0];

    // Transport-level messages handled regardless of state
    if (msgType === SSH_MSG_DISCONNECT) {
      this.sendStatus('服务器断开连接', 'remote_closed');
      this.close(true);
      return;
    }
    if (
      msgType === SSH_MSG_IGNORE ||
      msgType === SSH_MSG_DEBUG ||
      msgType === SSH_MSG_UNIMPLEMENTED
    ) {
      return;
    }
    if (msgType === SSH_MSG_GLOBAL_REQUEST) {
      await this.handleGlobalRequest(packet.payload);
      return;
    }
    if (msgType === SSH_MSG_REQUEST_SUCCESS || msgType === SSH_MSG_REQUEST_FAILURE) {
      // Response to our global request (e.g., keepalive)
      this.keepalivePending = false;
      this.keepaliveFailCount = 0;
      if (this.keepaliveTimeout) {
        clearTimeout(this.keepaliveTimeout);
        this.keepaliveTimeout = null;
      }
      return;
    }

    switch (this.state) {
      case 'kex':
        await this.handleKEXPacket(msgType, packet.payload);
        break;

      case 'auth':
        await this.handleAuthPacket(msgType, packet.payload);
        break;

      case 'shell':
      case 'shell-requested':
      case 'tunnel-ready':
      case 'ready':
        await this.handleSessionPacket(msgType, packet.payload);
        break;
    }
  }

  private async handleGlobalRequest(payload: Uint8Array): Promise<void> {
    // SSH_MSG_GLOBAL_REQUEST format:
    //   byte      SSH_MSG_GLOBAL_REQUEST (80)
    //   string    request_name
    //   boolean   want_reply
    //   ...       request-specific data
    let offset = 1;
    const nameLen =
      (payload[offset] << 24) |
      (payload[offset + 1] << 16) |
      (payload[offset + 2] << 8) |
      payload[offset + 3];
    offset += 4;
    const requestName = this.textDecoder.decode(payload.subarray(offset, offset + nameLen));
    offset += nameLen;
    const wantReply = payload[offset] !== 0;

    this.sendDebug(`Global request: ${requestName}, wantReply=${wantReply}`);

    if (requestName === 'keepalive@openssh.com') {
      if (wantReply) {
        const reply = new Uint8Array([SSH_MSG_REQUEST_SUCCESS]);
        await this.sendEncrypted(reply);
      }
      return;
    }

    if (wantReply) {
      const reply = new Uint8Array([SSH_MSG_REQUEST_FAILURE]);
      await this.sendEncrypted(reply);
    }
  }

  private startKeepalive(): void {
    this.keepaliveFailCount = 0;
    this.keepalivePending = false;
    this.startIdleWatchdog();
    this.keepaliveInterval = setInterval(async () => {
      if (this.keepalivePending) {
        this.keepaliveFailCount++;
        this.sendDebug(`Keepalive timeout (${this.keepaliveFailCount}/${this.maxKeepaliveFails})`);
        if (this.keepaliveFailCount >= this.maxKeepaliveFails) {
          this.sendError('SSH 连接超时，保活失败', 'keepalive_timeout');
          this.close();
          return;
        }
      }

      try {
        const payload = new Uint8Array(1 + 4 + KEEPALIVE_REQUEST_NAME.length + 1);
        payload[0] = SSH_MSG_GLOBAL_REQUEST;
        new DataView(payload.buffer).setUint32(1, KEEPALIVE_REQUEST_NAME.length, false);
        payload.set(KEEPALIVE_REQUEST_NAME, 5);
        payload[5 + KEEPALIVE_REQUEST_NAME.length] = 1; // want_reply = true

        await this.sendEncrypted(payload);
        this.keepalivePending = true;

        if (this.keepaliveTimeout) clearTimeout(this.keepaliveTimeout);
        this.keepaliveTimeout = setTimeout(() => {
          if (this.keepalivePending) {
            this.keepaliveFailCount++;
            this.sendDebug(
              `Keepalive response timeout (${this.keepaliveFailCount}/${this.maxKeepaliveFails})`
            );
            this.keepalivePending = false;
            if (this.keepaliveFailCount >= this.maxKeepaliveFails) {
              this.sendError('SSH 连接超时，保活失败', 'keepalive_timeout');
              this.close();
            }
          }
        }, 10000);
      } catch (e) {
        this.keepaliveFailCount++;
        this.sendDebug(
          `Keepalive send failed (${this.keepaliveFailCount}/${this.maxKeepaliveFails}): ${e instanceof Error ? e.message : String(e)}`
        );
        if (this.keepaliveFailCount >= this.maxKeepaliveFails) {
          this.sendError('SSH 连接超时，保活失败', 'keepalive_timeout');
          this.close();
        }
      }
    }, 25000);
  }

  /**
   * 被动存活看门狗：只依赖 startReading 维护的 lastPacketAt，完全不经过写路径 ——
   * 主动 keepalive 会因 sendMutex 卡死而先于会话失效，此计时器独立工作，
   * 在宽限期后可靠地终结僵尸会话，避免其耗尽 DO 资源。
   */
  private startIdleWatchdog(): void {
    if (this.idleWatchdogInterval) return;
    this.lastPacketAt = Date.now();
    this.idleWatchdogInterval = setInterval(() => {
      if (Date.now() - this.lastPacketAt > IDLE_WATCHDOG_GRACE_MS) {
        this.sendError('SSH 连接无响应，已自动断开（空闲超时）', 'idle_timeout');
        this.close();
      }
    }, IDLE_WATCHDOG_CHECK_MS);
  }

  private async handleKEXPacket(msgType: number, payload: Uint8Array): Promise<void> {
    this.sendDebug(`handleKEXPacket: msgType=${msgType}`);
    switch (msgType) {
      case SSH_MSG_KEXINIT: {
        this.kexInitRemote = payload;
        this.sendDebug('Received KEXINIT from server');
        try {
          const serverKex = parseKEXInit(payload);
          const clientKex = parseKEXInit(this.kexInitLocal!);

          // 检测服务端是否发了 ext-info-s（表示服务器将在 NEWKEYS 后发 SSH_MSG_EXT_INFO）
          const serverSentExtInfo = serverKex.kexAlgorithms.includes('ext-info-s');
          this.sendDebug(`Server ext-info-s: ${serverSentExtInfo}`);

          // 过滤掉 ext-info-* 伪算法后再做真正的 KEX algorithm 协商
          this.negotiatedKexAlgorithm = negotiate(
            filterExtInfo(clientKex.kexAlgorithms),
            filterExtInfo(serverKex.kexAlgorithms),
            'KEX algorithm'
          );
          this.negotiatedCipherC2S = negotiate(
            clientKex.encryptionC2S,
            serverKex.encryptionC2S,
            'C2S cipher'
          );
          this.negotiatedCipherS2C = negotiate(
            clientKex.encryptionS2C,
            serverKex.encryptionS2C,
            'S2C cipher'
          );
          this.negotiatedMacC2S = getCipherSpec(this.negotiatedCipherC2S).aead
            ? 'none'
            : negotiate(
                getMacAlgorithmsForCipher(this.negotiatedCipherC2S),
                serverKex.macC2S,
                'C2S MAC'
              );
          this.negotiatedMacS2C = getCipherSpec(this.negotiatedCipherS2C).aead
            ? 'none'
            : negotiate(
                getMacAlgorithmsForCipher(this.negotiatedCipherS2C),
                serverKex.macS2C,
                'S2C MAC'
              );
          this.sendDebug(
            `Negotiated KEX: ${this.negotiatedKexAlgorithm}, C2S: ${this.negotiatedCipherC2S}/${this.negotiatedMacC2S}, S2C: ${this.negotiatedCipherS2C}/${this.negotiatedMacS2C}`
          );
          await this.sendKEXECDHInit();
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          this.sendError(`算法协商失败: ${errMsg}`, 'algorithm_error', { message: errMsg });
          this.close();
        }
        break;
      }

      case SSH_MSG_KEX_ECDH_REPLY:
        this.sendDebug('Received ECDH_REPLY');
        await this.handleECDHReply(payload);
        break;

      case SSH_MSG_NEWKEYS: {
        this.sendDebug(`Received NEWKEYS, seqNumSend=${this.seqNumSend}`);
        const newKeys = new Uint8Array([SSH_MSG_NEWKEYS]);
        const packet = await SSHPacketBuilder.build(newKeys, 8, null, this.seqNumSend);
        this.seqNumSend = nextSequenceNumber(this.seqNumSend);
        await this.writeSocket(packet);
        this.sendDebug(`Client NEWKEYS sent, seqNumSend=${this.seqNumSend}`);

        await this.enableEncryption();
        this.sendDebug('Encryption enabled');

        this.state = 'auth';
        try {
          await this.sendServiceRequest();
          this.sendDebug('SERVICE_REQUEST sent successfully');
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          this.sendDebug(`SERVICE_REQUEST failed: ${errMsg}`);
          this.sendError(`SERVICE_REQUEST 失败: ${errMsg}`, 'service_error', { message: errMsg });
          this.close();
        }
        break;
      }

      case SSH_MSG_UNIMPLEMENTED:
        this.sendDebug('Server sent UNIMPLEMENTED');
        break;

      default:
        this.sendDebug(`Unexpected msgType=${msgType} in kex state`);
        break;
    }
  }

  private async handleECDHReply(payload: Uint8Array): Promise<void> {
    this.sendDebug('Parsing ECDH_REPLY...');
    const { hostKey, serverRawPublicKey, signature } = ECDHKeyExchange.parseReply(payload);
    this.sendDebug(
      `ECDH_REPLY parsed: hostKey=${hostKey.length}, serverPubKey=${serverRawPublicKey.length}, sig=${signature.length}`
    );

    if (!this.negotiatedKexAlgorithm || !this.kexRawPublicKey) {
      throw new Error('KEX reply received before KEX init was sent');
    }

    let sharedSecret: Uint8Array;
    if (isCurve25519KEXAlgorithm(this.negotiatedKexAlgorithm)) {
      if (!this.curve25519KeyPair) {
        throw new Error('Curve25519 key pair not initialized');
      }
      sharedSecret = await Curve25519KeyExchange.computeSharedSecret(
        this.curve25519KeyPair.privateKey,
        serverRawPublicKey
      );
    } else if (this.negotiatedKexAlgorithm === KEX_ALGORITHM_ECDH_NISTP256) {
      if (!this.ecdhKeyPair) {
        throw new Error('ECDH key pair not initialized');
      }
      sharedSecret = await ECDHKeyExchange.computeSharedSecret(
        this.ecdhKeyPair.privateKey,
        serverRawPublicKey
      );
    } else {
      throw new Error(`Unsupported KEX algorithm: ${this.negotiatedKexAlgorithm}`);
    }
    this.sendDebug(`Shared secret: ${sharedSecret.length} bytes`);

    const H = isCurve25519KEXAlgorithm(this.negotiatedKexAlgorithm)
      ? await Curve25519KeyExchange.computeExchangeHash(
          this.transport.getLocalVersion(),
          this.transport.getRemoteVersion(),
          this.kexInitLocal!,
          this.kexInitRemote!,
          hostKey,
          this.kexRawPublicKey,
          serverRawPublicKey,
          sharedSecret
        )
      : await ECDHKeyExchange.computeExchangeHash(
          this.transport.getLocalVersion(),
          this.transport.getRemoteVersion(),
          this.kexInitLocal!,
          this.kexInitRemote!,
          hostKey,
          this.kexRawPublicKey,
          serverRawPublicKey,
          sharedSecret
        );
    const hHex = Array.from(H)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    this.sendDebug(`Exchange hash H=${hHex}`);

    // Extract host key algorithm type from the blob
    try {
      const ktLen = (hostKey[0] << 24) | (hostKey[1] << 16) | (hostKey[2] << 8) | hostKey[3];
      this.hostKeyType = this.textDecoder.decode(hostKey.subarray(4, 4 + ktLen));
    } catch {
      this.hostKeyType = 'unknown';
    }

    // Compute host key fingerprint (SHA-256)
    const fpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', hostKey));
    this.hostKeyFingerprint = `SHA256:${btoa(String.fromCharCode(...fpHash)).replace(/=+$/, '')}`;
    this.sendDebug(`Host key fingerprint: ${this.hostKeyFingerprint} (${this.hostKeyType})`);

    // Verify possession of the presented host key before comparing or persisting its fingerprint.
    let sigVerified: boolean | null = false;
    try {
      sigVerified = await this.verifyHostKeySignature(hostKey, signature, H);
      if (sigVerified === null) {
        this.sendDebug('Host key signature verification: UNSUPPORTED ALGORITHM');
        if (this.strictHostKeyVerify) {
          this.sendError('主机密钥签名验证失败：不支持的密钥算法', 'host_key_unsupported');
          this.close();
          return;
        }
        this.sendStatus('主机密钥签名验证被跳过（暂不支持该算法）', 'host_key_verify_skipped');
      } else {
        this.sendDebug(`Host key signature verification: ${sigVerified ? 'PASS' : 'FAIL'}`);
        if (!sigVerified) {
          if (this.strictHostKeyVerify) {
            this.sendError(
              '主机密钥签名验证失败，连接被阻断。如需跳过，请设置 STRICT_HOST_KEY_VERIFY=false',
              'host_key_signature_blocked'
            );
            this.close();
            return;
          }
          this.sendError(
            '主机密钥签名验证失败 - 可能会有安全风险，但不阻断连接（严格模式已关闭）',
            'host_key_signature_risk'
          );
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.sendDebug(`Signature verification error: ${errMsg}`);
      if (this.strictHostKeyVerify) {
        this.sendError(`主机密钥签名验证异常: ${errMsg}`, 'host_key_signature_error', {
          message: errMsg,
        });
        this.close();
        return;
      }
    }

    if (!this.finalizeHostKeyTrust(sigVerified === true)) return;

    if (!this.sessionID) {
      this.sessionID = H;
      this.sendDebug('Session ID set');
    }

    const cipherC2S = getCipherSpec(this.negotiatedCipherC2S);
    const cipherS2C = getCipherSpec(this.negotiatedCipherS2C);
    const macC2S = getMacSpec(this.negotiatedMacC2S);
    const macS2C = getMacSpec(this.negotiatedMacS2C);

    this.derivedKeys = await KeyDerivation.deriveKeys(
      sharedSecret,
      H,
      this.sessionID!,
      cipherC2S.ivLength,
      cipherS2C.ivLength,
      macC2S.keyLength,
      macS2C.keyLength
    );
    this.sendDebug('Keys derived, waiting for NEWKEYS');
  }

  /**
   * 完成 TOFU 判定。只有服务器已证明持有当前主机私钥时，才允许浏览器记录或替换指纹。
   */
  private finalizeHostKeyTrust(signatureVerified: boolean): boolean {
    const expectedFingerprint = this.config.expectedFingerprint;
    const host = this.config.knownHostIdentity || this.config.host;
    const commonMessage = {
      fingerprint: this.hostKeyFingerprint,
      keyType: this.hostKeyType,
      host,
      port: this.config.port,
      displayHost: this.config.host,
    };

    if (expectedFingerprint && expectedFingerprint !== this.hostKeyFingerprint) {
      const mayReplaceHostKey = this.config.sessionPolicy?.allowHostKeyMutation !== false;
      if (signatureVerified && mayReplaceHostKey) {
        try {
          this.ws.send(
            JSON.stringify({
              type: 'host_key_changed',
              ...commonMessage,
              expectedFingerprint,
            })
          );
        } catch {
          /* WebSocket 已关闭 */
        }
      }
      this.sendError('主机密钥指纹变更！请确认是否为预期行为。', 'host_key_changed');
      this.sendError(`已知指纹: ${expectedFingerprint}`, 'host_key_known', {
        fingerprint: expectedFingerprint,
      });
      this.sendError(
        `实际指纹: ${this.hostKeyFingerprint} (${this.hostKeyType})`,
        'host_key_actual',
        {
          fingerprint: this.hostKeyFingerprint,
          keyType: this.hostKeyType,
        }
      );
      let trustInstruction: string;
      let trustEvent: string;
      if (signatureVerified && mayReplaceHostKey) {
        trustInstruction = '连接已阻断。请在确认对话框中核对并决定是否信任新指纹。';
        trustEvent = 'host_key_trust_instruction';
      } else if (signatureVerified) {
        trustInstruction = '连接已阻断。分享会话不允许替换所有者已信任的主机指纹。';
        trustEvent = 'host_key_share_change_blocked';
      } else {
        trustInstruction = '连接已阻断，且主机密钥签名未通过验证，无法信任新指纹。';
        trustEvent = 'host_key_unverified_instruction';
      }
      this.sendError(trustInstruction, trustEvent);
      this.close(true);
      return false;
    }

    if (expectedFingerprint) {
      if (signatureVerified) {
        this.sendStatus(`主机密钥验证通过 (${this.hostKeyType}) ✓`, 'host_key_accepted');
      } else {
        this.sendStatus(
          `已知主机指纹匹配 (${this.hostKeyType})，但签名未验证`,
          'host_key_fingerprint_matched_unverified',
          { keyType: this.hostKeyType }
        );
      }
      return true;
    }

    if (!signatureVerified) {
      this.sendStatus(
        `服务器指纹: ${this.hostKeyFingerprint} (${this.hostKeyType})（签名未验证，未记录）`,
        'host_key_not_saved',
        { fingerprint: this.hostKeyFingerprint, keyType: this.hostKeyType }
      );
      return true;
    }

    try {
      this.ws.send(
        JSON.stringify({
          type: 'host_key_verified',
          ...commonMessage,
          firstSeen: true,
        })
      );
    } catch {
      /* WebSocket 已关闭 */
    }
    this.sendStatus(
      `服务器指纹: ${this.hostKeyFingerprint} (${this.hostKeyType})（首次连接，验证通过）`,
      'host_key_first_seen',
      { fingerprint: this.hostKeyFingerprint, keyType: this.hostKeyType }
    );
    return true;
  }

  private async verifyHostKeySignature(
    hostKeyBlob: Uint8Array,
    signatureBlob: Uint8Array,
    exchangeHash: Uint8Array
  ): Promise<boolean | null> {
    // Parse host key blob to get key type and raw key
    let offset = 0;
    const keyTypeLen =
      (hostKeyBlob[offset] << 24) |
      (hostKeyBlob[offset + 1] << 16) |
      (hostKeyBlob[offset + 2] << 8) |
      hostKeyBlob[offset + 3];
    offset += 4;
    const keyType = this.textDecoder.decode(hostKeyBlob.subarray(offset, offset + keyTypeLen));
    offset += keyTypeLen;
    this.sendDebug(`Host key type: ${keyType}`);

    // Parse signature blob to get sig type and raw sig
    let sigOffset = 0;
    const sigTypeLen =
      (signatureBlob[sigOffset] << 24) |
      (signatureBlob[sigOffset + 1] << 16) |
      (signatureBlob[sigOffset + 2] << 8) |
      signatureBlob[sigOffset + 3];
    sigOffset += 4;
    const sigType = this.textDecoder.decode(
      signatureBlob.subarray(sigOffset, sigOffset + sigTypeLen)
    );
    sigOffset += sigTypeLen;
    const rawSigLen =
      (signatureBlob[sigOffset] << 24) |
      (signatureBlob[sigOffset + 1] << 16) |
      (signatureBlob[sigOffset + 2] << 8) |
      signatureBlob[sigOffset + 3];
    sigOffset += 4;
    const rawSig = signatureBlob.subarray(sigOffset, sigOffset + rawSigLen);
    this.sendDebug(`Signature type: ${sigType}, raw sig len: ${rawSig.length}`);

    if (keyType === 'ssh-ed25519') {
      const rawKeyLen =
        (hostKeyBlob[offset] << 24) |
        (hostKeyBlob[offset + 1] << 16) |
        (hostKeyBlob[offset + 2] << 8) |
        hostKeyBlob[offset + 3];
      offset += 4;
      const rawKey = hostKeyBlob.subarray(offset, offset + rawKeyLen);
      this.sendDebug(`Ed25519 public key: ${rawKey.length} bytes`);

      const pubKey = await crypto.subtle.importKey('raw', rawKey, { name: 'Ed25519' }, false, [
        'verify',
      ]);

      return await crypto.subtle.verify('Ed25519', pubKey, rawSig, exchangeHash);
    } else if (
      keyType === 'ecdsa-sha2-nistp256' ||
      keyType === 'ecdsa-sha2-nistp384' ||
      keyType === 'ecdsa-sha2-nistp521'
    ) {
      // RFC 5656: ECDSA 主机密钥按曲线 exhaustive 支持
      let namedCurve: string;
      let hash: 'SHA-256' | 'SHA-384' | 'SHA-512';
      let coordBytes: number;
      switch (keyType) {
        case 'ecdsa-sha2-nistp256':
          namedCurve = 'P-256';
          hash = 'SHA-256';
          coordBytes = 32;
          break;
        case 'ecdsa-sha2-nistp384':
          namedCurve = 'P-384';
          hash = 'SHA-384';
          coordBytes = 48;
          break;
        case 'ecdsa-sha2-nistp521':
          namedCurve = 'P-521';
          hash = 'SHA-512';
          coordBytes = 66;
          break;
        default:
          throw new Error(`unsupported ECDSA host key: ${keyType}`);
      }

      // Parse ECDSA key blob: string(curve), string(point)
      const curveLen =
        (hostKeyBlob[offset] << 24) |
        (hostKeyBlob[offset + 1] << 16) |
        (hostKeyBlob[offset + 2] << 8) |
        hostKeyBlob[offset + 3];
      offset += 4 + curveLen;
      const rawKeyLen =
        (hostKeyBlob[offset] << 24) |
        (hostKeyBlob[offset + 1] << 16) |
        (hostKeyBlob[offset + 2] << 8) |
        hostKeyBlob[offset + 3];
      offset += 4;
      const rawKey = hostKeyBlob.subarray(offset, offset + rawKeyLen);
      this.sendDebug(`ECDSA public key: ${rawKey.length} bytes, curve=${namedCurve}`);

      const pubKey = await crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'ECDSA', namedCurve },
        false,
        ['verify']
      );

      // Convert SSH (r||s) signature to raw r||s for Web Crypto（按曲线坐标长度 pad）
      const ecdsaRawSig = this.convertSSHECDSASig(rawSig, coordBytes);
      this.sendDebug(`ECDSA raw sig: ${ecdsaRawSig.length} bytes`);

      return await crypto.subtle.verify({ name: 'ECDSA', hash }, pubKey, ecdsaRawSig, exchangeHash);
    } else if (keyType === 'ssh-rsa') {
      // Parse RSA key
      const eLen =
        (hostKeyBlob[offset] << 24) |
        (hostKeyBlob[offset + 1] << 16) |
        (hostKeyBlob[offset + 2] << 8) |
        hostKeyBlob[offset + 3];
      offset += 4;
      const eRaw = hostKeyBlob.subarray(offset, offset + eLen);
      offset += eLen;

      const nLen =
        (hostKeyBlob[offset] << 24) |
        (hostKeyBlob[offset + 1] << 16) |
        (hostKeyBlob[offset + 2] << 8) |
        hostKeyBlob[offset + 3];
      offset += 4;
      const nRaw = hostKeyBlob.subarray(offset, offset + nLen);

      // Determine hash algorithm based on signature type (RFC 8332)
      let hashAlgo: 'SHA-256' | 'SHA-512' | 'SHA-1';
      if (sigType === 'rsa-sha2-256') hashAlgo = 'SHA-256';
      else if (sigType === 'rsa-sha2-512') hashAlgo = 'SHA-512';
      else if (sigType === 'ssh-rsa') hashAlgo = 'SHA-1';
      else {
        this.sendDebug(`Unknown RSA signature type: ${sigType}`);
        return false;
      }

      this.sendDebug(
        `RSA public key: n=${nRaw.length} bytes, e=${eRaw.length} bytes, sigType=${sigType}, hash=${hashAlgo}`
      );

      // Convert to JWK format for import
      const jwk = {
        kty: 'RSA',
        e: this.base64UrlEncodeUnsigned(eRaw),
        n: this.base64UrlEncodeUnsigned(nRaw),
        ext: true,
      };

      try {
        const pubKey = await crypto.subtle.importKey(
          'jwk',
          jwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: hashAlgo },
          false,
          ['verify']
        );

        return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pubKey, rawSig, exchangeHash);
      } catch (e) {
        this.sendDebug(`RSA import/verify error: ${e}`);
        return false;
      }
    }

    this.sendDebug(`Unsupported key type for verification: ${keyType}`);
    return null; // Return null for unsupported algorithms instead of failing
  }

  // Convert Uint8Array to base64url string without leading zero bytes (useful for JWK mpint)
  private base64UrlEncodeUnsigned(buffer: Uint8Array): string {
    let start = 0;
    while (start < buffer.length - 1 && buffer[start] === 0x00) {
      start++;
    }
    let binary = '';
    for (let i = start; i < buffer.length; i++) {
      binary += String.fromCharCode(buffer[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private convertSSHECDSASig(sshSig: Uint8Array, coordBytes: number = 32): Uint8Array {
    // SSH ECDSA sig is: string r, string s (each mpint)
    let offset = 0;
    const rLen =
      (sshSig[offset] << 24) |
      (sshSig[offset + 1] << 16) |
      (sshSig[offset + 2] << 8) |
      sshSig[offset + 3];
    offset += 4;
    let r = sshSig.subarray(offset, offset + rLen);
    offset += rLen;
    const sLen =
      (sshSig[offset] << 24) |
      (sshSig[offset + 1] << 16) |
      (sshSig[offset + 2] << 8) |
      sshSig[offset + 3];
    offset += 4;
    let s = sshSig.subarray(offset, offset + sLen);

    // Strip leading zero bytes (mpint sign extension)
    if (r.length > coordBytes && r[0] === 0) r = r.subarray(1);
    if (s.length > coordBytes && s[0] === 0) s = s.subarray(1);

    // Pad to coordBytes each (P-256=32, P-384=48, P-521=66)
    const result = new Uint8Array(coordBytes * 2);
    result.set(r, coordBytes - r.length);
    result.set(s, coordBytes * 2 - s.length);
    return result;
  }

  private async enableEncryption(): Promise<void> {
    const keys = this.derivedKeys!;
    const cipherC2S = getCipherSpec(this.negotiatedCipherC2S);
    const cipherS2C = getCipherSpec(this.negotiatedCipherS2C);
    const encKeyC2S = keys.encKeyClientToServer.subarray(0, cipherC2S.keyLength);
    const encKeyS2C = keys.encKeyServerToClient.subarray(0, cipherS2C.keyLength);

    this.sendDebug('Initializing ciphers');

    if (cipherC2S.mode === 'gcm') {
      this.encryptCipher = new SSHAESGCMCipher(encKeyC2S, keys.ivClientToServer);
      this.encryptMac = null;
    } else {
      this.encryptCipher = new SSHAESCTRCipher(encKeyC2S, keys.ivClientToServer);
      this.encryptMac =
        this.negotiatedMacC2S === 'none'
          ? null
          : new SSHHMAC(this.negotiatedMacC2S, keys.integrityKeyC2S);
    }
    await this.encryptCipher.init();
    if (this.encryptMac) await this.encryptMac.init();

    if (cipherS2C.mode === 'gcm') {
      this.decryptCipher = new SSHAESGCMCipher(encKeyS2C, keys.ivServerToClient);
      this.decryptMac = null;
    } else {
      this.decryptCipher = new SSHAESCTRCipher(encKeyS2C, keys.ivServerToClient);
      this.decryptMac =
        this.negotiatedMacS2C === 'none'
          ? null
          : new SSHHMAC(this.negotiatedMacS2C, keys.integrityKeyS2C);
    }
    await this.decryptCipher.init();
    if (this.decryptMac) await this.decryptMac.init();

    this.sendDebug('Ciphers initialized');
  }

  private async sendServiceRequest(): Promise<void> {
    const serviceName = 'ssh-userauth';
    const nameBytes = this.textEncoder.encode(serviceName);
    const serviceRequest = new Uint8Array(1 + 4 + nameBytes.length);
    serviceRequest[0] = SSH_MSG_SERVICE_REQUEST;
    new DataView(serviceRequest.buffer).setUint32(1, nameBytes.length, false);
    serviceRequest.set(nameBytes, 5);

    const packet = await this.buildEncryptedPacket(serviceRequest);
    await this.writeSocket(packet);
  }

  private async authenticate(): Promise<void> {
    // RFC 4252 §5.2: ask the server which methods may continue before
    // sending a password or signature. This avoids wasting a credential
    // attempt on hosts such as Serv00 that expose password verification only
    // through keyboard-interactive.
    this.activeAuthMethod = 'none';
    this.attemptedAuthMethods.add('none');
    await this.sendEncrypted(SSHAuth.buildNoneAuthRequest(this.config.username));
  }

  private canUseAuthMethod(method: ActiveAuthMethod): boolean {
    switch (method) {
      case 'none':
        return true;
      case 'publickey':
        return (
          this.config.authMethod === 'publickey' &&
          Boolean(this.config.privateKey && this.sessionID)
        );
      case 'password':
        return this.config.authMethod !== 'publickey' && Boolean(this.config.password);
      case 'keyboard-interactive':
        // 分享会话不能把所有者保存的密码交由接收者决定如何响应远端挑战。
        return this.allowKeyboardInteractive && this.config.sessionPolicy?.source !== 'share';
    }
  }

  private async authenticateWithMethod(method: ActiveAuthMethod): Promise<boolean> {
    if (this.attemptedAuthMethods.has(method) || !this.canUseAuthMethod(method)) {
      return false;
    }

    let authRequest: Uint8Array;
    switch (method) {
      case 'none':
        authRequest = SSHAuth.buildNoneAuthRequest(this.config.username);
        break;
      case 'publickey':
        this.sendStatus('正在使用密钥认证...', 'auth_public_key');
        authRequest = await SSHAuth.buildPublicKeyAuthRequest(
          this.config.username,
          this.config.privateKey!,
          this.sessionID!,
          this.serverSigAlgs,
          false
        );
        break;
      case 'password':
        authRequest = SSHAuth.buildPasswordAuthRequest(this.config.username, this.config.password);
        break;
      case 'keyboard-interactive':
        this.clearPendingAuthChallenge();
        this.sendStatus('服务器要求交互式认证', 'auth_interactive_required');
        authRequest = SSHAuth.buildKeyboardInteractiveAuthRequest(this.config.username);
        break;
    }

    this.activeAuthMethod = method;
    this.attemptedAuthMethods.add(method);
    await this.sendEncrypted(authRequest);
    return true;
  }

  private selectNextAuthMethod(
    allowedMethods: string[],
    previousMethod: ActiveAuthMethod | null
  ): ActiveAuthMethod | null {
    const configuredFirst: ActiveAuthMethod[] =
      this.config.authMethod === 'publickey'
        ? ['publickey', 'keyboard-interactive']
        : ['password', 'keyboard-interactive'];
    // RFC 4252 allows a server to omit the list in a failure response. Keep
    // compatibility with such servers after the harmless "none" probe by
    // falling back to the user's configured primary method.
    const effectiveAllowedMethods =
      previousMethod === 'none' && allowedMethods.length === 0 ? configuredFirst : allowedMethods;
    const candidates = configuredFirst.filter(
      (method) =>
        effectiveAllowedMethods.includes(method) &&
        !this.attemptedAuthMethods.has(method) &&
        this.canUseAuthMethod(method)
    );

    return candidates.find((method) => method !== previousMethod) ?? candidates[0] ?? null;
  }

  private failAuthentication(message?: string, event?: string, normalClose: boolean = false): void {
    const wasInteractive = this.activeAuthMethod === 'keyboard-interactive';
    this.clearPendingAuthChallenge();
    this.activeAuthMethod = null;
    this.sendError(
      message ??
        (wasInteractive
          ? '交互式认证失败：服务器拒绝了响应'
          : '认证失败：用户名、凭据或交互式响应无效'),
      event ?? (wasInteractive ? 'auth_interactive_failed' : 'auth_failed')
    );
    this.close(normalClose);
  }

  private clearPendingAuthChallenge(): void {
    if (!this.pendingAuthChallenge) return;
    clearTimeout(this.pendingAuthChallenge.timeout);
    this.pendingAuthChallenge = null;
  }

  private async handleKeyboardInteractiveInfoRequest(payload: Uint8Array): Promise<void> {
    if (this.activeAuthMethod !== 'keyboard-interactive') {
      this.failAuthentication(
        '服务器发送了当前认证方式不支持的交互消息',
        'auth_interactive_protocol_error'
      );
      return;
    }
    if (this.pendingAuthChallenge) {
      this.failAuthentication(
        '服务器在上一轮响应前发送了新的交互式认证请求',
        'auth_interactive_protocol_error'
      );
      return;
    }
    if (this.keyboardInteractiveRounds >= MAX_KEYBOARD_INTERACTIVE_ROUNDS) {
      this.failAuthentication('交互式认证轮次过多，连接已终止', 'auth_interactive_limit');
      return;
    }

    let request: ReturnType<typeof SSHAuth.parseKeyboardInteractiveInfoRequest>;
    try {
      request = SSHAuth.parseKeyboardInteractiveInfoRequest(payload);
    } catch {
      this.failAuthentication(
        '服务器发送了无效的交互式认证请求',
        'auth_interactive_protocol_error'
      );
      return;
    }

    this.keyboardInteractiveRounds++;
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      if (this.pendingAuthChallenge?.id !== id) return;
      this.pendingAuthChallenge = null;
      this.sendError(
        '浏览器未确认显示交互式认证请求，请刷新页面后重试',
        'auth_interactive_client_unavailable'
      );
      // Authentication timeouts are expected application outcomes. A normal
      // close also prevents older frontends from reconnecting repeatedly and
      // triggering provider-side IP bans.
      this.close(true);
    }, AUTH_CHALLENGE_ACK_TIMEOUT_MS);

    this.pendingAuthChallenge = {
      id,
      prompts: request.prompts.map((prompt) => ({ ...prompt })),
      phase: 'awaiting_ack',
      timeout,
    };

    try {
      this.ws.send(
        JSON.stringify({
          type: 'auth_challenge',
          id,
          name: request.name,
          instruction: request.instruction,
          prompts: request.prompts,
          host: this.config.host,
          port: this.config.port,
          canUseStoredPassword: Boolean(
            this.config.password &&
              this.config.authMethod !== 'publickey' &&
              request.prompts.length === 1 &&
              !request.prompts[0].echo
          ),
        })
      );
    } catch {
      this.clearPendingAuthChallenge();
      this.close();
    }
  }

  private handleKeyboardInteractiveAck(message: Record<string, unknown>): void {
    if (this.state !== 'auth' || this.activeAuthMethod !== 'keyboard-interactive') return;

    const pending = this.pendingAuthChallenge;
    if (!pending || typeof message.id !== 'string' || message.id !== pending.id) {
      this.sendError('交互式认证确认已过期或不匹配', 'auth_interactive_stale');
      return;
    }
    if (pending.phase === 'awaiting_response') return;

    clearTimeout(pending.timeout);
    pending.phase = 'awaiting_response';
    const id = pending.id;
    pending.timeout = setTimeout(() => {
      if (this.pendingAuthChallenge?.id !== id) return;
      this.pendingAuthChallenge = null;
      this.sendError('等待交互式认证响应超时', 'auth_interactive_timeout');
      this.close(true);
    }, AUTH_CHALLENGE_RESPONSE_TIMEOUT_MS);
    this.sendDebug('Browser displayed the interactive authentication challenge');
  }

  private async handleKeyboardInteractiveResponse(message: Record<string, unknown>): Promise<void> {
    if (this.state !== 'auth' || this.activeAuthMethod !== 'keyboard-interactive') return;

    const pending = this.pendingAuthChallenge;
    if (!pending || typeof message.id !== 'string' || message.id !== pending.id) {
      this.sendError('交互式认证响应已过期或不匹配', 'auth_interactive_stale');
      return;
    }

    let responses: string[];
    if (message.useStoredPassword === true) {
      if (
        !this.config.password ||
        this.config.authMethod === 'publickey' ||
        pending.prompts.length !== 1 ||
        pending.prompts[0].echo ||
        Object.hasOwn(message, 'responses')
      ) {
        this.failAuthentication(
          '当前交互式认证请求不能使用已保存密码',
          'auth_interactive_invalid_response'
        );
        return;
      }
      responses = [this.config.password];
    } else {
      if (
        !Array.isArray(message.responses) ||
        message.responses.length !== pending.prompts.length ||
        !message.responses.every((response) => typeof response === 'string')
      ) {
        this.failAuthentication(
          '交互式认证响应数量或格式无效',
          'auth_interactive_invalid_response'
        );
        return;
      }
      responses = message.responses as string[];
    }

    let responsePayload: Uint8Array;
    try {
      responsePayload = SSHAuth.buildKeyboardInteractiveInfoResponse(responses);
    } catch {
      this.failAuthentication('交互式认证响应超过安全限制', 'auth_interactive_invalid_response');
      return;
    }

    this.clearPendingAuthChallenge();
    try {
      await this.sendEncrypted(responsePayload);
    } catch {
      this.sendError('发送交互式认证响应失败', 'auth_interactive_send_failed');
      this.close();
    }
  }

  private handleKeyboardInteractiveCancel(message: Record<string, unknown>): void {
    if (this.state !== 'auth' || this.activeAuthMethod !== 'keyboard-interactive') return;
    const pending = this.pendingAuthChallenge;
    if (!pending || typeof message.id !== 'string' || message.id !== pending.id) return;

    this.clearPendingAuthChallenge();
    this.activeAuthMethod = null;
    this.sendStatus('交互式认证已取消', 'auth_interactive_cancelled');
    this.close(true);
  }

  private async handleAuthPacket(msgType: number, payload: Uint8Array): Promise<void> {
    switch (msgType) {
      case SSH_MSG_EXT_INFO: {
        // RFC 8301: SSH_MSG_EXT_INFO 是 NEWKEYS 之后第一条消息。
        // 这里解析 server-sig-algs 扩展（用于 RSA-SHA2 算法协商），只接收一次。
        if (this.serverSigAlgs.length > 0) {
          this.sendDebug('Duplicate SSH_MSG_EXT_INFO ignored');
          return;
        }
        try {
          this.serverSigAlgs = parseServerSigAlgs(payload);
          this.sendDebug(`server-sig-algs: [${this.serverSigAlgs.join(',')}]`);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          this.sendDebug(`Parse SSH_MSG_EXT_INFO failed: ${errMsg}`);
          this.serverSigAlgs = [];
        }
        return;
      }

      case SSH_MSG_SERVICE_ACCEPT:
        this.sendStatus('认证服务已接受，正在认证...', 'auth_service_accepted');
        await this.authenticate();
        break;

      case SSH_MSG_USERAUTH_SUCCESS:
        this.clearPendingAuthChallenge();
        this.activeAuthMethod = null;
        this.sendStatus('认证成功', 'auth_success');
        this.startKeepalive();
        if (this.openShellOnAuth) {
          this.state = 'shell';
          this.authenticatedSettled = true;
          this.authenticatedResolve();
          await this.openShell();
        } else {
          this.state = 'tunnel-ready';
          this.authenticatedSettled = true;
          this.authenticatedResolve();
        }
        break;

      case SSH_MSG_USERAUTH_FAILURE: {
        if (this.pendingAuthChallenge) {
          this.failAuthentication(
            '服务器在等待交互式认证响应时提前结束了当前认证步骤',
            'auth_interactive_protocol_error'
          );
          break;
        }

        let allowedMethods: string[];
        let partialSuccess = false;
        try {
          const result = SSHAuth.handleResponse(payload);
          allowedMethods = result.allowedMethods ?? [];
          partialSuccess = result.partialSuccess === true;
        } catch {
          this.failAuthentication(
            '服务器发送了无效的认证失败响应',
            'auth_interactive_protocol_error'
          );
          break;
        }

        this.sendDebug(
          `Authentication failure: allowed=[${allowedMethods.join(',')}], partial=${partialSuccess}`
        );
        const previousMethod = this.activeAuthMethod;
        const configuredPrimaryMethod: ActiveAuthMethod =
          this.config.authMethod === 'publickey' ? 'publickey' : 'password';
        if (partialSuccess) {
          this.partialAuthenticationStages++;
          if (this.partialAuthenticationStages > MAX_PARTIAL_AUTHENTICATION_STAGES) {
            this.failAuthentication('多因素认证步骤过多，连接已终止', 'auth_interactive_limit');
            break;
          }
          // A partial success starts a new authentication factor. Methods that
          // failed only because the server required a different order may now
          // be attempted again (for example keyboard-interactive,publickey).
          this.attemptedAuthMethods.clear();
        } else if (
          previousMethod === configuredPrimaryMethod &&
          allowedMethods.includes(configuredPrimaryMethod)
        ) {
          // The configured credential was rejected and the server still
          // offers the same method. Do not reinterpret that rejection as an
          // interactive challenge merely because keyboard-interactive is
          // also advertised.
          this.sendDebug(`Configured authentication method rejected: ${configuredPrimaryMethod}`);
          this.failAuthentication(undefined, 'auth_failed', true);
          break;
        }

        const nextMethod = this.selectNextAuthMethod(allowedMethods, previousMethod);
        if (nextMethod && (await this.authenticateWithMethod(nextMethod))) {
          break;
        }

        // A server-side credential rejection is an expected authentication
        // outcome, not an internal WebSocket failure.
        this.failAuthentication(undefined, undefined, true);
        break;
      }

      case SSH_MSG_USERAUTH_INFO_REQUEST:
        if (this.activeAuthMethod === 'keyboard-interactive') {
          await this.handleKeyboardInteractiveInfoRequest(payload);
        } else if (this.activeAuthMethod === 'password') {
          // Message number 60 is SSH_MSG_USERAUTH_PASSWD_CHANGEREQ in the
          // password method (RFC 4252), not an RFC 4256 INFO_REQUEST.
          this.failAuthentication(
            '服务器要求更改已过期密码，当前版本暂不支持在认证期间修改密码',
            'auth_password_change_required'
          );
        } else if (this.activeAuthMethod === 'publickey') {
          // With publickey it is SSH_MSG_USERAUTH_PK_OK. CloudSSH always sends
          // the signature in its first request, so this response is unexpected.
          this.failAuthentication('服务器返回了意外的公钥认证确认', 'auth_protocol_error');
        } else {
          this.failAuthentication('服务器在认证方式探测阶段返回了意外消息', 'auth_protocol_error');
        }
        break;

      case SSH_MSG_UNIMPLEMENTED:
        break;
    }
  }

  private async openShell(): Promise<void> {
    const openMsg = this.shellChannel.buildOpenSession(0);
    await this.sendEncrypted(openMsg);
  }

  private getChannelIDFromPayload(payload: Uint8Array): number {
    // Most channel messages have recipient_channel at offset 1
    return (payload[1] << 24) | (payload[2] << 16) | (payload[3] << 8) | payload[4];
  }

  private getChannelByID(localChannelID: number): SSHChannel | undefined {
    return this.channels.get(localChannelID);
  }

  private async handleSessionPacket(msgType: number, payload: Uint8Array): Promise<void> {
    switch (msgType) {
      case SSH_MSG_CHANNEL_OPEN_CONFIRMATION: {
        const channelID = this.getChannelIDFromPayload(payload);
        const channel = this.getChannelByID(channelID);
        if (!channel) {
          this.sendDebug(`CHANNEL_OPEN_CONFIRMATION for unknown channel ${channelID}`);
          return;
        }
        channel.handleOpenConfirmation(payload);
        this.sendDebug(
          `CHANNEL_OPEN_CONFIRMATION: channelID=${channelID}, remoteChannelID=${channel.getRemoteChannelID()}, isSFTP=${this.sftpHandler && channelID === this.sftpHandler.getChannelID()}`
        );

        const directPending = this.pendingDirectTcpip.get(channelID);
        if (directPending) {
          clearTimeout(directPending.timeout);
          this.pendingDirectTcpip.delete(channelID);
          const stream = this.directTcpipStreams.get(channelID);
          if (stream) directPending.resolve(stream);
          else directPending.reject(new Error('direct-tcpip stream disappeared'));
        } else if (channel === this.shellChannel) {
          // Shell channel: send PTY request
          const ptyReq = channel.buildPTYRequest(this.terminalSize.cols, this.terminalSize.rows);
          await this.sendEncrypted(ptyReq);
        } else if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
          // SFTP channel: send subsystem request
          this.sendDebug(`SFTP channel confirmed, sending subsystem request`);
          const subsystemReq = channel.buildSubsystemRequest('sftp');
          await this.sendEncrypted(subsystemReq);
        } else {
          // Exec channel: send exec request
          const execCh = this.activeExecChannels.get(channelID);
          if (execCh) {
            execCh.onOpenConfirmation();
            this.sendDebug(`Exec channel confirmed: channelID=${channelID}`);
          }
        }
        break;
      }

      case SSH_MSG_CHANNEL_OPEN_FAILURE: {
        const channelID = this.getChannelIDFromPayload(payload);
        const reasonCode = (payload[5] << 24) | (payload[6] << 16) | (payload[7] << 8) | payload[8];
        let offset = 9;
        const descLen =
          (payload[offset] << 24) |
          (payload[offset + 1] << 16) |
          (payload[offset + 2] << 8) |
          payload[offset + 3];
        offset += 4;
        const description = this.textDecoder.decode(payload.subarray(offset, offset + descLen));

        this.channels.delete(channelID);

        const directPending = this.pendingDirectTcpip.get(channelID);
        const directStream = this.directTcpipStreams.get(channelID);
        if (directPending || directStream) {
          if (directPending) {
            clearTimeout(directPending.timeout);
            directPending.reject(
              new Error(`跳板服务器拒绝 TCP 转发：${description || `reason ${reasonCode}`}`)
            );
            this.pendingDirectTcpip.delete(channelID);
          }
          directStream?.remoteClose(
            new Error(description || `direct-tcpip rejected (${reasonCode})`)
          );
          this.directTcpipStreams.delete(channelID);
        } else if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
          // SFTP channel open failed - notify frontend, don't close terminal
          this.sendDebug(`SFTP channel open failed: reason=${reasonCode}, desc=${description}`);
          this.sendSFTPError('init', `服务器不支持 SFTP: ${description}`);
          this.sftpHandler = null;
        } else if (this.isExecChannel(channelID)) {
          // Exec channel open failed - reject just this command, keep SSH session alive
          const execCh = this.activeExecChannels.get(channelID);
          if (execCh) {
            execCh.onChannelOpenFailure(reasonCode, description);
            this.activeExecChannels.delete(channelID);
          }
          this.sendDebug(
            `Exec channel open failed: channelID=${channelID}, reason=${reasonCode}, desc=${description}`
          );
        } else {
          // Shell channel failed - close connection
          this.sendError('通道打开被拒绝', 'channel_rejected');
          this.close();
        }
        break;
      }

      case SSH_MSG_CHANNEL_SUCCESS: {
        const channelID = this.getChannelIDFromPayload(payload);
        if (channelID === this.shellChannel.getLocalChannelID() && this.state === 'shell') {
          // PTY request confirmed, send shell request
          const shellReq = this.shellChannel.buildShellRequest();
          await this.sendEncrypted(shellReq);
          this.state = 'shell-requested';
          this.shellReadyTimeout = setTimeout(async () => {
            if (this.state === 'shell-requested') {
              this.state = 'ready';
              await this.onShellReady();
            }
          }, 3000);
        } else if (
          channelID === this.shellChannel.getLocalChannelID() &&
          this.state === 'shell-requested'
        ) {
          // Shell request confirmed
          if (this.shellReadyTimeout) {
            clearTimeout(this.shellReadyTimeout);
            this.shellReadyTimeout = null;
          }
          this.state = 'ready';
          await this.onShellReady();
        } else if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
          // SFTP subsystem request confirmed - send SFTP init
          this.sendDebug(`SFTP CHANNEL_SUCCESS received, calling onSubsystemReady`);
          const handler = this.sftpHandler;
          void handler.onSubsystemReady().catch((error) => {
            const errMsg = error instanceof Error ? error.message : String(error);
            this.sendDebug(`SFTP onSubsystemReady ERROR: ${errMsg}`);
            if (this.sftpHandler === handler) {
              this.sendSFTPError('init', `SFTP 初始化失败: ${errMsg}`);
            }
          });
        } else {
          // Exec channel success — could be exec request confirmed or exit-status
          // Try to parse exit-status from payload
          const execCh = this.activeExecChannels.get(channelID);
          if (execCh) {
            this.sendDebug(`Exec channel success: channelID=${channelID}`);
          }
        }
        break;
      }

      case SSH_MSG_CHANNEL_FAILURE: {
        const channelID = this.getChannelIDFromPayload(payload);
        if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
          this.sendSFTPError('init', 'SFTP subsystem 请求被拒绝');
          this.sftpHandler.dispose();
          this.sftpHandler = null;
        } else if (this.state === 'shell' || this.state === 'shell-requested') {
          this.sendError('PTY 或 Shell 请求被拒绝', 'pty_shell_rejected');
          this.close();
        }
        break;
      }

      case SSH_MSG_CHANNEL_DATA: {
        const channelID = this.getChannelIDFromPayload(payload);
        const channel = this.getChannelByID(channelID);
        if (!channel) {
          this.sendDebug(`CHANNEL_DATA for unknown channel ${channelID}`);
          return;
        }

        const directStream = this.directTcpipStreams.get(channelID);
        if (directStream) {
          const forwardedData = channel.handleChannelData(payload);
          directStream.push(forwardedData);
        } else if (channel === this.shellChannel) {
          // Shell channel data - forward to terminal
          if (this.state === 'shell-requested') {
            if (this.shellReadyTimeout) {
              clearTimeout(this.shellReadyTimeout);
              this.shellReadyTimeout = null;
            }
            this.state = 'ready';
            await this.onShellReady();
          }
          const outputData = channel.handleChannelData(payload);
          if (this.detached) {
            this.handleDetachedTerminalOutput(outputData, channel);
          } else {
            try {
              this.ws.send(outputData);
            } catch (e) {
              this.sendDebug(
                () => `Send shell output failed: ${e instanceof Error ? e.message : e}`
              );
            }
            this.recordShareTerminalOutput(outputData);
            this.queueLocalWindowAdjust(outputData.length, channel);
          }
          // Feed terminal context for Agent
          try {
            this.terminalContext.appendOutput(this.textDecoder.decode(outputData));
          } catch {
            /* 解码/追加失败不影响主会话，静默忽略 */
          }
        } else if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
          // SFTP channel data - forward to SFTP handler
          const sftpData = channel.handleChannelData(payload);
          this.sendDebug(
            () =>
              `SFTP CHANNEL_DATA received: channelID=${channelID}, dataLen=${sftpData.length}, firstByte=${sftpData[0]}`
          );
          this.sftpHandler.onChannelData(sftpData);
          this.queueLocalWindowAdjust(sftpData.length, channel);
        } else {
          // Exec channel data (Agent)
          const execCh = this.activeExecChannels.get(channelID);
          if (execCh) {
            const execData = channel.handleChannelData(payload);
            if (execCh.onData(execData)) {
              this.queueLocalWindowAdjust(execData.length, channel);
            } else {
              // 捕获达到硬上限：停止续 window 并关闭通道，sshd 会终止远端命令
              await this.terminateExecChannelOnCaptureLimit(channelID, channel, execCh);
            }
          }
        }
        break;
      }

      case SSH_MSG_CHANNEL_EXTENDED_DATA: {
        const channelID = this.getChannelIDFromPayload(payload);
        const channel = this.getChannelByID(channelID);
        if (!channel) return;

        if (channel === this.shellChannel) {
          // stderr data from shell - forward to terminal
          let offset = 1 + 4; // skip msgType + recipient_channel
          offset += 4; // skip dataTypeCode (4 bytes, unused)
          const dataLen =
            (payload[offset] << 24) |
            (payload[offset + 1] << 16) |
            (payload[offset + 2] << 8) |
            payload[offset + 3];
          offset += 4;
          const stderrData = payload.subarray(offset, offset + dataLen);
          if (this.detached) {
            this.handleDetachedTerminalOutput(stderrData, channel);
          } else {
            try {
              this.ws.send(stderrData);
            } catch (e) {
              this.sendDebug(
                () => `Send stderr output failed: ${e instanceof Error ? e.message : e}`
              );
            }
            this.recordShareTerminalOutput(stderrData);
            this.queueLocalWindowAdjust(stderrData.length, channel);
          }
        } else {
          // Exec channel extended data (stderr for Agent)
          const execCh = this.activeExecChannels.get(channelID);
          if (execCh) {
            let offset = 1 + 4;
            offset += 4; // skip dataTypeCode
            const dataLen =
              (payload[offset] << 24) |
              (payload[offset + 1] << 16) |
              (payload[offset + 2] << 8) |
              payload[offset + 3];
            offset += 4;
            const stderrData = payload.subarray(offset, offset + dataLen);
            if (execCh.onExtendedData(stderrData)) {
              this.queueLocalWindowAdjust(stderrData.length, channel);
            } else {
              await this.terminateExecChannelOnCaptureLimit(channelID, channel, execCh);
            }
          }
        }
        break;
      }

      case SSH_MSG_CHANNEL_WINDOW_ADJUST: {
        const channelID = this.getChannelIDFromPayload(payload);
        const channel = this.getChannelByID(channelID);
        if (channel) {
          channel.handleWindowAdjust(payload);
          const waiters = this.channelWindowWaiters.get(channelID);
          if (waiters) {
            this.channelWindowWaiters.delete(channelID);
            for (const wake of waiters) wake();
          }
          if (channel === this.shellChannel) {
            void this.flushChannelDataQueue();
          } else if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
            this.sftpHandler.onWindowAdjust();
          }
        }
        break;
      }

      case SSH_MSG_CHANNEL_EOF: {
        const channelID = this.getChannelIDFromPayload(payload);
        if (channelID === this.shellChannel.getLocalChannelID()) {
          // Shell channel EOF - close connection
          this.sendStatus('会话已结束', 'session_ended');
          this.close(true);
        } else {
          // Other channel EOF
          this.sendDebug(`Non-shell channel EOF: channelID=${channelID}`);
          if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
            this.sftpHandler.onChannelEof();
            this.sftpHandler.dispose();
            this.sftpHandler = null;
            this.channels.delete(channelID);
          }
          const directStream = this.directTcpipStreams.get(channelID);
          if (directStream) {
            directStream.remoteEof();
          }
          const execCh = this.activeExecChannels.get(channelID);
          if (execCh) {
            execCh.onEof();
          }
        }
        break;
      }

      case SSH_MSG_CHANNEL_CLOSE: {
        const channelID = this.getChannelIDFromPayload(payload);
        if (channelID === this.shellChannel.getLocalChannelID()) {
          // Shell channel closed - close connection
          this.sendStatus('会话已结束', 'session_ended');
          this.close(true);
        } else {
          // Other channel closed
          this.sendDebug(`Non-shell channel closed: channelID=${channelID}`);

          // Reply CLOSE if we haven't sent it yet (RFC 4254 §5.3)
          const channel = this.channels.get(channelID);
          if (channel && !channel.isClosed()) {
            try {
              await this.sendEncrypted(channel.buildClose());
            } catch {
              // Ignore send errors during close
            }
          }

          this.channels.delete(channelID);
          const directStream = this.directTcpipStreams.get(channelID);
          if (directStream) {
            directStream.remoteClose();
            this.directTcpipStreams.delete(channelID);
            const waiters = this.channelWindowWaiters.get(channelID);
            this.channelWindowWaiters.delete(channelID);
            if (waiters) for (const wake of waiters) wake();
          }
          if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
            this.sftpHandler.onChannelClosed();
            this.sftpHandler = null;
          }
          const execCh = this.activeExecChannels.get(channelID);
          if (execCh) {
            execCh.onClose();
            this.activeExecChannels.delete(channelID);
          }
        }
        break;
      }

      case SSH_MSG_CHANNEL_REQUEST: {
        // Parse server-initiated CHANNEL_REQUEST (e.g., exit-status for exec channels)
        const reqChannelID = this.getChannelIDFromPayload(payload);
        let offset = 5; // skip msgType + channelID
        const reqTypeLen =
          (payload[offset] << 24) |
          (payload[offset + 1] << 16) |
          (payload[offset + 2] << 8) |
          payload[offset + 3];
        offset += 4;
        const reqType = this.textDecoder.decode(payload.subarray(offset, offset + reqTypeLen));
        offset += reqTypeLen;
        offset += 1; // skip want_reply

        if (reqType === 'exit-status') {
          const execCh = this.activeExecChannels.get(reqChannelID);
          if (execCh) {
            const exitCode =
              (payload[offset] << 24) |
              (payload[offset + 1] << 16) |
              (payload[offset + 2] << 8) |
              payload[offset + 3];
            execCh.onExitStatus(exitCode);
            this.sendDebug(
              `Exec channel exit-status: channelID=${reqChannelID}, exitCode=${exitCode}`
            );
          }
        } else if (reqType === 'exit-signal') {
          const execCh = this.activeExecChannels.get(reqChannelID);
          if (execCh) {
            // According to RFC 4254 §6.10, exit-signal contains: string signal name, boolean core dumped, string error message...
            // We set a non-zero exit code (e.g., 1) to represent abnormal termination, avoiding incorrect 4-byte parsing.
            execCh.onExitStatus(1);
            this.sendDebug(`Exec channel exit-signal received: channelID=${reqChannelID}`);
          }
        }
        break;
      }

      case SSH_MSG_DISCONNECT:
        this.sendStatus('服务器断开连接', 'remote_closed');
        this.close(true);
        break;

      case SSH_MSG_IGNORE:
      case SSH_MSG_DEBUG:
      case SSH_MSG_UNIMPLEMENTED:
        break;
    }
  }

  async handleWebSocketMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === 'string') {
      let parsed: any;
      // 仅对可能为 JSON 的消息尝试解析（以 { 开头），避免终端输入产生噪音日志
      if (data.charCodeAt(0) === 123) {
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          this.sendDebug(() => `JSON parse failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      if (parsed && typeof parsed === 'object') {
        if (parsed.type === 'auth_challenge_ack') {
          this.handleKeyboardInteractiveAck(parsed);
          return;
        }
        if (parsed.type === 'auth_response') {
          await this.handleKeyboardInteractiveResponse(parsed);
          return;
        }
        if (parsed.type === 'auth_cancel') {
          this.handleKeyboardInteractiveCancel(parsed);
          return;
        }
        if (parsed.type === 'ping') {
          const id =
            typeof parsed.id === 'string' && parsed.id.length <= 128 ? parsed.id : undefined;
          this.ws.send(JSON.stringify({ type: 'pong', ...(id ? { id } : {}) }));
          return;
        }
        if (parsed.type === 'resize') {
          await this.handleResize(parsed.cols, parsed.rows);
          return;
        }

        // Agent messages
        // agent_stop / agent_confirm 已由 durable-object.ts 在 webSocketMessage 入口
        // 提前拦截并通过 handleAgentControl 同步处理，不再到达此处。
        if (parsed.type === 'agent_start') {
          await this.handleAgentStart(parsed.message, parsed.user_id, parsed.locale);
          return;
        }

        // NOTE: SFTP control messages are handled over the dedicated SFTP WebSocket.
      }

      if (this.state !== 'ready') return;
      if (this.config.sessionPolicy?.source === 'share' && !this.shareAuditStarted) return;

      this.enqueueChannelData(this.textEncoder.encode(data));
    } else {
      if (this.state !== 'ready') return;
      if (this.config.sessionPolicy?.source === 'share' && !this.shareAuditStarted) return;

      this.enqueueChannelData(new Uint8Array(data));
    }
  }

  async handleSFTPWebSocketMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === 'string') {
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        this.sendSFTPError('protocol', 'Invalid SFTP message format');
        return;
      }

      if (parsed?.type === 'ping') {
        this.sendSFTPJSON({ type: 'pong' });
        return;
      }

      if (!parsed?.type || !parsed.type.startsWith('sftp_')) {
        this.sendSFTPError('protocol', 'Invalid SFTP message type');
        return;
      }

      if (parsed.type === 'sftp_download_cancel') {
        if (!(await this.auditSFTPRequest(parsed))) return;
        this.sftpHandler?.cancelDownload();
        return;
      }

      if (parsed.type === 'sftp_upload_cancel') {
        if (!(await this.auditSFTPRequest(parsed))) return;
        void this.sftpHandler?.uploadCancel();
        return;
      }

      this.enqueueSFTPTask(this.getSFTPOperation(parsed.type), () =>
        this.handleSFTPMessage(parsed)
      );
      return;
    }

    if (!this.sftpHandler) {
      this.sendSFTPError('upload', 'SFTP 未初始化，请先发送 sftp_init');
      return;
    }

    const chunk = new Uint8Array(data);
    void this.sftpHandler.onUploadChunk(chunk).catch((error) => {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.sendDebug(`SFTP upload chunk ERROR: ${errMsg}`);
    });
  }

  private async handleSFTPMessage(msg: any): Promise<void> {
    if (this.state !== 'ready') {
      this.sendSFTPError(this.getSFTPOperation(msg.type), 'SSH 连接未就绪');
      return;
    }

    if (this.config.sessionPolicy?.source === 'share' && !this.config.sessionPolicy.allowSftp) {
      this.sendSFTPError(this.getSFTPOperation(msg.type), '当前分享会话不允许使用 SFTP');
      return;
    }

    if (msg.type === 'sftp_init') {
      await this.openSFTPChannel();
      return;
    }

    if (!this.sftpHandler) {
      this.sendSFTPError(this.getSFTPOperation(msg.type), 'SFTP 未初始化，请先发送 sftp_init');
      return;
    }

    if (!(await this.auditSFTPRequest(msg))) return;

    switch (msg.type) {
      case 'sftp_list':
        await this.sftpHandler.listDirectory(msg.path || '.');
        break;
      case 'sftp_stat':
        await this.sftpHandler.stat(msg.path);
        break;
      case 'sftp_download':
        await this.sftpHandler.downloadFile(msg.path);
        break;
      case 'sftp_edit_read':
        await this.sftpHandler.editReadFile(msg.path);
        break;
      case 'sftp_download_cancel':
        this.sftpHandler.cancelDownload();
        break;
      case 'sftp_upload_start':
        await this.sftpHandler.uploadStart(msg.path, msg.size || 0, msg.overwrite === true);
        break;
      case 'sftp_upload_end':
        await this.sftpHandler.uploadEnd();
        break;
      case 'sftp_upload_cancel':
        await this.sftpHandler.uploadCancel();
        break;
      case 'sftp_delete':
        await this.sftpHandler.deletePath(msg.path);
        break;
      case 'sftp_rename':
        await this.sftpHandler.renamePath(msg.oldPath, msg.newPath);
        break;
      case 'sftp_mkdir':
        await this.sftpHandler.makeDirectory(msg.path);
        break;
      case 'sftp_rmdir':
        await this.sftpHandler.removeDirectory(msg.path);
        break;
      case 'sftp_close':
        this.closeSFTPChannel();
        break;
    }
  }

  private async openSFTPChannel(): Promise<void> {
    if (this.sftpHandler) {
      this.sendSFTPError('init', 'SFTP 已经打开');
      return;
    }

    const channelID = this.nextChannelID++;
    const sftpChannel = new SSHChannel();
    this.channels.set(channelID, sftpChannel);

    this.sftpHandler = new SFTPHandler(
      channelID,
      sftpChannel,
      (payload: Uint8Array) => {
        this.sendDebug(() => `SFTP sendEncrypted: len=${payload.length}, type=${payload[0]}`);
        return this.sendEncrypted(payload);
      },
      (msg: any) => {
        this.sendDebug(() => `SFTP sendJSON: type=${msg.type}`);
        this.auditSFTPResult(msg);
        this.sendSFTPJSON(msg);
      },
      (data: Uint8Array) => {
        this.sendDebug(() => `SFTP sendBinary: len=${data.length}`);
        this.sendSFTPBinary(data);
      },
      (message: string) => {
        this.sendDebug(message);
      },
      this.debugMode
    );

    const openMsg = sftpChannel.buildOpenSession(channelID);
    await this.sendEncrypted(openMsg);
    this.sendDebug(
      `SFTP channel open requested, channelID=${channelID}, channels count=${this.channels.size}`
    );
  }

  private enqueueSFTPTask(operation: string, task: () => Promise<void> | void): void {
    const run = this.sftpTaskQueue.then(async () => {
      await task();
    });

    this.sftpTaskQueue = run.catch((error) => {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.sendDebug(`SFTP task ERROR: ${errMsg}`);
      this.sendSFTPError(operation, `SFTP 操作失败: ${errMsg}`);
    });
  }

  private sendSFTPAttachUrl(): void {
    if (!this.sftpAttachUrl) return;
    if (this.config.sessionPolicy?.source === 'share' && !this.config.sessionPolicy.allowSftp)
      return;
    try {
      this.ws.send(JSON.stringify({ type: 'sftp_attach', url: this.sftpAttachUrl }));
    } catch (e) {
      this.sendDebug(() => `Send sftp_attach url failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private getSFTPOperation(type: string | undefined): string {
    switch (type) {
      case 'sftp_init':
        return 'init';
      case 'sftp_list':
        return 'list';
      case 'sftp_stat':
        return 'stat';
      case 'sftp_download':
      case 'sftp_download_cancel':
        return 'download';
      case 'sftp_edit_read':
        return 'edit';
      case 'sftp_upload_start':
      case 'sftp_upload_end':
      case 'sftp_upload_cancel':
        return 'upload';
      case 'sftp_delete':
        return 'delete';
      case 'sftp_rename':
        return 'rename';
      case 'sftp_mkdir':
        return 'mkdir';
      case 'sftp_rmdir':
        return 'rmdir';
      default:
        return 'protocol';
    }
  }

  private async auditSFTPRequest(msg: Record<string, unknown>): Promise<boolean> {
    if (this.config.sessionPolicy?.source !== 'share') return true;
    const operation = this.getSFTPOperation(typeof msg.type === 'string' ? msg.type : undefined);
    const auditable = new Set(['download', 'edit', 'upload', 'delete', 'rename', 'mkdir', 'rmdir']);
    if (!auditable.has(operation)) return true;
    if (msg.type === 'sftp_upload_end') return true;

    const details: Record<string, unknown> = { operation };
    if (typeof msg.path === 'string') details.path = msg.path.slice(0, 4096);
    if (typeof msg.oldPath === 'string') details.oldPath = msg.oldPath.slice(0, 4096);
    if (typeof msg.newPath === 'string') details.newPath = msg.newPath.slice(0, 4096);
    if (typeof msg.size === 'number' && Number.isFinite(msg.size))
      details.size = Math.max(0, Math.floor(msg.size));
    if (msg.type === 'sftp_download_cancel' || msg.type === 'sftp_upload_cancel') {
      details.cancelled = true;
    } else {
      this.sftpAuditContext.set(operation, details);
    }
    const recorded = await this.writeShareAudit('sftp.request', details);
    if (!recorded) {
      this.sendSFTPError(operation, '审计记录写入失败，分享会话已终止');
      this.close(true);
    }
    return recorded;
  }

  private auditSFTPResult(msg: Record<string, unknown>): void {
    if (this.config.sessionPolicy?.source !== 'share' || typeof msg.type !== 'string') return;
    const successTypes: Record<string, string> = {
      sftp_download_done: 'download',
      sftp_edit_done: 'edit',
      sftp_upload_complete: 'upload',
      sftp_delete_result: 'delete',
      sftp_rename_result: 'rename',
      sftp_mkdir_result: 'mkdir',
      sftp_rmdir_result: 'rmdir',
    };
    const cancelledTypes: Record<string, string> = {
      sftp_download_cancelled: 'download',
      sftp_upload_cancelled: 'upload',
    };
    let operation = successTypes[msg.type];
    let success = true;
    let cancelled = false;
    if (!operation && cancelledTypes[msg.type]) {
      operation = cancelledTypes[msg.type];
      cancelled = true;
    }
    if (msg.type === 'sftp_error' && typeof msg.operation === 'string') {
      operation = msg.operation;
      success = false;
    }
    if (!operation || !this.sftpAuditContext.has(operation)) return;
    const details: Record<string, unknown> = {
      ...this.sftpAuditContext.get(operation),
      success,
      ...(cancelled ? { cancelled: true } : {}),
    };
    if (typeof msg.size === 'number' && Number.isFinite(msg.size))
      details.transferredSize = Math.max(0, Math.floor(msg.size));
    if (!success && typeof msg.message === 'string') details.error = msg.message.slice(0, 512);
    this.sftpAuditContext.delete(operation);
    this.runShareBackground(
      this.writeShareAudit('sftp.result', details).then((recorded) => {
        if (!recorded) this.close(true);
      })
    );
  }

  private sendSFTPError(operation: string, message: string): void {
    this.sendSFTPJSON({ type: 'sftp_error', operation, message });
  }

  private sendSFTPJSON(msg: any): void {
    const payload = JSON.stringify(msg);
    if (this.sftpWs) {
      try {
        this.sftpWs.send(payload);
        return;
      } catch {
        this.sftpWs = null;
      }
    }
  }

  private sendSFTPBinary(data: Uint8Array): void {
    if (this.sftpWs) {
      try {
        this.sftpWs.send(data);
        return;
      } catch {
        this.sftpWs = null;
      }
    }

    this.sendDebug('SFTP binary dropped because SFTP WebSocket is not connected');
  }

  private closeSFTPChannel(): void {
    if (!this.sftpHandler) return;

    const channelID = this.sftpHandler.getChannelID();
    const channel = this.channels.get(channelID);

    if (channel && !channel.isClosed()) {
      const eof = channel.buildEof();
      const close = channel.buildClose();
      void this.sendEncrypted(eof)
        .then(() => this.sendEncrypted(close))
        .catch(() => {});
    }

    this.channels.delete(channelID);
    this.sftpHandler.dispose();
    this.sftpHandler = null;
  }

  private enqueueChannelData(data: Uint8Array): void {
    if (data.length === 0) return;

    // 浏览器→服务器输入积压上限：浏览器失去响应时 channelDataQueue 会无界堆积，
    // 超限直接关闭会话（常规重连即可恢复，无需等待远端超时）。
    if (this.channelDataQueueBytes + data.length > MAX_INPUT_QUEUE_BYTES) {
      this.sendError('终端输入积压过多（客户端可能已无响应），连接已关闭', 'input_backlog_closed');
      this.close();
      return;
    }

    this.channelDataQueueBytes += data.length;
    this.channelDataQueue.push(data);
    void this.flushChannelDataQueue();
  }

  private async flushChannelDataQueue(): Promise<void> {
    if (this.channelDataFlushInProgress) return;

    this.channelDataFlushInProgress = true;
    try {
      while (this.channelDataQueueHead < this.channelDataQueue.length) {
        const current = this.channelDataQueue[this.channelDataQueueHead];
        const chunk = this.shellChannel.takeChannelDataChunk(current, this.channelDataQueueOffset);
        if (!chunk) break;

        await this.sendEncryptedChannelData(chunk, this.shellChannel);
        this.channelDataQueueOffset += chunk.bytesConsumed;

        if (this.channelDataQueueOffset >= current.length) {
          this.channelDataQueueHead++;
          this.channelDataQueueOffset = 0;
          this.channelDataQueueBytes -= current.length;
        }
      }

      if (this.channelDataQueueHead > 0) {
        this.channelDataQueue = this.channelDataQueue.slice(this.channelDataQueueHead);
        this.channelDataQueueHead = 0;
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.sendDebug(`flushChannelDataQueue ERROR: ${errMsg}`);
      this.sendError(`发送数据失败: ${errMsg}`, 'send_data_failed', { message: errMsg });
      this.close();
    } finally {
      this.channelDataFlushInProgress = false;
    }
  }

  private async sendDirectTcpipData(
    channelID: number,
    channel: SSHChannel,
    data: Uint8Array
  ): Promise<void> {
    let offset = 0;
    while (offset < data.length) {
      if (!this.directTcpipStreams.has(channelID) || channel.isClosed()) {
        throw new Error('direct-tcpip channel closed while writing');
      }
      const chunk = channel.takeChannelDataChunk(data, offset);
      if (!chunk) {
        await new Promise<void>((resolve) => {
          const waiters = this.channelWindowWaiters.get(channelID) || [];
          waiters.push(resolve);
          this.channelWindowWaiters.set(channelID, waiters);
        });
        continue;
      }
      await this.sendEncryptedChannelData(chunk, channel);
      offset += chunk.bytesConsumed;
    }
  }

  private async closeDirectTcpipChannel(channelID: number, channel: SSHChannel): Promise<void> {
    this.directTcpipStreams.delete(channelID);
    this.channels.delete(channelID);
    const waiters = this.channelWindowWaiters.get(channelID);
    this.channelWindowWaiters.delete(channelID);
    if (waiters) for (const wake of waiters) wake();
    if (channel.isClosed()) return;
    try {
      await this.sendEncrypted(channel.buildEof());
      await this.sendEncrypted(channel.buildClose());
    } catch {
      // The parent SSH session may already be closing.
    }
  }

  private async handleResize(cols: unknown, rows: unknown): Promise<void> {
    if (!this.updateTerminalSize(cols, rows)) return;
    if (this.state !== 'ready') return;

    const resizeMsg = this.shellChannel.buildWindowChange(
      this.terminalSize.cols,
      this.terminalSize.rows
    );
    await this.sendEncrypted(resizeMsg);
  }

  private updateTerminalSize(cols: unknown, rows: unknown): boolean {
    const size = normalizeTerminalSize(cols, rows);
    if (!size) return false;

    this.terminalSize = size;
    return true;
  }

  private async sendEncrypted(payload: Uint8Array): Promise<void> {
    await this.sendEncryptedPacket(() => this.buildEncryptedPacket(payload));
  }

  private async sendEncryptedChannelData(
    chunk: ChannelDataChunk,
    channel: SSHChannel
  ): Promise<void> {
    await this.sendEncryptedPacket(() => this.buildEncryptedChannelDataPacket(chunk, channel));
  }

  private async sendEncryptedPacket(buildPacket: () => Promise<Uint8Array>): Promise<void> {
    const operation = this.sendMutex.then(async () => {
      const encrypted = await buildPacket();
      await this.writeSocket(encrypted);
    });

    this.sendMutex = operation.then(
      () => {},
      () => {}
    );
    await operation;
  }

  private queueLocalWindowAdjust(bytesToAdd: number, channel: SSHChannel): void {
    const adjustBytes = channel.queueLocalWindowAdjust(bytesToAdd, LOCAL_WINDOW_ADJUST_THRESHOLD);
    if (adjustBytes === null) {
      return;
    }

    void this.sendLocalWindowAdjust(adjustBytes, channel);
  }

  private async sendLocalWindowAdjust(bytesToAdd: number, channel: SSHChannel): Promise<void> {
    try {
      await this.sendEncrypted(channel.buildWindowAdjust(bytesToAdd));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.sendDebug(`sendLocalWindowAdjust ERROR: ${errMsg}`);
      this.sendError(`发送窗口调整失败: ${errMsg}`, 'resize_failed', { message: errMsg });
      this.close();
    }
  }

  private sendStatus(
    message: string,
    event?: string,
    params?: Record<string, string | number>
  ): void {
    try {
      this.ws.send(JSON.stringify({ type: 'status', message, event, params }));
    } catch {
      // WebSocket 已关闭，状态消息无法送达
    }
  }

  private sendError(
    message: string,
    event?: string,
    params?: Record<string, string | number>
  ): void {
    try {
      this.ws.send(JSON.stringify({ type: 'error', message, event, params }));
    } catch {
      // WebSocket 已关闭，错误消息无法送达
    }
  }

  private sendDebug(message: string | (() => string)): void {
    if (!this.debugMode) return;
    try {
      this.ws.send(
        JSON.stringify({
          type: 'debug',
          message: typeof message === 'function' ? message() : message,
        })
      );
    } catch {
      // WebSocket 已关闭，调试消息无法送达
    }
  }

  // ==================== 分享会话审计 ====================

  private writeShareAudit(eventType: string, details: Record<string, unknown>): Promise<boolean> {
    const policy = this.config.sessionPolicy;
    if (policy?.source !== 'share' || !this.env?.SSH_SHARE) return Promise.resolve(false);
    const operation = this.shareAuditWrite.then(async () => {
      try {
        const stub = this.env!.SSH_SHARE.get(this.env!.SSH_SHARE.idFromName(policy.shareRef));
        const response = await stub.fetch(
          new Request('http://internal/internal/audit/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventType, occurredAt: Date.now(), details }),
          })
        );
        return response.ok;
      } catch {
        return false;
      }
    });
    this.shareAuditWrite = operation.catch(() => false);
    return operation;
  }

  private recordShareTerminalOutput(data: Uint8Array): void {
    if (
      !this.shareAuditStarted ||
      this.config.sessionPolicy?.source !== 'share' ||
      data.length === 0
    )
      return;
    this.shareAuditBuffer += this.auditTextDecoder.decode(data, { stream: true });
    if (this.shareAuditBuffer.length >= SHARE_AUDIT_FLUSH_CHARS) {
      this.runShareBackground(this.flushShareAuditOutput());
      return;
    }
    if (!this.shareAuditFlushTimer) {
      this.shareAuditFlushTimer = setTimeout(() => {
        this.shareAuditFlushTimer = null;
        this.runShareBackground(this.flushShareAuditOutput());
      }, SHARE_AUDIT_FLUSH_MS);
    }
  }

  private async flushShareAuditOutput(): Promise<boolean> {
    if (this.shareAuditFlushTimer) {
      clearTimeout(this.shareAuditFlushTimer);
      this.shareAuditFlushTimer = null;
    }
    let text = this.shareAuditBuffer;
    this.shareAuditBuffer = '';
    if (!text) return true;
    while (text.length > 0) {
      const chunk = text.slice(0, SHARE_AUDIT_FLUSH_CHARS);
      text = text.slice(SHARE_AUDIT_FLUSH_CHARS);
      const recorded = await this.writeShareAudit('terminal.output', { text: chunk });
      if (!recorded) {
        if (!this.closed) {
          this.sendError(
            '分享会话审计写入失败或已达到容量上限，连接已终止',
            'share_audit_unavailable'
          );
          this.close(true);
        }
        return false;
      }
    }
    return true;
  }

  private notifyShareSessionClosed(normal: boolean): void {
    const policy = this.config.sessionPolicy;
    if (policy?.source !== 'share' || !this.env?.SSH_SHARE || this.shareAuditClosed) return;
    this.shareAuditClosed = true;
    this.runShareBackground(
      this.flushShareAuditOutput().finally(async () => {
        try {
          const stub = this.env!.SSH_SHARE.get(this.env!.SSH_SHARE.idFromName(policy.shareRef));
          await stub.fetch(
            new Request('http://internal/internal/session/closed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ normal }),
            })
          );
        } catch {
          /* 审计关闭通知失败不影响清理流程 */
        }
      })
    );
  }

  private runShareBackground(promise: Promise<unknown>): void {
    const guarded = promise.catch(() => undefined);
    if (this.waitUntil) this.waitUntil(guarded);
  }

  // ==================== 操作系统检测 ====================

  /** Shell 就绪统一入口。分享会话必须先建立审计，再允许浏览器输入。 */
  private async onShellReady(): Promise<void> {
    if (this.config.sessionPolicy?.source === 'share') {
      if (this.shareAuditStarted) return;
      const recorded = await this.writeShareAudit('session.started', {
        audited: true,
        sftpAllowed: this.config.sessionPolicy.allowSftp,
        agentAllowed: false,
      });
      if (!recorded) {
        this.sendError('分享会话审计不可用，连接已终止', 'share_audit_unavailable');
        this.close(true);
        return;
      }
      this.shareAuditStarted = true;
      const remaining = this.config.sessionPolicy.sessionExpiresAt - Date.now();
      if (remaining <= 0) {
        this.sendError('分享会话已过期', 'share_session_expired');
        this.close(true);
        return;
      }
      // 到期前 60s 预警：挂机用户往往无感知，提前明示会话即将结束
      const expiryWarningLeadMs = 60_000;
      const emitExpiryWarning = () => {
        this.sendStatus('分享会话即将结束（剩余不足 1 分钟）', 'share_expiring_warning');
      };
      if (remaining > expiryWarningLeadMs) {
        this.shareExpiryWarningTimer = setTimeout(
          emitExpiryWarning,
          remaining - expiryWarningLeadMs
        );
      } else {
        emitExpiryWarning();
      }
      this.shareSessionExpiryTimer = setTimeout(() => {
        this.sendError('分享会话已达到最长使用时间', 'share_session_expired');
        this.close(true);
      }, remaining);
      try {
        this.ws.send(
          JSON.stringify({
            type: 'session_capabilities',
            source: 'share',
            agent: false,
            sftp: this.config.sessionPolicy.allowSftp,
            audited: true,
            expiresAt: this.config.sessionPolicy.sessionExpiresAt,
          })
        );
      } catch {
        /* WebSocket 已关闭，忽略能力通告 */
      }
    }
    this.sendStatus('Shell 已就绪', 'shell_ready');
    if (this.config.sessionPolicy?.allowMetadataMutation !== false) {
      void this.detectRemoteOS();
    }
  }

  /**
   * 通过独立 exec channel 检测远端操作系统并持久化到 UserDBDO。
   * 仅对已登录用户的已保存服务器执行；解析/持久化失败都不影响 SSH 会话。
   */
  private async detectRemoteOS(): Promise<void> {
    if (this.config.sessionPolicy?.source === 'share') return;
    // 已保存服务器（token 路径才有 serverId）、未检测过、且未在进行中
    if (
      !this.config.serverId ||
      !this.userId ||
      !this.githubId ||
      this.config.os ||
      this.osDetectInProgress
    ) {
      return;
    }
    this.osDetectInProgress = true;
    try {
      const result = await this.executeAgentCommand(DETECT_OS_COMMAND, 5000);
      // stderr 可能包含 Shell 或权限错误，不能参与发行版名称解析。
      const os = parseDetectedOS(result.stdout);
      if (!isDetectedOS(os)) {
        this.sendDebug('OS detect returned unknown; leaving it unset for the next connection');
        return;
      }

      // 防止同一会话内重复触发；数据库写入失败时，下次新连接仍会再次检测。
      this.config.os = os;

      try {
        if (this.env) {
          const stub = this.env.USER_DB.get(this.env.USER_DB.idFromName(this.githubId));
          const res = await stub.fetch(
            new Request(`http://internal/internal/servers/${this.config.serverId}/os`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: Number(this.userId), os }),
            })
          );
          if (!res.ok) {
            this.sendDebug(`OS detect persist failed: ${res.status}`);
          }
        }
      } catch (e) {
        this.sendDebug(`OS detect persist error: ${e instanceof Error ? e.message : String(e)}`);
      }

      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'os_detected', serverId: this.config.serverId, os }));
        }
      } catch {
        /* ws closed */
      }
    } catch (e) {
      this.sendDebug(`OS detect error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.osDetectInProgress = false;
    }
  }

  // ==================== Agent Integration ====================

  private async handleAgentStart(
    userMessage: string,
    userId?: string,
    requestedLocale?: string
  ): Promise<void> {
    if (this.config.sessionPolicy?.source === 'share') {
      this.sendAgentFrame({
        type: 'agent_frame',
        subType: 'error',
        message: '分享会话不允许使用 AI Agent',
      });
      return;
    }
    if (this.state !== 'ready') {
      this.sendAgentFrame({ type: 'agent_frame', subType: 'error', message: 'SSH 连接未就绪' });
      return;
    }

    // Securely verify userId. Always use the authenticated session userId (this.userId).
    // Reject requests if client provides a conflicting userId.
    if (userId && this.userId && userId !== this.userId) {
      this.sendAgentFrame({
        type: 'agent_frame',
        subType: 'error',
        message: '用户身份不匹配，越权操作已被拦截',
      });
      return;
    }

    const effectiveUserId = this.userId;
    if (!effectiveUserId) {
      this.sendAgentFrame({
        type: 'agent_frame',
        subType: 'error',
        message: '需要登录用户才能使用 AI 助手',
      });
      return;
    }

    if (this.agentCore?.getStatus() === 'running') {
      this.sendAgentFrame({
        type: 'agent_frame',
        subType: 'error',
        message: 'Agent 正在运行中，请先停止当前任务',
      });
      return;
    }

    if (!this.agentCore) {
      this.agentCore = new AgentCore(
        this.terminalContext,
        (msg: any) => this.sendAgentFrame(msg),
        async (uid: string) => this.fetchAgentAIConfig(uid, this.githubId!),
        async (command: string, timeout: number, signal?: AbortSignal) =>
          this.executeAgentCommand(command, timeout, signal),
        async (command: string, reason: string) => this.askAgentConfirmation(command, reason)
      );
    }

    const locale = requestedLocale === 'en-US' ? 'en-US' : 'zh-CN';
    void this.agentCore.handleAgentStart(effectiveUserId, userMessage, locale);
  }

  /**
   * 处理 Agent 控制消息（confirm/stop），绕过被 handleAgentStart 阻塞的 WebSocket handler。
   * 这些消息由 durable-object.ts 在调用 handleWebSocketMessage 之前提前路由。
   */
  handleAgentControl(type: string, msg: any): void {
    if (type === 'agent_confirm') {
      if (this.confirmationResolve) {
        this.confirmationResolve(msg.approved === true);
        this.confirmationResolve = null;
      }
      return;
    }
    if (type === 'agent_stop') {
      this.agentCore?.agentAbort();
      return;
    }
  }

  private async fetchAgentAIConfig(
    userId: string,
    githubId: string
  ): Promise<{ base_url: string; model: string; api_key: string } | null> {
    if (!this.env) return null;
    try {
      const stub = this.env.USER_DB.get(this.env.USER_DB.idFromName(githubId));
      const res = await stub.fetch(
        new Request(`http://internal/internal/ai-config/decrypt?user_id=${userId}`)
      );
      if (!res.ok) return null;
      return (await res.json()) as { base_url: string; model: string; api_key: string };
    } catch {
      return null;
    }
  }

  /**
   * exec 输出超过捕获硬上限：删除本地通道引用（不再接收数据、不再续窗口），
   * 主动发送 CHANNEL_CLOSE —— sshd 会终止对应的远端命令（如无界输出的
   * docker logs），并提前决议 closedPromise，让 Agent 拿到带截断标记的结果。
   */
  private async terminateExecChannelOnCaptureLimit(
    channelID: number,
    channel: SSHChannel,
    execCh: AgentExecChannel
  ): Promise<void> {
    this.sendDebug(`Exec channel ${channelID} capture limit exceeded — closing channel`);
    this.activeExecChannels.delete(channelID);
    this.channels.delete(channelID);
    execCh.onClose();
    try {
      if (!channel.isClosed()) {
        await this.sendEncrypted(channel.buildClose());
      }
    } catch {
      // 弱网下发送失败也无妨：本地状态已清理，远端因窗口耗尽自行停止推送
    }
  }

  private async executeAgentCommand(
    command: string,
    timeout: number,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const channelID = this.nextChannelID++;
    const channel = new SSHChannel();
    this.channels.set(channelID, channel);

    const execCh = new AgentExecChannel(channelID, channel);
    this.activeExecChannels.set(channelID, execCh);

    // Open channel
    const openMsg = channel.buildOpenSession(channelID);
    await this.sendEncrypted(openMsg);

    try {
      // Wait for channel open confirmation (via execCh state flags, not this.channels map)
      const opened = await this.waitForExecChannelOpen(execCh, channel, command);

      if (!opened) {
        // Open rejected — closedPromise already resolved with error struct; await it
        return await execCh.getClosedPromise();
      }

      // Open succeeded — send exec request
      const execReq = channel.buildExecRequest(command);
      await this.sendEncrypted(execReq);

      // Wait for result with timeout + abort
      let aborted = false;
      const result = await Promise.race([
        execCh.getClosedPromise(),
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Exec timeout after ${timeout}ms`)),
            timeout
          );
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              clearTimeout(timer);
              reject(new Error('Exec aborted'));
            },
            { once: true }
          );
        }),
      ]);

      // Cleanup: send EOF + CLOSE to server (RFC 4254 §5.3)
      // Always attempt cleanup, even on abort, to prevent resource leaks
      if (!channel.isClosed()) {
        try {
          await this.sendEncrypted(channel.buildEof());
          await this.sendEncrypted(channel.buildClose());
        } catch {
          // Channel may already be closed by server, ignore
        }
      }

      // If aborted, also close the exec channel to resolve any pending promises
      if (aborted) {
        execCh.onClose();
      }

      return result;
    } finally {
      // 无论成功、失败、超时或被中止，都必须清理 channel 引用，防止资源泄漏
      // （之前 waitForExecChannelOpen 超时 throw 会跳过清理，导致 execCh 残留在 activeExecChannels）
      this.activeExecChannels.delete(channelID);
      this.channels.delete(channelID);
    }
  }

  private waitForExecChannelOpen(
    execCh: AgentExecChannel,
    channel: SSHChannel,
    command: string
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timeout = 5000;

      const check = () => {
        // Open rejected by server — return false, caller will await closedPromise
        if (execCh.isOpenFailed()) {
          resolve(false);
          return;
        }

        // Open succeeded — return true, caller will send exec request
        if (execCh.isOpenConfirmed() || channel.getRemoteChannelID() !== 0) {
          resolve(true);
          return;
        }

        // Timeout — reject with error
        if (Date.now() - start > timeout) {
          reject(new Error(`Exec channel open timeout (5s) for command: ${command}`));
          return;
        }

        setTimeout(check, 50);
      };

      check();
    });
  }

  /**
   * 等待用户确认/取消。DO 防 Hibernate 由 AgentCore.runLoopKeepAlive 统一保活，
   * 此处只需注册 resolve 回调即可。
   */
  private askAgentConfirmation(command: string, reason: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.confirmationResolve = resolve;
      this.sendAgentFrame({
        type: 'agent_frame',
        subType: 'confirm_required',
        command,
        reason,
      });
    });
  }

  private isExecChannel(channelID: number): boolean {
    return this.activeExecChannels.has(channelID);
  }

  private sendAgentFrame(msg: any): void {
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    } catch {
      /* WebSocket 已关闭，无法送达 */
    }
  }

  private handleDetachedTerminalOutput(data: Uint8Array, channel: SSHChannel): void {
    if (this.detachedBufferBytes + data.length <= SSHSession.MAX_DETACHED_BUFFER_BYTES) {
      this.detachedOutputBuffer.push(data.slice());
      this.detachedBufferBytes += data.length;
      this.recordShareTerminalOutput(data);
      this.queueLocalWindowAdjust(data.length, channel);
    } else {
      // 缓冲区达到 128KB：暂停发送 Window Adjust，触发远程进程背压暂停
      this.unadjustedDetachedBytes += data.length;
      this.sendDebug('Detached buffer reached 128KB limit; pausing window adjust for backpressure');
    }
  }

  public setDetached(detached: boolean): void {
    if (this.detached === detached) return;
    this.detached = detached;
    if (detached && this.config.sessionPolicy?.source === 'share') {
      void this.writeShareAudit('session.detached', {
        detachedAt: Date.now(),
      });
    }
  }

  public isDetached(): boolean {
    return this.detached;
  }

  public isReady(): boolean {
    return this.state === 'ready' && !this.closed;
  }

  /** 分享会话策略（非分享会话返回 null）；供 DO 层在恢复时做过期与绑定校验。 */
  public getSessionPolicy(): SSHSessionPolicy | null {
    return this.config.sessionPolicy ?? null;
  }

  /** 本会话的 SFTP attach URL；断线保持期由 DO 记录并在恢复时回传前端。 */
  public getSFTPAttachUrl(): string | undefined {
    return this.sftpAttachUrl;
  }

  public async reattachWebSocket(
    newWs: WebSocket,
    newSize?: TerminalSize | null,
    credentials?: {
      resumeToken?: string;
      sftpAttachUrl?: string;
      baseline?: { latencyMs: number; colo: string };
    }
  ): Promise<void> {
    this.ws = newWs;
    this.detached = false;

    // 恢复 SFTP attach URL（若断线期间丢失），保证恢复后可重建 SFTP 数据通道
    if (credentials?.sftpAttachUrl && !this.sftpAttachUrl) {
      this.sftpAttachUrl = credentials.sftpAttachUrl;
    }

    // 1. 下发会话恢复就绪信号（含轮换后的 resume token 与 SFTP attach URL）
    try {
      this.ws.send(
        JSON.stringify({
          type: 'session_resumed',
          ...(credentials?.resumeToken ? { resumeToken: credentials.resumeToken } : {}),
          ...(this.sftpAttachUrl ? { sftpAttachUrl: this.sftpAttachUrl } : {}),
        })
      );
    } catch {
      /* 新 WebSocket 尚未就绪，忽略 */
    }

    // 重发双段延迟基线：上游 SSH 连接未重建，原 CF→源站基线仍有效；
    // 客户端↔CF 段由心跳即时探测补齐
    if (credentials?.baseline) {
      try {
        this.ws.send(
          JSON.stringify({
            type: 'rtt',
            latency: credentials.baseline.latencyMs,
            colo: credentials.baseline.colo,
          })
        );
      } catch {
        /* 发送失败忽略 */
      }
    }

    // 2. 补发断线期间暂存的输出数据
    if (this.detachedOutputBuffer.length > 0) {
      for (const chunk of this.detachedOutputBuffer) {
        try {
          this.ws.send(chunk);
        } catch {
          /* 发送失败不中断补发流程 */
        }
      }
      this.detachedOutputBuffer = [];
      this.detachedBufferBytes = 0;
    }

    // 3. 恢复因背压积压的 Window 额度
    if (this.unadjustedDetachedBytes > 0 && this.shellChannel) {
      this.queueLocalWindowAdjust(this.unadjustedDetachedBytes, this.shellChannel);
      this.unadjustedDetachedBytes = 0;
    }

    // 4. 同步最新终端视口尺寸
    if (newSize && this.shellChannel) {
      await this.handleResize(newSize.cols, newSize.rows).catch(() => null);
    }

    // 5. 记录分享会话审计
    if (this.config.sessionPolicy?.source === 'share') {
      void this.writeShareAudit('session.resumed', {
        resumedAt: Date.now(),
      });
    }
  }

  close(normal: boolean = false): void {
    if (this.closed) return;
    this.closed = true;
    this.detached = false;
    this.detachedOutputBuffer = [];
    this.detachedBufferBytes = 0;
    this.unadjustedDetachedBytes = 0;
    this.notifyShareSessionClosed(normal);
    if (!this.authenticatedSettled) {
      this.authenticatedSettled = true;
      const error = new Error('SSH session closed before authentication completed') as Error & {
        normalClose?: boolean;
      };
      error.normalClose = normal;
      this.authenticatedReject(error);
    }
    this.clearPendingAuthChallenge();
    this.activeAuthMethod = null;
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    if (this.keepaliveTimeout) {
      clearTimeout(this.keepaliveTimeout);
      this.keepaliveTimeout = null;
    }
    if (this.idleWatchdogInterval) {
      clearInterval(this.idleWatchdogInterval);
      this.idleWatchdogInterval = null;
    }
    if (this.shellReadyTimeout) {
      clearTimeout(this.shellReadyTimeout);
      this.shellReadyTimeout = null;
    }
    if (this.shareSessionExpiryTimer) {
      clearTimeout(this.shareSessionExpiryTimer);
      this.shareSessionExpiryTimer = null;
    }
    if (this.shareExpiryWarningTimer) {
      clearTimeout(this.shareExpiryWarningTimer);
      this.shareExpiryWarningTimer = null;
    }
    if (this.shareAuditFlushTimer) {
      clearTimeout(this.shareAuditFlushTimer);
      this.shareAuditFlushTimer = null;
    }
    if (this.sftpHandler) {
      this.sftpHandler.dispose();
      this.sftpHandler = null;
    }
    // Cleanup agent
    this.agentCore?.agentAbort();
    this.agentCore = null;
    for (const [, execCh] of this.activeExecChannels) {
      execCh.onClose();
    }
    this.activeExecChannels.clear();
    for (const [channelID, pending] of this.pendingDirectTcpip) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('SSH jump session closed'));
      this.directTcpipStreams.get(channelID)?.remoteClose(new Error('SSH jump session closed'));
    }
    this.pendingDirectTcpip.clear();
    for (const stream of this.directTcpipStreams.values()) stream.remoteClose();
    this.directTcpipStreams.clear();
    for (const waiters of this.channelWindowWaiters.values()) {
      for (const wake of waiters) wake();
    }
    this.channelWindowWaiters.clear();
    if (this.confirmationResolve) {
      this.confirmationResolve(false);
      this.confirmationResolve = null;
    }
    this.channels.clear();
    this.channelDataQueue = [];
    this.channelDataQueueHead = 0;
    this.channelDataQueueOffset = 0;
    this.channelDataQueueBytes = 0;
    try {
      this.socketWriter?.releaseLock();
    } catch (e) {
      this.sendDebug(() => `Release socket writer lock: ${e instanceof Error ? e.message : e}`);
    }
    this.socketWriter = null;
    try {
      this.socket.close();
    } catch (e) {
      this.sendDebug(() => `Close TCP socket: ${e instanceof Error ? e.message : e}`);
    }
    try {
      this.sftpWs?.close(normal ? 1000 : 1011);
    } catch (e) {
      this.sendDebug(() => `Close SFTP ws: ${e instanceof Error ? e.message : e}`);
    }
    this.sftpWs = null;
    if (this.ownsWebSocket) {
      try {
        this.ws.close(normal ? 1000 : 1011);
      } catch (e) {
        this.sendDebug(() => `Close SSH ws: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
