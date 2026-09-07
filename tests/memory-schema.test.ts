import { describe, expect, it } from 'vitest';
import {
  containsSensitiveData,
  MAX_SERVER_MEMORIES,
  MEMORY_KEY_MAX_LENGTH,
  MEMORY_VALUE_MAX_LENGTH,
  normalizeMemoryInput,
  VALID_MEMORY_CATEGORIES,
  VALID_MEMORY_SOURCES,
} from '../src/memory-schema';

describe('memory-schema', () => {
  it('exports expected constants', () => {
    expect(MAX_SERVER_MEMORIES).toBe(20);
    expect(MEMORY_KEY_MAX_LENGTH).toBe(64);
    expect(MEMORY_VALUE_MAX_LENGTH).toBe(512);
    expect(VALID_MEMORY_CATEGORIES).toEqual(['path', 'service', 'env', 'rule', 'custom']);
    expect(VALID_MEMORY_SOURCES).toEqual(['auto', 'manual']);
  });

  describe('containsSensitiveData', () => {
    it('detects sensitive keys', () => {
      expect(containsSensitiveData('root_password', '/var/log')).toBe(true);
      expect(containsSensitiveData('api_key', 'some-value')).toBe(true);
      expect(containsSensitiveData('auth_token', '12345')).toBe(true);
      expect(containsSensitiveData('client_secret', 'secret')).toBe(true);
      expect(containsSensitiveData('server_private_key', 'key')).toBe(true);
    });

    it('detects sensitive values', () => {
      expect(
        containsSensitiveData('ssh_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----')
      ).toBe(true);
      expect(containsSensitiveData('db_conf', 'password=mypassword123')).toBe(true);
      expect(containsSensitiveData('auth_header', 'Bearer abcdef1234567890123456')).toBe(true);
      expect(containsSensitiveData('ai_token', 'sk-123456789012345678901234')).toBe(true);
      expect(containsSensitiveData('git_token', 'ghp_123456789012345678901234')).toBe(true);
    });

    it('passes safe keys and values', () => {
      expect(containsSensitiveData('web_root', '/var/www/html')).toBe(false);
      expect(containsSensitiveData('nginx_conf', '/etc/nginx/nginx.conf')).toBe(false);
      expect(containsSensitiveData('container_runtime', 'podman')).toBe(false);
      expect(containsSensitiveData('restart_rule', '重启前必须执行 nginx -t 测试语法')).toBe(false);
      expect(containsSensitiveData('os_version', 'Ubuntu 24.04 LTS')).toBe(false);
    });
  });

  describe('normalizeMemoryInput', () => {
    it('rejects missing or empty keys and values', () => {
      expect(normalizeMemoryInput({})).toEqual({ ok: false, error: 'keyRequired' });
      expect(normalizeMemoryInput({ fact_key: '   ' })).toEqual({ ok: false, error: 'keyRequired' });
      expect(normalizeMemoryInput({ fact_key: 'web_root' })).toEqual({ ok: false, error: 'valueRequired' });
      expect(normalizeMemoryInput({ fact_key: 'web_root', fact_value: '   ' })).toEqual({
        ok: false,
        error: 'valueRequired',
      });
    });

    it('rejects keys exceeding maximum length', () => {
      const longKey = 'a'.repeat(65);
      expect(normalizeMemoryInput({ fact_key: longKey, fact_value: '/var/www' })).toEqual({
        ok: false,
        error: 'keyTooLong',
      });
    });

    it('rejects values exceeding maximum length', () => {
      const longVal = 'v'.repeat(513);
      expect(normalizeMemoryInput({ fact_key: 'web_root', fact_value: longVal })).toEqual({
        ok: false,
        error: 'valueTooLong',
      });
    });

    it('rejects sensitive credentials', () => {
      expect(
        normalizeMemoryInput({
          fact_key: 'db_pass',
          fact_value: 'password=supersecret',
        })
      ).toEqual({ ok: false, error: 'sensitiveDataDetected' });
    });

    it('normalizes valid input with defaults', () => {
      const result = normalizeMemoryInput({
        fact_key: '  web_root  ',
        fact_value: '  /data/www  ',
      });
      expect(result).toEqual({
        ok: true,
        value: {
          category: 'custom',
          fact_key: 'web_root',
          fact_value: '/data/www',
          source: 'manual',
        },
      });
    });

    it('accepts explicitly valid categories and sources', () => {
      const result = normalizeMemoryInput({
        category: 'path',
        fact_key: 'nginx_conf',
        fact_value: '/etc/nginx/nginx.conf',
        source: 'auto',
      });
      expect(result).toEqual({
        ok: true,
        value: {
          category: 'path',
          fact_key: 'nginx_conf',
          fact_value: '/etc/nginx/nginx.conf',
          source: 'auto',
        },
      });
    });
  });
});
