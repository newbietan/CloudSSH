import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// =====================================================================
// admin-password-entry.test.ts
// ---------------------------------------------------------------
// 单管理员密码登录「生成器入口」模式感知契约（AGENTS.md #39）：
//   1. 页脚入口仅匿名模式（未配置任何登录方式）渲染 —— GitHub 模式
//      （含 REQUIRE_GITHUB_AUTH 强制面板）一律隐藏，既有用户升级后
//      界面零变化；
//   2. #password-setup URL 路由全模式可用（消费后清地址栏），承接
//      GitHub 实例切换与密码轮换；
//   3. 坏哈希面板保留「重新生成」修复入口。
// =====================================================================

const authFormSource = readFileSync(
  new URL('../frontend/src/auth-form.ts', import.meta.url),
  'utf8'
);
const mainSource = readFileSync(new URL('../frontend/src/main.ts', import.meta.url), 'utf8');

describe('管理员密码生成器入口 — 模式感知契约', () => {
  it('页脚入口仅匿名模式渲染（GitHub 模式隐藏，升级零感知）', () => {
    // 入口渲染必须以 authMode === 'anonymous' 为门（GitHub/密码模式不显示）
    expect(authFormSource).toContain('if (config.authMode === \'anonymous\') {');
    expect(authFormSource).toContain('this.renderAdminHashGenEntry();');
    // 门内紧跟入口调用（防止门与调用脱钩变成无效守卫）
    const gateIndex = authFormSource.indexOf("if (config.authMode === 'anonymous') {");
    const entryIndex = authFormSource.indexOf('this.renderAdminHashGenEntry();');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(entryIndex).toBeGreaterThan(gateIndex);
    expect(entryIndex - gateIndex).toBeLessThan(200);
  });

  it('GitHub 强制登录面板不含生成器入口（GitHub 模式一律隐藏）', () => {
    expect(authFormSource).toContain('renderGitHubAuthRequired');
    expect(authFormSource).not.toContain('admin-hash-gen-entry-btn');
  });

  it('#password-setup 路由全模式可用，且加载与同页 hash 导航两条路径都能消费', () => {
    expect(mainSource).toContain("window.location.hash !== '#password-setup'");
    expect(mainSource).toContain('function consumeAdminSetupRoute');
    expect(mainSource).toContain('history.replaceState');
    expect(mainSource).toContain('openAdminHashGeneratorDialog();');
    expect(mainSource).toContain("openAdminHashGeneratorDialog } from './admin-hash-generator'");
    // 同页 hash 导航不触发重载：必须有 hashchange 监听（地址栏粘贴同页带 hash URL 可达）
    expect(mainSource).toContain("window.addEventListener('hashchange', consumeAdminSetupRoute)");
  });

  it('坏哈希面板保留「重新生成」修复入口', () => {
    expect(authFormSource).toContain('admin-hash-regen-btn');
    expect(authFormSource).toContain("from './admin-hash-generator'");
  });
});
