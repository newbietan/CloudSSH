import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { enUS } from '../frontend/src/i18n/locales/en-US';
import { zhCN } from '../frontend/src/i18n/locales/zh-CN';
import { getAlternateLocale, normalizeLocale, resolveLocale, setLocale, t } from '../frontend/src/i18n';
import { getResponseLanguageInstruction } from '../src/worker/agent/prompt';

describe('国际化核心', () => {
  it('中英文语言包的键完全一致', () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
  });

  it('按 URL、持久化设置、浏览器语言的优先级解析语言', () => {
    expect(resolveLocale({
      urlLocale: 'en',
      storedLocale: 'zh-CN',
      browserLocales: ['zh-CN'],
    })).toBe('en-US');
    expect(resolveLocale({ storedLocale: 'en_US', browserLocales: ['zh-CN'] })).toBe('en-US');
    expect(resolveLocale({ browserLocales: ['fr-FR', 'en-GB'] })).toBe('en-US');
    expect(resolveLocale({ browserLocales: ['fr-FR'] })).toBe('zh-CN');
  });

  it('归一化受支持的语言并拒绝未知语言', () => {
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(normalizeLocale('en-GB')).toBe('en-US');
    expect(normalizeLocale('ja-JP')).toBeNull();
  });

  it('语言按钮始终指向另一种语言', () => {
    expect(getAlternateLocale('zh-CN')).toBe('en-US');
    expect(getAlternateLocale('en-US')).toBe('zh-CN');
  });

  it('切换词典并插值参数', () => {
    setLocale('en-US', { persist: false });
    expect(t('terminal.connectionClosed', { code: 1000 })).toBe('Connection closed (code=1000)');
    setLocale('zh-CN', { persist: false });
    expect(t('terminal.connectionClosed', { code: 1000 })).toBe('连接已关闭（代码=1000）');
  });
});

describe('Agent 响应语言', () => {
  it('根据界面语言生成明确且不改变命令内容的语言指令', () => {
    expect(getResponseLanguageInstruction('en-US')).toContain('Respond in English');
    expect(getResponseLanguageInstruction('zh-CN')).toContain('使用简体中文回答');
    expect(getResponseLanguageInstruction('en-US')).toContain('commands');
  });
});

describe('语言切换入口', () => {
  it('仅在连接页和服务器列表展示，终端会话中不允许切换', () => {
    const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
    const terminalSection = html.slice(html.indexOf('<div id="terminal-section"'));
    const beforeTerminal = html.slice(0, html.indexOf('<div id="terminal-section"'));

    expect(beforeTerminal.match(/data-language-switcher/g)).toHaveLength(2);
    expect(terminalSection).not.toContain('data-language-switcher');
    expect(beforeTerminal).not.toContain('data-language-select');
  });
});
