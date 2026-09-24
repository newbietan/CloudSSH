export interface SSHPacket {
  length: number;
  paddingLength: number;
  payload: Uint8Array;
  mac?: Uint8Array;
}

export interface KEXInitMessage {
  kexAlgorithms: string[];
  hostKeyAlgorithms: string[];
  encryptionC2S: string[];
  encryptionS2C: string[];
  macC2S: string[];
  macS2C: string[];
  compressionC2S: string[];
  compressionS2C: string[];
}

export interface SessionKeys {
  ivClientToServer: Uint8Array;
  ivServerToClient: Uint8Array;
  encKeyClientToServer: Uint8Array;
  encKeyServerToClient: Uint8Array;
  integrityKeyC2S: Uint8Array;
  integrityKeyS2C: Uint8Array;
  sessionID: Uint8Array;
}

export interface ECDHResult {
  sharedSecret: Uint8Array;
  exchangeHash: Uint8Array;
  sessionID: Uint8Array;
  hostKey: Uint8Array;
  signature: Uint8Array;
}

export interface AuthResult {
  success: boolean;
  allowedMethods?: string[];
  /** RFC 4252: whether a previous authentication step partially succeeded. */
  partialSuccess?: boolean;
}

export interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  authMethod?: 'password' | 'publickey';
  privateKey?: string;
  cols?: number;
  rows?: number;
  expectedFingerprint?: string;
  /** Path-scoped known-host identity; defaults to host for direct connections. */
  knownHostIdentity?: string;
  userId?: string;
  githubId?: string;
  /** 已保存服务器的记录 ID（token 路径下由 handleConnectServer 填充，供 OS 检测持久化） */
  serverId?: number;
  /** 已检测并持久化的操作系统标识（已设置则连接时跳过重复检测） */
  os?: string | null;
  /**
   * Cloudflare DO locationHint。
   * - 用户保存服务器时手动覆盖的 `region` → 优先使用
   * - 系统保存服务器时自动推断并持久化的 `inferred_hint` → 次优
   * - undefined → Cloudflare 自行决定 DO 实例位置（行为同改造前）
   * 连接时仅做白名单过滤（实际取值由 user-db.handleConnectServer 计算）。
   */
  locationHint?: string;
  /** Saved jump hosts ordered from the public entry hop toward this target. */
  jumpHosts?: SSHJumpHostConfig[];
  /** 仅可由 Worker 内部的一次性分享兑换流程写入，客户端输入必须剥离。 */
  sessionPolicy?: SSHSessionPolicy;
  /**
   * 传输协议类型：'direct'（直连 TCP / 跳板机）或 'cf_tunnel'（Cloudflare 隧道 WSS）
   */
  transportType?: 'direct' | 'cf_tunnel';
  /**
   * Cloudflare 隧道公共主机名（例如 ssh.example.com）。
   * 仅在 transportType === 'cf_tunnel' 时生效。
   */
  cfTunnelHost?: string;
  /**
   * Cloudflare Zero Trust Access Service Token Client ID（可选）
   */
  cfAccessClientId?: string;
  /**
   * Cloudflare Zero Trust Access Service Token Client Secret（可选）
   */
  cfAccessClientSecret?: string;
}

export interface SSHSessionPolicy {
  source: 'share';
  shareId: string;
  /** 用于定位独立 SSHShareDO 的不透明引用，不包含用户或服务器信息。 */
  shareRef: string;
  allowAgent: false;
  allowSftp: boolean;
  allowMetadataMutation: false;
  allowHostKeyMutation: false;
  allowReconnect: false;
  /** 分享会话的绝对结束时间（Unix 毫秒）。 */
  sessionExpiresAt: number;
}

export interface SSHJumpHostConfig {
  serverId: number;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  authMethod: 'password' | 'publickey';
  privateKey: string;
  expectedFingerprint?: string;
  knownHostIdentity: string;
}

/**
 * Cloudflare Durable Object `get()` 支持的 locationHint 值。
 * 参考: https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
export const ALLOWED_LOCATION_HINTS = [
  'wnam',
  'enam',
  'sam',
  'weur',
  'eeur',
  'apac',
  'apac-ne',
  'apac-se',
  'oc',
  'afr',
  'me',
] as const;
export type LocationHint = (typeof ALLOWED_LOCATION_HINTS)[number];

export interface TerminalSize {
  cols: number;
  rows: number;
}

export function normalizeTerminalSize(cols: unknown, rows: unknown): TerminalSize | null {
  if (
    typeof cols !== 'number' ||
    typeof rows !== 'number' ||
    !Number.isFinite(cols) ||
    !Number.isFinite(rows)
  ) {
    return null;
  }

  const size = {
    cols: Math.floor(cols),
    rows: Math.floor(rows),
  };

  if (size.cols < 10 || size.cols > 2000 || size.rows < 5 || size.rows > 2000) {
    return null;
  }

  return size;
}

export interface Env {
  SSH_SESSION: DurableObjectNamespace;
  USER_DB: DurableObjectNamespace;
  SSH_SHARE: DurableObjectNamespace;
  MAX_CONNECTIONS?: string;
  IDLE_TIMEOUT?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITEKEY?: string;
  // GitHub OAuth（可选，未配置则登录功能自动禁用）
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  // GitHub 登录白名单（可选，逗号分隔的数字 GitHub user ID；未配置则不限制）
  GITHUB_ALLOWED_USER_IDS?: string;
  // 是否强制 GitHub 登录后才能使用 SSH（可选，默认 false）
  REQUIRE_GITHUB_AUTH?: string;
  BASE_URL?: string;
  // 主机密钥验证严格模式（默认 true，设为 false 可跳过签名验证失败）
  STRICT_HOST_KEY_VERIFY?: string;
  // 调试模式（设为 true 启用调试日志输出到前端）
  DEBUG_MODE?: string;
  // 一次性 SSH 分享（默认关闭；true 时登录用户可创建分享链接）
  ENABLE_SSH_SHARING?: string;
  // 单管理员密码认证（可选）。
  // 格式：pbkdf2$sha256$<iterations>$<salt-b64url>$<verifier-b64url>，由 `pnpm run hash-password` 生成。
  // 非空且格式合法即启用密码模式：GitHub OAuth 路由禁用，全实例仅本地管理员一个账号。
  // 置空/删除即刻退回 GitHub 模式；verifier = SHA-256(PBKDF2(password, salt, iterations))。
  // 浏览器端执行 PBKDF2 预拉伸（server relief），Worker 侧仅做一次 SHA-256 比对（Free 套餐 CPU 安全）。
  ADMIN_PASSWORD_HASH?: string;
}

/** /api/config 下发的密码认证公开参数（盐与迭代数非机密，供浏览器预拉伸） */
export interface PasswordAuthParams {
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string; // base64url
}

export interface UserInfo {
  id: number;
  github_id: number;
  username: string;
  /** 本地管理员（密码模式）无头像，恒为 null；GitHub 用户为头像 URL */
  avatar_url: string | null;
}

export interface ServerConfig {
  id: number;
  user_id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'publickey';
  /** 用户手动指定的区域偏好；空表示 Auto（依赖系统推断的 inferred_hint） */
  region?: string | null;
  /** 系统在保存/更新服务器时通过第三方 IPinfo 自动推断并持久化的 hint */
  inferred_hint?: string | null;
  /** 用户用于组织和筛选服务器的单层标签 */
  tags: string[];
  /** 连接时检测到的远端操作系统（canonical key，如 ubuntu/debian/centos） */
  os?: string | null;
  /** Optional saved server used as the immediate SSH jump host. */
  jump_server_id?: number | null;
  /** 传输协议类型：直连 TCP ('direct') 或 Cloudflare 隧道 ('cf_tunnel')，默认为 'direct' */
  transport_type?: 'direct' | 'cf_tunnel';
  /** Cloudflare 隧道公共主机名（如 ssh.example.com） */
  cf_tunnel_host?: string | null;
  /** Cloudflare Zero Trust Access Service Token Client ID（可选） */
  cf_access_client_id?: string | null;
  /** 是否已保存 Cloudflare Zero Trust Access Service Token Secret */
  has_cf_access_client_secret?: boolean;
  created_at: string;
  updated_at: string;
}

export type {
  ServerWorkLog,
  ServerKnowledgeItem,
  UnifiedServerMemory,
  KnowledgeCategory,
} from './server-memory-schema';

export const SSH_MSG_DISCONNECT = 1;
export const SSH_MSG_IGNORE = 2;
export const SSH_MSG_UNIMPLEMENTED = 3;
export const SSH_MSG_DEBUG = 4;
export const SSH_MSG_SERVICE_REQUEST = 5;
export const SSH_MSG_SERVICE_ACCEPT = 6;
export const SSH_MSG_EXT_INFO = 7;
export const SSH_MSG_KEXINIT = 20;
export const SSH_MSG_NEWKEYS = 21;
export const SSH_MSG_KEX_ECDH_INIT = 30;
export const SSH_MSG_KEX_ECDH_REPLY = 31;
export const SSH_MSG_USERAUTH_REQUEST = 50;
export const SSH_MSG_USERAUTH_FAILURE = 51;
export const SSH_MSG_USERAUTH_SUCCESS = 52;
// User-auth message numbers 60/61 are method-specific. These names apply only
// while keyboard-interactive is active; 60 is PK_OK/PASSWD_CHANGEREQ in the
// publickey/password methods and must be disambiguated by session state.
export const SSH_MSG_USERAUTH_INFO_REQUEST = 60;
export const SSH_MSG_USERAUTH_INFO_RESPONSE = 61;
export const SSH_MSG_GLOBAL_REQUEST = 80;
export const SSH_MSG_REQUEST_SUCCESS = 81;
export const SSH_MSG_REQUEST_FAILURE = 82;
export const SSH_MSG_CHANNEL_OPEN = 90;
export const SSH_MSG_CHANNEL_OPEN_CONFIRMATION = 91;
export const SSH_MSG_CHANNEL_OPEN_FAILURE = 92;
export const SSH_MSG_CHANNEL_WINDOW_ADJUST = 93;
export const SSH_MSG_CHANNEL_DATA = 94;
export const SSH_MSG_CHANNEL_EXTENDED_DATA = 95;
export const SSH_MSG_CHANNEL_EOF = 96;
export const SSH_MSG_CHANNEL_CLOSE = 97;
export const SSH_MSG_CHANNEL_REQUEST = 98;
export const SSH_MSG_CHANNEL_SUCCESS = 99;
export const SSH_MSG_CHANNEL_FAILURE = 100;

export const SESSION_GRACE_PERIOD_MS = 60_000;
export const SESSION_RING_BUFFER_MAX_BYTES = 128 * 1024;

export interface SessionCreatedMessage {
  type: 'session_created';
  sessionId: string;
  resumeToken: string;
  expiresIn: number;
  /** 该会话是否绑定了设备公钥（分享会话必须绑定才支持断线恢复）。 */
  deviceBound?: boolean;
  /** 是否允许断线自动恢复（分享会话未绑定设备时为 false，凭据为空串）。 */
  resumeEnabled?: boolean;
}

export interface SessionResumedMessage {
  type: 'session_resumed';
  sessionId: string;
  /** 每次成功恢复后轮换的新 resume token；旧 token 立即失效。 */
  resumeToken?: string;
  /** 断线期间保留的 SFTP attach URL，供前端在恢复后重建 SFTP 数据通道。 */
  sftpAttachUrl?: string;
}
