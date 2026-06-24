import { SSHConnectionConfig, SessionKeys, SSHPacket, TerminalSize, normalizeTerminalSize } from '../types';
import {
  SSH_MSG_KEXINIT,
  SSH_MSG_NEWKEYS,
  SSH_MSG_KEX_ECDH_REPLY,
  SSH_MSG_SERVICE_REQUEST,
  SSH_MSG_SERVICE_ACCEPT,
  SSH_MSG_USERAUTH_SUCCESS,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_GLOBAL_REQUEST,
  SSH_MSG_REQUEST_FAILURE,
  SSH_MSG_REQUEST_SUCCESS,
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION,
  SSH_MSG_CHANNEL_SUCCESS,
  SSH_MSG_CHANNEL_FAILURE,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_CHANNEL_EOF,
  SSH_MSG_CHANNEL_CLOSE,
  SSH_MSG_DISCONNECT,
  SSH_MSG_IGNORE,
  SSH_MSG_DEBUG,
  SSH_MSG_UNIMPLEMENTED,
  SSH_MSG_CHANNEL_OPEN_FAILURE,
} from '../types';
import { SSHTransport } from '../ssh/transport';
import { SSHPacketParser, SSHPacketBuilder } from '../ssh/packet';
import {
  KEXInitBuilder,
  parseKEXInit,
  negotiate
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
import { SSHChannel } from '../ssh/channel';

export class SSHSession {
  private ws: WebSocket;
  private socket: any;
  private config: SSHConnectionConfig;
  private strictHostKeyVerify: boolean;

  private transport: SSHTransport;
  private packetParser: SSHPacketParser;
  private channel: SSHChannel;
  private encryptCipher: SSHAESGCMCipher | SSHAESCTRCipher | null = null;
  private decryptCipher: SSHAESGCMCipher | SSHAESCTRCipher | null = null;
  private encryptMac: SSHHMAC | null = null;
  private decryptMac: SSHHMAC | null = null;
  private derivedKeys: SessionKeys | null = null;

  private seqNumSend: number = 0;
  private sessionID: Uint8Array | null = null;
  private sendMutex: Promise<void> = Promise.resolve();

  private kexInitLocal: Uint8Array | null = null;
  private kexInitRemote: Uint8Array | null = null;

  private negotiatedKexAlgorithm: string | null = null;
  private ecdhKeyPair: CryptoKeyPair | null = null;
  private curve25519KeyPair: Curve25519KeyPair | null = null;
  private kexRawPublicKey: Uint8Array | null = null;

  private state: 'connecting' | 'version' | 'kex' | 'auth' | 'shell' | 'shell-requested' | 'ready'
    = 'connecting';
  private hostKeyFingerprint: string = '';

  private versionRawBuffer: Uint8Array = new Uint8Array(0);
  private negotiatedCipherC2S: string = 'aes256-gcm@openssh.com';
  private negotiatedCipherS2C: string = 'aes256-gcm@openssh.com';
  private negotiatedMacC2S: string = 'none';
  private negotiatedMacS2C: string = 'none';

  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  private shellReadyTimeout: ReturnType<typeof setTimeout> | null = null;
  private terminalSize: TerminalSize = { cols: 120, rows: 40 };
  private debugMode: boolean = false;

  constructor(
    ws: WebSocket,
    socket: any,
    config: SSHConnectionConfig,
    strictHostKeyVerify: boolean = true,
    debugMode: boolean = false
  ) {
    this.ws = ws;
    this.socket = socket;
    this.config = config;
    this.strictHostKeyVerify = strictHostKeyVerify;
    this.debugMode = debugMode;

    this.transport = new SSHTransport();
    this.packetParser = new SSHPacketParser();
    this.channel = new SSHChannel();
    this.updateTerminalSize(config.cols, config.rows);
  }

  async startHandshake(): Promise<void> {
    this.sendStatus('正在交换版本信息...');
    this.state = 'version';

    const writer = this.socket.writable.getWriter();
    await writer.write(new TextEncoder().encode('SSH-2.0-CloudSSH_1.0\r\n'));
    writer.releaseLock();

    this.startReading();
  }

  private async startReading(): Promise<void> {
    const reader = this.socket.readable.getReader();
    const decoder = new TextDecoder();

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

            const lineBytes = this.versionRawBuffer.slice(scanOffset, lfIndex + 1);
            scanOffset = lfIndex + 1;

            let lineStr = decoder.decode(lineBytes);
            if (lineStr.endsWith('\n')) lineStr = lineStr.slice(0, -1);
            if (lineStr.endsWith('\r')) lineStr = lineStr.slice(0, -1);

            if (lineStr.startsWith('SSH-')) {
              this.transport.handleVersionExchange(lineStr + '\r\n');
              remaining = this.versionRawBuffer.slice(scanOffset);
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
              this.versionRawBuffer = this.versionRawBuffer.slice(scanOffset);
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
      } catch {}
    }
  }

  private async startKEX(): Promise<void> {
    this.kexInitLocal = KEXInitBuilder.build();

    const packet = await SSHPacketBuilder.build(
      this.kexInitLocal, 8, null, this.seqNumSend++
    );
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

    const ecdhPacket = await SSHPacketBuilder.build(
      kexInit, 8, null, this.seqNumSend++
    );
    await this.writeSocket(ecdhPacket);
  }

  private async writeSocket(data: Uint8Array): Promise<void> {
    const writer = this.socket.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
  }

  private async buildEncryptedPacket(payload: Uint8Array): Promise<Uint8Array> {
    if (!this.encryptCipher) {
      throw new Error('Encryption not initialized');
    }

    const cipher = getCipherSpec(this.negotiatedCipherC2S);
    return SSHPacketBuilder.build(
      payload,
      cipher.blockSize,
      (data, seq, aad) => this.encryptCipher!.encrypt(data, seq, aad),
      this.seqNumSend++,
      cipher.aead,
      this.encryptMac
        ? (packetData, seq) => this.encryptMac!.sign(packetData, seq)
        : undefined
    );
  }

  private async processPackets(): Promise<void> {
    const cipher = this.decryptCipher ? getCipherSpec(this.negotiatedCipherS2C) : null;
    const blockSize = cipher ? cipher.blockSize : 8;
    const hasAuthTag = !!cipher?.aead;
    const macLength = this.decryptCipher && !hasAuthTag ? getMacSpec(this.negotiatedMacS2C).length : 0;
    const hasDecrypt = !!this.decryptCipher;
    this.sendDebug(`processPackets: blockSize=${blockSize}, hasDecrypt=${hasDecrypt}, bufferLen=${this.packetParser.getBufferLength()}`);

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
          this.sendDebug(`No more packets, buffer remaining: ${this.packetParser.getBufferLength()}`);
          break;
        }

        this.sendDebug(`Received msgType=${packet.payload[0]}, state=${this.state}, payloadLen=${packet.payload.length}`);
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
    const requestName = new TextDecoder().decode(payload.slice(offset, offset + nameLen));
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
    this.keepaliveInterval = setInterval(async () => {
      try {
        const ignoreMsg = new Uint8Array([SSH_MSG_IGNORE, 0, 0, 0, 0]);
        await this.sendEncrypted(ignoreMsg);
      } catch (e) {
        this.sendDebug('Keepalive send failed: ' + (e instanceof Error ? e.message : String(e)));
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
          this.negotiatedKexAlgorithm = negotiate(clientKex.kexAlgorithms, serverKex.kexAlgorithms, 'KEX algorithm');
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
          newKeys, 8, null, this.seqNumSend++
        );
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

    // Compute host key fingerprint (SHA-256)
    const fpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', hostKey));
    this.hostKeyFingerprint = 'SHA256:' + btoa(String.fromCharCode(...fpHash)).replace(/=+$/, '');
    this.sendStatus(`服务器指纹: ${this.hostKeyFingerprint}`);
    this.sendDebug(`Host key fingerprint: ${this.hostKeyFingerprint}`);

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
    const keyType = new TextDecoder().decode(hostKeyBlob.slice(offset, offset + keyTypeLen));
    offset += keyTypeLen;
    this.sendDebug(`Host key type: ${keyType}`);

    // Parse signature blob to get sig type and raw sig
    let sigOffset = 0;
    const sigTypeLen = (signatureBlob[sigOffset] << 24) | (signatureBlob[sigOffset+1] << 16) |
                       (signatureBlob[sigOffset+2] << 8) | signatureBlob[sigOffset+3];
    sigOffset += 4;
    const sigType = new TextDecoder().decode(signatureBlob.slice(sigOffset, sigOffset + sigTypeLen));
    sigOffset += sigTypeLen;
    const rawSigLen = (signatureBlob[sigOffset] << 24) | (signatureBlob[sigOffset+1] << 16) |
                      (signatureBlob[sigOffset+2] << 8) | signatureBlob[sigOffset+3];
    sigOffset += 4;
    const rawSig = signatureBlob.slice(sigOffset, sigOffset + rawSigLen);
    this.sendDebug(`Signature type: ${sigType}, raw sig len: ${rawSig.length}`);

    if (keyType === 'ssh-ed25519') {
      const rawKeyLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                        (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
      offset += 4;
      const rawKey = hostKeyBlob.slice(offset, offset + rawKeyLen);
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
    } else if (keyType === 'ecdsa-sha2-nistp256') {
      // Parse ECDSA key
      const curveLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                       (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
      offset += 4 + curveLen;
      const rawKeyLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                        (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
      offset += 4;
      const rawKey = hostKeyBlob.slice(offset, offset + rawKeyLen);
      this.sendDebug(`ECDSA public key: ${rawKey.length} bytes`);

      const pubKey = await crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );

      // Convert SSH DER signature to raw r||s format for Web Crypto
      const ecdsaRawSig = this.convertSSHECDSASig(rawSig);
      this.sendDebug(`ECDSA raw sig: ${ecdsaRawSig.length} bytes`);

      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pubKey,
        ecdsaRawSig,
        exchangeHash
      );
    } else if (keyType === 'ssh-rsa') {
      // Parse RSA key
      const eLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                   (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
      offset += 4;
      const eRaw = hostKeyBlob.slice(offset, offset + eLen);
      offset += eLen;
      
      const nLen = (hostKeyBlob[offset] << 24) | (hostKeyBlob[offset+1] << 16) |
                   (hostKeyBlob[offset+2] << 8) | hostKeyBlob[offset+3];
      offset += 4;
      const nRaw = hostKeyBlob.slice(offset, offset + nLen);
      
      // Determine hash algorithm based on signature type
      let hashAlgo = 'SHA-1';
      if (sigType === 'rsa-sha2-256') hashAlgo = 'SHA-256';
      else if (sigType === 'rsa-sha2-512') hashAlgo = 'SHA-512';
      
      this.sendDebug(`RSA public key: n=${nRaw.length} bytes, e=${eRaw.length} bytes, hash=${hashAlgo}`);

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

  private convertSSHECDSASig(sshSig: Uint8Array): Uint8Array {
    // SSH ECDSA sig is: string r, string s (each mpint)
    let offset = 0;
    const rLen = (sshSig[offset] << 24) | (sshSig[offset+1] << 16) |
                 (sshSig[offset+2] << 8) | sshSig[offset+3];
    offset += 4;
    let r = sshSig.slice(offset, offset + rLen);
    offset += rLen;
    const sLen = (sshSig[offset] << 24) | (sshSig[offset+1] << 16) |
                 (sshSig[offset+2] << 8) | sshSig[offset+3];
    offset += 4;
    let s = sshSig.slice(offset, offset + sLen);

    // Strip leading zero bytes (mpint sign extension)
    if (r.length > 32 && r[0] === 0) r = r.slice(1);
    if (s.length > 32 && s[0] === 0) s = s.slice(1);

    // Pad to 32 bytes each
    const result = new Uint8Array(64);
    result.set(r, 32 - r.length);
    result.set(s, 64 - s.length);
    return result;
  }

  private async enableEncryption(): Promise<void> {
    const keys = this.derivedKeys!;
    const cipherC2S = getCipherSpec(this.negotiatedCipherC2S);
    const cipherS2C = getCipherSpec(this.negotiatedCipherS2C);
    const encKeyC2S = keys.encKeyClientToServer.slice(0, cipherC2S.keyLength);
    const encKeyS2C = keys.encKeyServerToClient.slice(0, cipherS2C.keyLength);

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
    const nameBytes = new TextEncoder().encode(serviceName);
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
        this.sessionID!
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
      case SSH_MSG_SERVICE_ACCEPT:
        this.sendStatus('认证服务已接受，正在认证...');
        await this.authenticate();
        break;

      case SSH_MSG_USERAUTH_SUCCESS:
        this.sendStatus('认证成功');
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
    const openMsg = this.channel.buildOpenSession();
    await this.sendEncrypted(openMsg);
  }

  private async handleSessionPacket(msgType: number, payload: Uint8Array): Promise<void> {
    switch (msgType) {
      case SSH_MSG_CHANNEL_OPEN_CONFIRMATION:
        this.channel.handleOpenConfirmation(payload);
        const ptyReq = this.channel.buildPTYRequest(this.terminalSize.cols, this.terminalSize.rows);
        await this.sendEncrypted(ptyReq);
        break;

      case SSH_MSG_CHANNEL_OPEN_FAILURE:
        this.sendError('通道打开被拒绝');
        this.close();
        break;

      case SSH_MSG_CHANNEL_SUCCESS:
        if (this.state === 'shell') {
          // PTY 请求确认，发送 shell 请求
          const shellReq = this.channel.buildShellRequest();
          await this.sendEncrypted(shellReq);
          this.state = 'shell-requested';
          // 设置超时兜底：如果服务器不发送 shell 确认，3秒后自动进入 ready
          this.shellReadyTimeout = setTimeout(() => {
            if (this.state === 'shell-requested') {
              this.state = 'ready';
              this.sendStatus('Shell 已就绪');
            }
          }, 3000);
        } else if (this.state === 'shell-requested') {
          // Shell 请求确认，进入 ready 状态
          if (this.shellReadyTimeout) {
            clearTimeout(this.shellReadyTimeout);
            this.shellReadyTimeout = null;
          }
          this.state = 'ready';
          this.sendStatus('Shell 已就绪');
        }
        break;

      case SSH_MSG_CHANNEL_FAILURE:
        if (this.state === 'shell' || this.state === 'shell-requested') {
          this.sendError('PTY 或 Shell 请求被拒绝');
          this.close();
        }
        break;

      case SSH_MSG_CHANNEL_DATA: {
        // 某些 SSH 服务器（如 Dropbear）不会为 shell 请求发送 CHANNEL_SUCCESS，
        // 而是直接发送 shell 输出。收到 CHANNEL_DATA 说明 shell 已就绪。
        if (this.state === 'shell-requested') {
          if (this.shellReadyTimeout) {
            clearTimeout(this.shellReadyTimeout);
            this.shellReadyTimeout = null;
          }
          this.state = 'ready';
          this.sendStatus('Shell 已就绪');
        }
        const outputData = this.channel.handleChannelData(payload);
        this.ws.send(outputData);
        const adjustMsg = this.channel.buildWindowAdjust(outputData.length);
        await this.sendEncrypted(adjustMsg);
        break;
      }

      case SSH_MSG_CHANNEL_WINDOW_ADJUST:
        break;

      case SSH_MSG_CHANNEL_EOF:
      case SSH_MSG_CHANNEL_CLOSE:
        this.sendStatus('会话已结束');
        this.close(true);
        break;

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
      try {
        parsed = JSON.parse(data);
      } catch {}

      if (parsed && typeof parsed === 'object') {
        if (parsed.type === 'ping') {
          this.ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (parsed.type === 'resize') {
          await this.handleResize(parsed.cols, parsed.rows);
          return;
        }
      }

      if (this.state !== 'ready') return;
      
      const encoded = new TextEncoder().encode(data);
      const channelData = this.channel.buildChannelData(encoded);
      await this.sendEncrypted(channelData);
    } else {
      if (this.state !== 'ready') return;

      const channelData = this.channel.buildChannelData(new Uint8Array(data));
      await this.sendEncrypted(channelData);
    }
  }

  private async handleResize(cols: unknown, rows: unknown): Promise<void> {
    if (!this.updateTerminalSize(cols, rows)) return;
    if (this.state !== 'ready') return;

    const resizeMsg = this.channel.buildWindowChange(this.terminalSize.cols, this.terminalSize.rows);
    await this.sendEncrypted(resizeMsg);
  }

  private updateTerminalSize(cols: unknown, rows: unknown): boolean {
    const size = normalizeTerminalSize(cols, rows);
    if (!size) return false;

    this.terminalSize = size;
    return true;
  }

  private async sendEncrypted(payload: Uint8Array): Promise<void> {
    const operation = this.sendMutex.then(async () => {
      const encrypted = await this.buildEncryptedPacket(payload);
      await this.writeSocket(encrypted);
    });

    this.sendMutex = operation.then(() => {}, () => {});
    await operation;
  }

  private sendStatus(message: string): void {
    try {
      this.ws.send(JSON.stringify({ type: 'status', message }));
    } catch {}
  }

  private sendError(message: string): void {
    try {
      this.ws.send(JSON.stringify({ type: 'error', message }));
    } catch {}
  }

  private sendDebug(message: string): void {
    if (!this.debugMode) return;
    try {
      this.ws.send(JSON.stringify({ type: 'debug', message }));
    } catch {}
  }

  close(normal: boolean = false): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    if (this.shellReadyTimeout) {
      clearTimeout(this.shellReadyTimeout);
      this.shellReadyTimeout = null;
    }
    try { this.socket.close(); } catch {}
    try { this.ws.close(normal ? 1000 : 1011); } catch {}
  }
}
