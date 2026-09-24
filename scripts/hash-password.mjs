#!/usr/bin/env node
/**
 * CloudSSH 单管理员密码登录 —— ADMIN_PASSWORD_HASH 生成器。
 *
 * 产出格式（与服务端 parseAdminPasswordHash、浏览器 password-stretch.ts 三方对齐）：
 *   pbkdf2$sha256$<iterations>$<salt-b64url>$<verifier-b64url>
 * 其中 verifier = SHA-256(PBKDF2-HMAC-SHA256(password, salt, iterations))
 *
 * 浏览器登录时用相同参数在本地预拉伸（server relief，规避 Workers Free 套餐
 * 10ms CPU 上限），服务端仅做一次 SHA-256 + 恒时比对，原始密码永不落网。
 *
 * 用法：
 *   pnpm run hash-password                       # 交互式（隐藏输入，二次确认）
 *   pnpm run hash-password -- --stdin            # 从 stdin 读一行（CI/脚本）
 *   pnpm run hash-password -- --iterations 300000
 *   pnpm run hash-password -- --min-length 12
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const DEFAULT_ITERATIONS = 600000; // OWASP 2023 对 PBKDF2-HMAC-SHA256 的推荐下限
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 10_000_000;
const DEFAULT_MIN_LENGTH = 10;
const SALT_BYTES = 16;
const STRETCHED_KEY_BYTES = 32;

function parseArgs(argv) {
  const args = { stdin: false, iterations: DEFAULT_ITERATIONS, minLength: DEFAULT_MIN_LENGTH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stdin') {
      args.stdin = true;
    } else if (arg === '--iterations') {
      const value = Number(argv[i + 1]);
      if (
        !Number.isSafeInteger(value) ||
        value < MIN_ITERATIONS ||
        value > MAX_ITERATIONS
      ) {
        console.error(
          `错误：--iterations 需为 ${MIN_ITERATIONS}-${MAX_ITERATIONS} 之间的整数`
        );
        process.exit(1);
      }
      args.iterations = value;
      i++;
    } else if (arg === '--min-length') {
      const value = Number(argv[i + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 256) {
        console.error('错误：--min-length 需为 1-256 之间的整数');
        process.exit(1);
      }
      args.minLength = value;
      i++;
    } else {
      console.error(`未知参数：${arg}`);
      console.error('用法：pnpm run hash-password [-- --stdin] [-- --iterations N] [-- --min-length N]');
      process.exit(1);
    }
  }
  return args;
}

/** 交互式读取密码（输入不回显，Ctrl+C 退出） */
async function promptPassword(rl, label) {
  stdout.write(`${label}: `);
  // 关闭回显：muted 写入空字符串
  const originalWrite = stdout.write.bind(stdout);
  stdout.write = (chunk) => {
    if (typeof chunk === 'string' && chunk.includes('\n')) return originalWrite('\n');
    return true;
  };
  try {
    const answer = await rl.question('');
    return answer;
  } finally {
    stdout.write = originalWrite;
  }
}

async function readPasswordFromStdin() {
  let data = '';
  for await (const chunk of stdin) data += chunk;
  // 取第一行，去 BOM 与行尾
  const line = data.replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? '';
  return line;
}

function bytesToB64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function deriveVerifier(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const stretched = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, baseKey, STRETCHED_KEY_BYTES * 8)
  );
  const verifier = new Uint8Array(await crypto.subtle.digest('SHA-256', stretched));
  return { stretched, verifier };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let password;
  if (args.stdin) {
    password = await readPasswordFromStdin();
  } else {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      password = await promptPassword(rl, '请输入管理员密码');
      const confirm = await promptPassword(rl, '请再次输入确认');
      if (password !== confirm) {
        console.error('错误：两次输入不一致');
        process.exit(1);
      }
    } finally {
      rl.close();
    }
  }

  if (password.length < args.minLength) {
    console.error(`错误：密码长度至少 ${args.minLength} 位（当前 ${password.length} 位）`);
    process.exit(1);
  }
  if (password.length > 1024) {
    console.error('错误：密码长度不能超过 1024 位');
    process.exit(1);
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const { verifier } = await deriveVerifier(password, salt, args.iterations);

  const hash = `pbkdf2$sha256$${args.iterations}$${bytesToB64url(salt)}$${bytesToB64url(verifier)}`;

  console.log('\nADMIN_PASSWORD_HASH（粘贴到 Cloudflare Dashboard → Workers → 变量，或 wrangler secret put）：\n');
  console.log(hash);
  console.log(`
说明：
- 将上面的完整字符串配置为环境变量 ADMIN_PASSWORD_HASH 即启用单管理员密码模式
- 删除该变量（或置空）即刻退回 GitHub OAuth 登录，GitHub 数据不受影响
- 换新值 = 修改密码：所有已登录会话将立即失效
- 改密码重新生成即可；原始密码不会被本脚本保存`);
}

main().catch((err) => {
  console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
