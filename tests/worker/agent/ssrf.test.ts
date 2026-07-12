import { describe, it, expect } from 'vitest';
import { validateBaseUrl } from '../../../src/worker/agent/ssrf';

// =====================================================================
// ssrf.test.ts
// ---------------------------------------------------------------
// validateBaseUrl 是 AI Agent 调用用户配置的 LLM base_url 前的安全校验：
// 防止用户把 base_url 指向内网/本机/云元数据服务，进而通过 Agent
// 构造请求走私到内网或泄露云凭据。
// 该函数是纯函数、零依赖，每条边界都用回归测试固化下来。
// =====================================================================

describe('ssrf — validateBaseUrl', () => {
  // ----- 合法 URL -----
  describe('合法 URL', () => {
    it('接受标准 https URL', () => {
      const r = validateBaseUrl('https://api.openai.com/v1');
      expect(r.valid).toBe(true);
      expect(r.reason).toBeUndefined();
    });
    it('接受标准 http URL（虽然不推荐，但允许）', () => {
      const r = validateBaseUrl('http://example.com:8080/v1');
      expect(r.valid).toBe(true);
    });
    it('接受带路径和查询参数的 https URL', () => {
      const r = validateBaseUrl('https://api.deepseek.com/v1?model=default');
      expect(r.valid).toBe(true);
    });
    it('接受大写主机名（应被 lower-case 后判断）', () => {
      const r = validateBaseUrl('https://API.OPENAI.COM/v1');
      expect(r.valid).toBe(true);
    });
    it('接受带端口号的合法外网 URL', () => {
      const r = validateBaseUrl('https://api.example.com:8443/v1');
      expect(r.valid).toBe(true);
    });
  });

  // ----- 协议白名单 -----
  describe('协议白名单', () => {
    it('拒绝 file:// 协议', () => {
      const r = validateBaseUrl('file:///etc/passwd');
      expect(r.valid).toBe(false);
      expect(r.reason).toContain('协议');
    });
    it('拒绝 ftp:// 协议', () => {
      const r = validateBaseUrl('ftp://example.com');
      expect(r.valid).toBe(false);
    });
    it('拒绝 javascript: 协议', () => {
      const r = validateBaseUrl('javascript:alert(1)');
      expect(r.valid).toBe(false);
    });
  });

  // ----- 本地地址 -----
  describe('本地地址拦截', () => {
    it('拒绝 localhost', () => {
      const r = validateBaseUrl('https://localhost/v1');
      expect(r.valid).toBe(false);
      expect(r.reason).toContain('localhost');
    });
    it('拒绝 127.0.0.1', () => {
      const r = validateBaseUrl('https://127.0.0.1/v1');
      expect(r.valid).toBe(false);
    });
    it('拒绝 ::1', () => {
      const r = validateBaseUrl('https://[::1]/v1');
      expect(r.valid).toBe(false);
    });
    it('拒绝 0.0.0.0', () => {
      const r = validateBaseUrl('https://0.0.0.0/v1');
      expect(r.valid).toBe(false);
    });
    it('拒绝带端口的 localhost', () => {
      const r = validateBaseUrl('http://localhost:3000/v1');
      expect(r.valid).toBe(false);
    });
  });

  // ----- 内网段（RFC1918 + 链路本地） -----
  describe('内网地址段拦截', () => {
    it('拒绝 10.x.x.x（A 类私有）', () => {
      expect(validateBaseUrl('https://10.0.0.1/v1').valid).toBe(false);
      expect(validateBaseUrl('https://10.255.255.255/v1').valid).toBe(false);
    });
    it('拒绝 172.16.x.x ~ 172.31.x.x（B 类私有）', () => {
      expect(validateBaseUrl('https://172.16.0.1/v1').valid).toBe(false);
      expect(validateBaseUrl('https://172.31.255.255/v1').valid).toBe(false);
      expect(validateBaseUrl('https://172.20.10.3/v1').valid).toBe(false);
    });
    it('应放行 172.32.x.x（不在 B 类私有范围内）', () => {
      // 172.32.0.0/11 不属于 172.16.0.0/12，不应该被内网规则拦截
      expect(validateBaseUrl('https://172.32.0.1/v1').valid).toBe(true);
    });
    it('应放行 172.15.x.x（不在 B 类私有范围内）', () => {
      expect(validateBaseUrl('https://172.15.0.1/v1').valid).toBe(true);
    });
    it('拒绝 192.168.x.x（C 类私有）', () => {
      expect(validateBaseUrl('https://192.168.1.1/v1').valid).toBe(false);
      expect(validateBaseUrl('https://192.168.0.100/v1').valid).toBe(false);
    });
    it('拒绝 169.254.x.x（链路本地）', () => {
      expect(validateBaseUrl('https://169.254.1.1/v1').valid).toBe(false);
    });
    it('应放行非私有的公网 IP（如 8.8.8.8）', () => {
      expect(validateBaseUrl('https://8.8.8.8/v1').valid).toBe(true);
    });
    it('应放行公网域名（如 api.openai.com）', () => {
      expect(validateBaseUrl('https://api.openai.com/v1').valid).toBe(true);
    });
  });

  // ----- 云元数据服务 -----
  describe('云元数据服务拦截', () => {
    it('拒绝 AWS/GCP 元数据服务 169.254.169.254', () => {
      // 注意：169.254.x 同时也命中"链路本地"规则；无论哪条规则命中都应拒绝
      const r = validateBaseUrl('https://169.254.169.254/latest/meta-data/');
      expect(r.valid).toBe(false);
    });
    it('拒绝 GCP metadata.google.internal', () => {
      const r = validateBaseUrl('https://metadata.google.internal/computeMetadata/v1/');
      expect(r.valid).toBe(false);
    });
  });

  // ----- 非法格式 -----
  describe('非法 URL 格式', () => {
    it('拒绝空字符串', () => {
      expect(validateBaseUrl('').valid).toBe(false);
    });
    it('拒绝非 URL 字符串（无协议）', () => {
      expect(validateBaseUrl('not-a-url').valid).toBe(false);
    });
    it('拒绝只有协议没有主机', () => {
      expect(validateBaseUrl('https://').valid).toBe(false);
    });
    it('拒绝包含空格的非法 URL', () => {
      expect(validateBaseUrl('https://example .com/v1').valid).toBe(false);
    });
  });

  // ----- reason 字段格式 -----
  it('拒绝时应返回非空中文 reason', () => {
    const r = validateBaseUrl('https://localhost/v1');
    expect(r.valid).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect(r.reason!.length).toBeGreaterThan(0);
  });
});
