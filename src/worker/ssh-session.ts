import { SSHConnectionConfig, SessionKeys, SSHPacket, TerminalSize, normalizeTerminalSize } from '../types';
import {
  SSH_MSG_KEXINIT,
  SSH_MSG_NEWKEYS,
  SSH_MSG_KEX_ECDH_REPLY,
  SSH_MSG_SERVICE_REQUEST,
  SSH_MSG_SERVICE_ACCEPT,
  SSH_MSG_EXT_INFO,
  SSH_MSG_USERAUTH_SUCCESS,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_GLOBAL_REQUEST,
  SSH_MSG_REQUEST_FAILURE,
  SSH_MSG_REQUEST_SUCCESS,
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION,
  SSH_MSG_CHANNEL_OPEN_FAILURE,
  SSH_MSG_CHANNEL_SUCCESS,
  SSH_MSG_CHANNEL_FAILURE,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_EXTENDED_DATA,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_CHANNEL_EOF,
  SSH_MSG_CHANNEL_CLOSE,
  SSH_MSG_CHANNEL_REQUEST,
  SSH_MSG_DISCONNECT,
  SSH_MSG_IGNORE,
  SSH_MSG_DEBUG,
  SSH_MSG_UNIMPLEMENTED,
} from '../types';
import { SSHTransport } from '../ssh/transport';
import { SSHPacketParser, SSHPacketBuilder, nextSequenceNumber } from '../ssh/packet';
import {
  KEXInitBuilder,
  parseKEXInit,
  negotiate,
  parseServerSigAlgs,
  filterExtInfo,
} from '../ssh/kex';
import {
  getCipherSpec,
  getMacAlgorithmsForCipher,
  getMacSpec,
  KEX_ALGORITHM_ECDH_NISTP256,
  isCurve25519KEXAlgorithm
} from '../ssh/algorithms';
import { ECDHKeyExchange } from '../ssh/kex-ecdh';
import { Curve25519KeyExchange, Curve25519KeyPair } from '../ssh/kex-curve25519';
import { KeyDerivation } from '../ssh/keys';
import { SSHAESCTRCipher, SSHAESGCMCipher, SSHHMAC } from '../ssh/crypto';
import { SSHAuth } from '../ssh/auth';
import { SSHChannel, type ChannelDataChunk } from '../ssh/channel';
import { SFTPHandler } from './sftp-handler';
import { AgentCore } from './agent/core';
import { TerminalContext } from './agent/terminal-context';
import { AgentExecChannel } from './agent/exec-channel';
import type { Env } from '../types';

const LOCAL_WINDOW_ADJUST_THRESHOLD = 512 * 1024;
const KEEPALIVE_REQUEST_NAME = new TextEncoder().encode('keepalive@openssh.com');

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

  private state: 'connecting' | 'version' | 'kex' | 'auth' | 'shell' | 'shell-requested' | 'ready'
    = 'connecting';
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
  private shellReadyTimeout: ReturnType<typeof setTimeout> | null = null;
  private terminalSize: TerminalSize = { cols: 120, rows: 40 };
  private debugMode: boolean = false;

  // Agent integration
  private terminalContext: TerminalContext = new TerminalContext();
  private agentCore: AgentCore | null = null;
  private activeExecChannels: Map<number, AgentExecChannel> = new Map();
  private confirmationResolve: ((approved: boolean) => void) | null = null;
  private env: Env | null = null;
  private userId: string | null = null;
  private githubId: string | null = null;

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

    this.transport = new SSHTransport();
    this.packetParser = new SSHPacketParser();
    this.shellChannel = new SSHChannel();
    this.channels.set(0, this.shellChannel);
    this.updateTerminalSize(config.cols, config.rows);
  }

  async startHandshake(): Promise<void> {
    this.sendStatus('正在交换版本信息...');
    this.sendSFTPAttachUrl();
    this.state = 'version';

    await this.writeSocket(this.textEncoder.encode('SSH-2.0-CloudSSH_1.0\r\n'));

    this.startReading();
  }

  attachSFTPWebSocket(ws: WebSocket): void {
    if (this.sftpWs && this.sftpWs !== ws) {
      try { this.sftpWs.close(1000, 'Replaced by new SFTP WebSocket'); } catch (e) { this.sendDebug(() => `Close old SFTP ws: ${e instanceof Error ? e.message : e}`); }
    }
    this.sftpWs = ws;
    try { ws.send(JSON.stringify({ type: 'sftp_socket_ready' })); } catch (e) { this.sendDebug(() => `Send sftp_socket_ready failed: ${e instanceof Error ? e.message : e}`); }
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
            this.sendError('SSH 服务器断开连接 (Socket closed by remote)');
            this.close();
            break;
          }
          value = result.value;
        }

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
              this.transport.handleVersionExchange(lineStr + '\r\n');
              remaining = this.versionRawBuffer.subarray(scanOffset);
              versionFound = true;
              break;
            } else {
            }
          }

          if (versionFound) {
            this.versionRawBuffer = new Uint8Array(0);
            this.sendStatus('版本交换完成，正在密钥协商...');
            this.state = 'kex';
            await this.startKEX();

            if (remaining.length > 0) {
              this.packetParser.feed(remaining);
              await this.processPackets();
            }
          } else {
            if (scanOffset > 0) {
              this.versionRawBuffer = this.versionRawBuffer.subarray(scanOffset);
            }
          }
        } else {
          this.packetParser.feed(value);
          await this.processPackets();
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      try {
        this.ws.send(JSON.stringify({ type: 'error', message: 'SSH 连接异常: ' + errMsg }));
      } catch (e) { this.sendDebug(() => `Send error to client failed: ${e instanceof Error ? e.message : e}`); }
    }
  }

  private async startKEX(): Promise<void> {
    this.kexInitLocal = KEXInitBuilder.build();

    const packet = await SSHPacketBuilder.build(
      this.kexInitLocal, 8, null, this.seqNumSend
    );
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

    const packet = await SSHPacketBuilder.build(
      kexInit, 8, null, this.seqNumSend
    );
    this.seqNumSend = nextSequenceNumber(this.seqNumSend);
    await this.writeSocket(packet);
  }

  private async writeSocket(data: Uint8Array): Promise<void> {
    if (!this.socketWriter) {
      this.socketWriter = this.socket.writable.getWriter();
    }
    await this.socketWriter!.write(data);
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
      this.encryptMac
        ? (packetData, seq) => this.encryptMac!.sign(packetData, seq)
        : undefined
    );
    this.seqNumSend = nextSequenceNumber(this.seqNumSend);
    return packet;
  }

  private async buildEncryptedChannelDataPacket(chunk: ChannelDataChunk, channel: SSHChannel): Promise<Uint8Array> {
    if (!this.encryptCipher) {
      throw new Error('Encryption not initialized');
    }

    const cipher = getCipherSpec(this.negotiatedCipherC2S);
    const packet = await SSHPacketBuilder.buildWithPayloadWriter(
      chunk.payloadLength,
      (packet, offset) => channel.writeChannelDataPayload(
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
      this.encryptMac
        ? (packetData, seq) => this.encryptMac!.sign(packetData, seq)
        : undefined
    );
    this.seqNumSend = nextSequenceNumber(this.seqNumSend);
    return packet;
  }

  private async processPackets(): Promise<void> {
    const cipher = this.decryptCipher ? getCipherSpec(this.negotiatedCipherS2C) : null;
    const blockSize = cipher ? cipher.blockSize : 8;
    const hasAuthTag = !!cipher?.aead;
    const macLength = this.decryptCipher && !hasAuthTag ? getMacSpec(this.negotiatedMacS2C).length : 0;
    const hasDecrypt = !!this.decryptCipher;
    this.sendDebug(() => `processPackets: blockSize=${blockSize}, hasDecrypt=${hasDecrypt}, bufferLen=${this.packetParser.getBufferLength()}`);

    while (true) {
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
          this.sendDebug(() => `No more packets, buffer remaining: ${this.packetParser.getBufferLength()}`);
          break;
        }

        this.sendDebug(() => `Received msgType=${packet.payload[0]}, state=${this.state}, payloadLen=${packet.payload.length}`);
        await this.handlePacket(packet);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this.sendDebug(`processPackets ERROR: ${errMsg}`);
        this.sendError('数据包处理异常: ' + errMsg);
        this.close();
        return;
      }
    }
  }

  private async handlePacket(packet: SSHPacket): Promise<void> {
    const msgType = packet.payload[0];

    // Transport-level messages handled regardless of state
    if (msgType === SSH_MSG_DISCONNECT) {
      this.sendStatus('服务器断开连接');
      this.close(true);
      return;
    }
    if (msgType === SSH_MSG_IGNORE || msgType === SSH_MSG_DEBUG || msgType === SSH_MSG_UNIMPLEMENTED) {
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
    const nameLen = (payload[offset] << 24) | (payload[offset+1] << 16) |
                    (payload[offset+2] << 8) | payload[offset+3];
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
    this.keepaliveInterval = setInterval(async () => {
      if (this.keepalivePending) {
        this.keepaliveFailCount++;
        this.sendDebug(`Keepalive timeout (${this.keepaliveFailCount}/${this.maxKeepaliveFails})`);
        if (this.keepaliveFailCount >= this.maxKeepaliveFails) {
          this.sendError('SSH 连接超时，保活失败');
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
            this.sendDebug(`Keepalive response timeout (${this.keepaliveFailCount}/${this.maxKeepaliveFails})`);
            this.keepalivePending = false;
            if (this.keepaliveFailCount >= this.maxKeepaliveFails) {
              this.sendError('SSH 连接超时，保活失败');
              this.close();
            }
          }
        }, 10000);
      } catch (e) {
        this.keepaliveFailCount++;
        this.sendDebug(`Keepalive send failed (${this.keepaliveFailCount}/${this.maxKeepaliveFails}): ${e instanceof Error ? e.message : String(e)}`);
        if (this.keepaliveFailCount >= this.maxKeepaliveFails) {
          this.sendError('SSH 连接超时，保活失败');
          this.close();
        }
      }
    }, 25000);
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
          this.negotiatedCipherC2S = negotiate(clientKex.encryptionC2S, serverKex.encryptionC2S, 'C2S cipher');
          this.negotiatedCipherS2C = negotiate(clientKex.encryptionS2C, serverKex.encryptionS2C, 'S2C cipher');
          this.negotiatedMacC2S = getCipherSpec(this.negotiatedCipherC2S).aead
            ? 'none'
            : negotiate(getMacAlgorithmsForCipher(this.negotiatedCipherC2S), serverKex.macC2S, 'C2S MAC');
          this.negotiatedMacS2C = getCipherSpec(this.negotiatedCipherS2C).aead
            ? 'none'
            : negotiate(getMacAlgorithmsForCipher(this.negotiatedCipherS2C), serverKex.macS2C, 'S2C MAC');
          this.sendDebug(`Negotiated KEX: ${this.negotiatedKexAlgorithm}, C2S: ${this.negotiatedCipherC2S}/${this.negotiatedMacC2S}, S2C: ${this.negotiatedCipherS2C}/${this.negotiatedMacS2C}`);
          await this.sendKEXECDHInit();
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          this.sendError('算法协商失败: ' + errMsg);
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
        const packet = await SSHPacketBuilder.build(
          newKeys, 8, null, this.seqNumSend
        );
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
          this.sendError('SERVICE_REQUEST 失败: ' + errMsg);
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
    const { hostKey, serverRawPublicKey, signature } =
      ECDHKeyExchange.parseReply(payload);
    this.sendDebug(`ECDH_REPLY parsed: hostKey=${hostKey.length}, serverPubKey=${serverRawPublicKey.length}, sig=${signature.length}`);

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
    const hHex = Array.from(H).map(b => b.toString(16).padStart(2, '0')).join('');
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
    this.hostKeyFingerprint = 'SHA256:' + btoa(String.fromCharCode(...fpHash)).replace(/=+$/, '');
    this.sendDebug(`Host key fingerprint: ${this.hostKeyFingerprint} (${this.hostKeyType})`);

    // --- known_hosts verification (TOFU) ---
    // Send fingerprint with key type to frontend for storage
    try {
      this.ws.send(JSON.stringify({ type: 'host_key', fingerprint: this.hostKeyFingerprint, keyType: this.hostKeyType }));
    } catch (e) { /* ws closed */ }

    // Compare against expected fingerprint if provided
    if (this.config.expectedFingerprint) {
      if (this.config.expectedFingerprint !== this.hostKeyFingerprint) {
        this.sendError('主机密钥指纹变更！请确认是否为预期行为。');
        this.sendError(`已知指纹: ${this.config.expectedFingerprint}`);
        this.sendError(`实际指纹: ${this.hostKeyFingerprint} (${this.hostKeyType})`);
        this.sendError('连接已阻断。如需信任新密钥，请在服务器列表中删除该服务器的已知主机记录后重试。');
        this.close();
        return;
      }
      this.sendStatus(`主机密钥验证通过 (${this.hostKeyType}) ✓`);
    } else {
      this.sendStatus(`服务器指纹: ${this.hostKeyFingerprint} (${this.hostKeyType})（首次连接，已记录）`);
    }

    // Verify host key signature to confirm exchange hash is correct
    let sigVerified: boolean | null = false;
    try {
      sigVerified = await this.verifyHostKeySignature(hostKey, signature, H);
      if (sigVerified === null) {
        this.sendDebug('Host key signature verification: UNSUPPORTED ALGORITHM');
        if (this.strictHostKeyVerify) {
          this.sendError('主机密钥签名验证失败：不支持的密钥算法');
          this.close();
          return;
        }
        this.sendStatus('主机密钥签名验证被跳过（暂不支持该算法）');
      } else {
        this.sendDebug(`Host key signature verification: ${sigVerified ? 'PASS' : 'FAIL'}`);
        if (!sigVerified) {
          if (this.strictHostKeyVerify) {
            this.sendError('主机密钥签名验证失败，连接被阻断。如需跳过，请设置 STRICT_HOST_KEY_VERIFY=false');
            this.close();
            return;
          }
          this.sendError('主机密钥签名验证失败 - 可能会有安全风险，但不阻断连接（严格模式已关闭）');
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.sendDebug(`Signature verification error: ${errMsg}`);
      if (this.strictHostKeyVerify) {
        this.sendError('主机密钥签名验证异常: ' + errMsg);
        this.close();
        return;
      }
    }

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

  private async verifyHostKeySignature(
    hostKeyBlob: Uint8Array,
    signatureBlob: Uint8Array,
    exchangeHash: Uint8Array
  ): Promise<boolean | null> {
    // Parse host key blob to get key type and raw key
    let offset = 0;
    const keyTypeLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                       (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
    offset += 4;
    const keyType = this.textDecoder.decode(hostKeyBlob.subarray(offset, offset + keyTypeLen));
    offset += keyTypeLen;
    this.sendDebug(`Host key type: ${keyType}`);

    // Parse signature blob to get sig type and raw sig
    let sigOffset = 0;
    const sigTypeLen = (signatureBlob[sigOffset] << 24) | (signatureBlob[sigOffset+1] << 16) |
                       (signatureBlob[sigOffset+2] << 8) | signatureBlob[sigOffset+3];
    sigOffset += 4;
    const sigType = this.textDecoder.decode(signatureBlob.subarray(sigOffset, sigOffset + sigTypeLen));
    sigOffset += sigTypeLen;
    const rawSigLen = (signatureBlob[sigOffset] << 24) | (signatureBlob[sigOffset+1] << 16) |
                      (signatureBlob[sigOffset+2] << 8) | signatureBlob[sigOffset+3];
    sigOffset += 4;
    const rawSig = signatureBlob.subarray(sigOffset, sigOffset + rawSigLen);
    this.sendDebug(`Signature type: ${sigType}, raw sig len: ${rawSig.length}`);

    if (keyType === 'ssh-ed25519') {
      const rawKeyLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                        (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
      offset += 4;
      const rawKey = hostKeyBlob.subarray(offset, offset + rawKeyLen);
      this.sendDebug(`Ed25519 public key: ${rawKey.length} bytes`);

      const pubKey = await crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'Ed25519' },
        false,
        ['verify']
      );

      return await crypto.subtle.verify(
        'Ed25519',
        pubKey,
        rawSig,
        exchangeHash
      );
    } else if (keyType === 'ecdsa-sha2-nistp256' ||
               keyType === 'ecdsa-sha2-nistp384' ||
               keyType === 'ecdsa-sha2-nistp521') {
      // RFC 5656: ECDSA 主机密钥按曲线 exhaustive 支持
      let namedCurve: string;
      let hash: 'SHA-256' | 'SHA-384' | 'SHA-512';
      let coordBytes: number;
      switch (keyType) {
        case 'ecdsa-sha2-nistp256':
          namedCurve = 'P-256'; hash = 'SHA-256'; coordBytes = 32; break;
        case 'ecdsa-sha2-nistp384':
          namedCurve = 'P-384'; hash = 'SHA-384'; coordBytes = 48; break;
        case 'ecdsa-sha2-nistp521':
          namedCurve = 'P-521'; hash = 'SHA-512'; coordBytes = 66; break;
        default:
          throw new Error(`unsupported ECDSA host key: ${keyType}`);
      }

      // Parse ECDSA key blob: string(curve), string(point)
      const curveLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                       (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
      offset += 4 + curveLen;
      const rawKeyLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                        (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
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

      return await crypto.subtle.verify(
        { name: 'ECDSA', hash },
        pubKey,
        ecdsaRawSig,
        exchangeHash
      );
    } else if (keyType === 'ssh-rsa') {
      // Parse RSA key
      const eLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                   (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
      offset += 4;
      const eRaw = hostKeyBlob.subarray(offset, offset + eLen);
      offset += eLen;
      
      const nLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                   (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
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
      
      this.sendDebug(`RSA public key: n=${nRaw.length} bytes, e=${eRaw.length} bytes, sigType=${sigType}, hash=${hashAlgo}`);

      // Convert to JWK format for import
      const jwk = {
        kty: "RSA",
        e: this.base64UrlEncodeUnsigned(eRaw),
        n: this.base64UrlEncodeUnsigned(nRaw),
        ext: true
      };

      try {
        const pubKey = await crypto.subtle.importKey(
          'jwk',
          jwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: hashAlgo },
          false,
          ['verify']
        );

        return await crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          pubKey,
          rawSig,
          exchangeHash
        );
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
    const rLen = (sshSig[offset] << 24) | (sshSig[offset+1] << 16) |
                 (sshSig[offset+2] << 8) | sshSig[offset+3];
    offset += 4;
    let r = sshSig.subarray(offset, offset + rLen);
    offset += rLen;
    const sLen = (sshSig[offset] << 24) | (sshSig[offset+1] << 16) |
                 (sshSig[offset+2] << 8) | sshSig[offset+3];
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
      this.encryptMac = this.negotiatedMacC2S === 'none'
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
      this.decryptMac = this.negotiatedMacS2C === 'none'
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
    let authRequest: Uint8Array;

    if (this.config.authMethod === 'publickey' && this.config.privateKey) {
      this.sendStatus('正在使用密钥认证...');
      authRequest = await SSHAuth.buildPublicKeyAuthRequest(
        this.config.username,
        this.config.privateKey,
        this.sessionID!,
        this.serverSigAlgs,            // 传入 server-sig-algs 协商 RSA 签名算法
        false,                         // allowLegacyRsaSha1: 默认禁用 SHA-1
      );
    } else {
      authRequest = SSHAuth.buildPasswordAuthRequest(
        this.config.username,
        this.config.password
      );
    }

    const packet = await this.buildEncryptedPacket(authRequest);
    await this.writeSocket(packet);
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
        this.sendStatus('认证服务已接受，正在认证...');
        await this.authenticate();
        break;

      case SSH_MSG_USERAUTH_SUCCESS:
        this.sendStatus('认证成功', 'auth_success');
        this.state = 'shell';
        this.startKeepalive();
        await this.openShell();
        break;

      case SSH_MSG_USERAUTH_FAILURE:
        this.sendError('认证失败：用户名或密码错误');
        this.close();
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
        this.sendDebug(`CHANNEL_OPEN_CONFIRMATION: channelID=${channelID}, remoteChannelID=${channel.getRemoteChannelID()}, isSFTP=${this.sftpHandler && channelID === this.sftpHandler.getChannelID()}`);

        if (channel === this.shellChannel) {
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
        const descLen = (payload[offset] << 24) | (payload[offset+1] << 16) | (payload[offset+2] << 8) | payload[offset+3];
        offset += 4;
        const description = this.textDecoder.decode(payload.subarray(offset, offset + descLen));

        this.channels.delete(channelID);

        if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
          // SFTP channel open failed - notify frontend, don't close terminal
          this.sendDebug(`SFTP channel open failed: reason=${reasonCode}, desc=${description}`);
          this.sendSFTPError('init', '服务器不支持 SFTP: ' + description);
          this.sftpHandler = null;
        } else if (this.isExecChannel(channelID)) {
          // Exec channel open failed - reject just this command, keep SSH session alive
          const execCh = this.activeExecChannels.get(channelID);
          if (execCh) {
            execCh.onChannelOpenFailure(reasonCode, description);
            this.activeExecChannels.delete(channelID);
          }
          this.sendDebug(`Exec channel open failed: channelID=${channelID}, reason=${reasonCode}, desc=${description}`);
        } else {
          // Shell channel failed - close connection
          this.sendError('通道打开被拒绝');
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
          this.shellReadyTimeout = setTimeout(() => {
            if (this.state === 'shell-requested') {
              this.state = 'ready';
              this.sendStatus('Shell 已就绪', 'shell_ready');
            }
          }, 3000);
        } else if (channelID === this.shellChannel.getLocalChannelID() && this.state === 'shell-requested') {
          // Shell request confirmed
          if (this.shellReadyTimeout) {
            clearTimeout(this.shellReadyTimeout);
            this.shellReadyTimeout = null;
          }
          this.state = 'ready';
          this.sendStatus('Shell 已就绪', 'shell_ready');
        } else if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
          // SFTP subsystem request confirmed - send SFTP init
          this.sendDebug(`SFTP CHANNEL_SUCCESS received, calling onSubsystemReady`);
          const handler = this.sftpHandler;
          void handler.onSubsystemReady().catch((error) => {
            const errMsg = error instanceof Error ? error.message : String(error);
            this.sendDebug(`SFTP onSubsystemReady ERROR: ${errMsg}`);
            if (this.sftpHandler === handler) {
              this.sendSFTPError('init', 'SFTP 初始化失败: ' + errMsg);
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
          this.sendError('PTY 或 Shell 请求被拒绝');
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

        if (channel === this.shellChannel) {
          // Shell channel data - forward to terminal
          if (this.state === 'shell-requested') {
            if (this.shellReadyTimeout) {
              clearTimeout(this.shellReadyTimeout);
              this.shellReadyTimeout = null;
            }
            this.state = 'ready';
            this.sendStatus('Shell 已就绪', 'shell_ready');
          }
          const outputData = channel.handleChannelData(payload);
          try { this.ws.send(outputData); } catch (e) { this.sendDebug(() => `Send shell output failed: ${e instanceof Error ? e.message : e}`); }
          this.queueLocalWindowAdjust(outputData.length, channel);
          // Feed terminal context for Agent
          try { this.terminalContext.appendOutput(this.textDecoder.decode(outputData)); } catch {}
        } else if (this.sftpHandler && channelID === this.sftpHandler.getChannelID()) {
          // SFTP channel data - forward to SFTP handler
          const sftpData = channel.handleChannelData(payload);
          this.sendDebug(() => `SFTP CHANNEL_DATA received: channelID=${channelID}, dataLen=${sftpData.length}, firstByte=${sftpData[0]}`);
          this.sftpHandler.onChannelData(sftpData);
          this.queueLocalWindowAdjust(sftpData.length, channel);
        } else {
          // Exec channel data (Agent)
          const execCh = this.activeExecChannels.get(channelID);
          if (execCh) {
            const execData = channel.handleChannelData(payload);
            execCh.onData(execData);
            this.queueLocalWindowAdjust(execData.length, channel);
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
          const dataTypeCode = (payload[offset] << 24) | (payload[offset+1] << 16) | (payload[offset+2] << 8) | payload[offset+3];
          offset += 4;
          const dataLen = (payload[offset] << 24) | (payload[offset+1] << 16) | (payload[offset+2] << 8) | payload[offset+3];
          offset += 4;
          const stderrData = payload.subarray(offset, offset + dataLen);
          try { this.ws.send(stderrData); } catch (e) { this.sendDebug(() => `Send stderr output failed: ${e instanceof Error ? e.message : e}`); }
          this.queueLocalWindowAdjust(stderrData.length, channel);
        } else {
          // Exec channel extended data (stderr for Agent)
          const execCh = this.activeExecChannels.get(channelID);
          if (execCh) {
            let offset = 1 + 4;
            offset += 4; // skip dataTypeCode
            const dataLen = (payload[offset] << 24) | (payload[offset+1] << 16) | (payload[offset+2] << 8) | payload[offset+3];
            offset += 4;
            const stderrData = payload.subarray(offset, offset + dataLen);
            execCh.onExtendedData(stderrData);
            this.queueLocalWindowAdjust(stderrData.length, channel);
          }
        }
        break;
      }

      case SSH_MSG_CHANNEL_WINDOW_ADJUST: {
        const channelID = this.getChannelIDFromPayload(payload);
        const channel = this.getChannelByID(channelID);
        if (channel) {
          channel.handleWindowAdjust(payload);
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
          this.sendStatus('会话已结束');
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
          this.sendStatus('会话已结束');
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
        const reqTypeLen = (payload[offset] << 24) | (payload[offset+1] << 16) | (payload[offset+2] << 8) | payload[offset+3];
        offset += 4;
        const reqType = this.textDecoder.decode(payload.subarray(offset, offset + reqTypeLen));
        offset += reqTypeLen;
        offset += 1; // skip want_reply

        if (reqType === 'exit-status') {
          const execCh = this.activeExecChannels.get(reqChannelID);
          if (execCh) {
            const exitCode = (payload[offset] << 24) | (payload[offset+1] << 16) | (payload[offset+2] << 8) | payload[offset+3];
            execCh.onExitStatus(exitCode);
            this.sendDebug(`Exec channel exit-status: channelID=${reqChannelID}, exitCode=${exitCode}`);
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
        this.sendStatus('服务器断开连接');
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
      let parsed: any = undefined;
      // 仅对可能为 JSON 的消息尝试解析（以 { 开头），避免终端输入产生噪音日志
      if (data.charCodeAt(0) === 123) {
        try {
          parsed = JSON.parse(data);
        } catch (e) { this.sendDebug(() => `JSON parse failed: ${e instanceof Error ? e.message : e}`); }
      }

      if (parsed && typeof parsed === 'object') {
        if (parsed.type === 'ping') {
          this.ws.send(JSON.stringify({ type: 'pong' }));
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
          await this.handleAgentStart(parsed.message, parsed.user_id);
          return;
        }

        // NOTE: SFTP control messages are handled over the dedicated SFTP WebSocket.
      }

      if (this.state !== 'ready') return;

      this.enqueueChannelData(this.textEncoder.encode(data));
    } else {
      if (this.state !== 'ready') return;

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
        this.sftpHandler?.cancelDownload();
        return;
      }

      if (parsed.type === 'sftp_upload_cancel') {
        void this.sftpHandler?.uploadCancel();
        return;
      }

      this.enqueueSFTPTask(this.getSFTPOperation(parsed.type), () => this.handleSFTPMessage(parsed));
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

    if (msg.type === 'sftp_init') {
      await this.openSFTPChannel();
      return;
    }

    if (!this.sftpHandler) {
      this.sendSFTPError(this.getSFTPOperation(msg.type), 'SFTP 未初始化，请先发送 sftp_init');
      return;
    }

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
      case 'sftp_download_cancel':
        this.sftpHandler.cancelDownload();
        break;
      case 'sftp_upload_start':
        await this.sftpHandler.uploadStart(msg.path, msg.size || 0);
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
    this.sendDebug(`SFTP channel open requested, channelID=${channelID}, channels count=${this.channels.size}`);
  }

  private enqueueSFTPTask(operation: string, task: () => Promise<void> | void): void {
    const run = this.sftpTaskQueue.then(async () => {
      await task();
    });

    this.sftpTaskQueue = run.catch((error) => {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.sendDebug(`SFTP task ERROR: ${errMsg}`);
      this.sendSFTPError(operation, 'SFTP 操作失败: ' + errMsg);
    });
  }

  private sendSFTPAttachUrl(): void {
    if (!this.sftpAttachUrl) return;
    try {
      this.ws.send(JSON.stringify({ type: 'sftp_attach', url: this.sftpAttachUrl }));
    } catch (e) { this.sendDebug(() => `Send sftp_attach url failed: ${e instanceof Error ? e.message : e}`); }
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
      void this.sendEncrypted(eof).then(() => this.sendEncrypted(close)).catch(() => {});
    }

    this.channels.delete(channelID);
    this.sftpHandler.dispose();
    this.sftpHandler = null;
  }

  private enqueueChannelData(data: Uint8Array): void {
    if (data.length === 0) return;

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
        }
      }

      if (this.channelDataQueueHead > 0) {
        this.channelDataQueue = this.channelDataQueue.slice(this.channelDataQueueHead);
        this.channelDataQueueHead = 0;
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.sendDebug(`flushChannelDataQueue ERROR: ${errMsg}`);
      this.sendError('发送数据失败: ' + errMsg);
      this.close();
    } finally {
      this.channelDataFlushInProgress = false;
    }
  }

  private async handleResize(cols: unknown, rows: unknown): Promise<void> {
    if (!this.updateTerminalSize(cols, rows)) return;
    if (this.state !== 'ready') return;

    const resizeMsg = this.shellChannel.buildWindowChange(this.terminalSize.cols, this.terminalSize.rows);
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

  private async sendEncryptedChannelData(chunk: ChannelDataChunk, channel: SSHChannel): Promise<void> {
    await this.sendEncryptedPacket(() => this.buildEncryptedChannelDataPacket(chunk, channel));
  }

  private async sendEncryptedPacket(buildPacket: () => Promise<Uint8Array>): Promise<void> {
    const operation = this.sendMutex.then(async () => {
      const encrypted = await buildPacket();
      await this.writeSocket(encrypted);
    });

    this.sendMutex = operation.then(() => {}, () => {});
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
      this.sendError('发送窗口调整失败: ' + errMsg);
      this.close();
    }
  }

  private sendStatus(message: string, event?: string): void {
    try {
      this.ws.send(JSON.stringify({ type: 'status', message, event }));
    } catch (e) {
      // WebSocket 已关闭，状态消息无法送达
    }
  }

  private sendError(message: string): void {
    try {
      this.ws.send(JSON.stringify({ type: 'error', message }));
    } catch (e) {
      // WebSocket 已关闭，错误消息无法送达
    }
  }

  private sendDebug(message: string | (() => string)): void {
    if (!this.debugMode) return;
    try {
      this.ws.send(JSON.stringify({ type: 'debug', message: typeof message === 'function' ? message() : message }));
    } catch (e) {
      // WebSocket 已关闭，调试消息无法送达
    }
  }

  // ==================== Agent Integration ====================

  private async handleAgentStart(userMessage: string, userId?: string): Promise<void> {
    if (this.state !== 'ready') {
      this.sendAgentFrame({ type: 'agent_frame', subType: 'error', message: 'SSH 连接未就绪' });
      return;
    }

    // Securely verify userId. Always use the authenticated session userId (this.userId).
    // Reject requests if client provides a conflicting userId.
    if (userId && this.userId && userId !== this.userId) {
      this.sendAgentFrame({ type: 'agent_frame', subType: 'error', message: '用户身份不匹配，越权操作已被拦截' });
      return;
    }

    const effectiveUserId = this.userId;
    if (!effectiveUserId) {
      this.sendAgentFrame({ type: 'agent_frame', subType: 'error', message: '需要登录用户才能使用 AI 助手' });
      return;
    }

    if (this.agentCore?.getStatus() === 'running') {
      this.sendAgentFrame({ type: 'agent_frame', subType: 'error', message: 'Agent 正在运行中，请先停止当前任务' });
      return;
    }

    if (!this.agentCore) {
      this.agentCore = new AgentCore(
        this.terminalContext,
        (msg: any) => this.sendAgentFrame(msg),
        async (uid: string) => this.fetchAgentAIConfig(uid, this.githubId!),
        async (command: string, timeout: number, signal?: AbortSignal) => this.executeAgentCommand(command, timeout, signal),
        async (command: string, reason: string) => this.askAgentConfirmation(command, reason),
      );
    }

    void this.agentCore.handleAgentStart(effectiveUserId, userMessage);
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

  private async fetchAgentAIConfig(userId: string, githubId: string): Promise<{ base_url: string; model: string; api_key: string } | null> {
    if (!this.env) return null;
    try {
      const stub = this.env.USER_DB.get(this.env.USER_DB.idFromName(githubId));
      const res = await stub.fetch(
        new Request(`http://internal/internal/ai-config/decrypt?user_id=${userId}`)
      );
      if (!res.ok) return null;
      return await res.json() as { base_url: string; model: string; api_key: string };
    } catch {
      return null;
    }
  }

  private async executeAgentCommand(
    command: string,
    timeout: number,
    signal?: AbortSignal,
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
          const timer = setTimeout(() => reject(new Error(`Exec timeout after ${timeout}ms`)), timeout);
          signal?.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(timer);
            reject(new Error('Exec aborted'));
          }, { once: true });
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

  private waitForExecChannelOpen(execCh: AgentExecChannel, channel: SSHChannel, command: string): Promise<boolean> {
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
    } catch {}
  }

  close(normal: boolean = false): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    if (this.keepaliveTimeout) {
      clearTimeout(this.keepaliveTimeout);
      this.keepaliveTimeout = null;
    }
    if (this.shellReadyTimeout) {
      clearTimeout(this.shellReadyTimeout);
      this.shellReadyTimeout = null;
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
    if (this.confirmationResolve) {
      this.confirmationResolve(false);
      this.confirmationResolve = null;
    }
    this.channels.clear();
    this.channelDataQueue = [];
    this.channelDataQueueHead = 0;
    this.channelDataQueueOffset = 0;
    try { this.socketWriter?.releaseLock(); } catch (e) { this.sendDebug(() => `Release socket writer lock: ${e instanceof Error ? e.message : e}`); }
    this.socketWriter = null;
    try { this.socket.close(); } catch (e) { this.sendDebug(() => `Close TCP socket: ${e instanceof Error ? e.message : e}`); }
    try { this.sftpWs?.close(normal ? 1000 : 1011); } catch (e) { this.sendDebug(() => `Close SFTP ws: ${e instanceof Error ? e.message : e}`); }
    this.sftpWs = null;
    try { this.ws.close(normal ? 1000 : 1011); } catch (e) { this.sendDebug(() => `Close SSH ws: ${e instanceof Error ? e.message : e}`); }
  }
}
