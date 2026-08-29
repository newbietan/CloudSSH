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

  it('英文 SFTP 工具栏使用紧凑操作标签', () => {
    expect(enUS['sftp.uploadAction']).toBe('UPLOAD');
    expect(enUS['sftp.mkdirAction']).toBe('MKDIR');
    expect(enUS['sftp.downloadAction']).toBe('DOWNLOAD');
    expect(enUS['sftp.deleteAction']).toBe('DELETE');
    expect(enUS['sftp.renameAction']).toBe('RENAME');
    expect(enUS['sftp.upload']).toBe('Upload file');
    expect(enUS['sftp.newFolder']).toBe('New folder');
  });

  it('SFTP 右键菜单提供完整的中英文翻译', () => {
    expect(zhCN['sftp.contextOpen']).toBe('打开');
    expect(zhCN['sftp.contextDownload']).toBe('下载');
    expect(zhCN['sftp.contextRename']).toBe('重命名');
    expect(zhCN['sftp.contextDelete']).toBe('删除');
    expect(enUS['sftp.contextOpen']).toBe('Open');
    expect(enUS['sftp.contextDownload']).toBe('Download');
    expect(enUS['sftp.contextRename']).toBe('Rename');
    expect(enUS['sftp.contextDelete']).toBe('Delete');
  });

  it('SFTP 右键菜单不再硬编码展示文案', () => {
    const source = readFileSync(new URL('../frontend/src/sftp-panel.ts', import.meta.url), 'utf8');
    expect(source).toContain("label: t('sftp.contextOpen')");
    expect(source).toContain("label: t('sftp.contextDownload')");
    expect(source).toContain("label: t('sftp.contextRename')");
    expect(source).toContain("label: t('sftp.contextDelete')");
    expect(source).not.toMatch(/label:\s*'(?:Open|Download|Rename|Delete)'/);
  });

  it('SFTP 连接、传输和统计状态均通过语言包展示', () => {
    const source = readFileSync(new URL('../frontend/src/sftp-panel.ts', import.meta.url), 'utf8');
    for (const key of [
      'sftp.reconnecting',
      'sftp.waitingWebSocket',
      'sftp.invalidResponse',
      'sftp.websocketError',
      'sftp.connectionClosed',
      'sftp.uploading',
      'sftp.downloading',
      'sftp.uploadFailed',
      'sftp.downloadFailed',
      'sftp.uploadCancelled',
      'sftp.downloadCancelled',
      'sftp.renamed',
      'sftp.queuedUpload',
      'sftp.queuedDownload',
      'sftp.itemCounts',
      'sftp.items',
    ]) {
      expect(source).toMatch(new RegExp(`t\\s*\\(\\s*['\"]${key}['\"]`));
    }
    expect(source).not.toMatch(
      /'(?:Reconnecting SFTP|Waiting for SFTP|Invalid SFTP response|Upload failed:|Download failed:|Uploading:|Downloading:|Upload cancelled|Download cancelled|Renamed)'/,
    );
  });

  it('SFTP 同名覆盖确认提供完整中英文文案', () => {
    expect(zhCN['sftp.overwriteTitle']).toBe('覆盖同名文件');
    expect(zhCN['sftp.overwriteMessage']).toContain('{existingSize}');
    expect(zhCN['sftp.overwriteMessage']).toContain('{newSize}');
    expect(enUS['sftp.overwriteTitle']).toBe('Overwrite existing file');

    const source = readFileSync(new URL('../frontend/src/sftp-panel.ts', import.meta.url), 'utf8');
    expect(source).toContain("title: t('sftp.overwriteTitle')");
    expect(source).toContain("confirmText: t('sftp.overwrite')");
    // 默认上传必须先以非覆盖探测，确认后才以覆盖重发；编辑器保存路径显式声明 overwriteFirst
    expect(source).toContain('overwriteFirst: boolean = false');
    expect(source).toContain('overwrite: overwriteFirst');
    expect(source).toContain('overwrite: true');
    expect(source).toContain('overwriteFirst: true');
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

describe('主题在线编辑器国际化', () => {
  const html = readFileSync(new URL('../docs/theme-editor/index.html', import.meta.url), 'utf8');
  const currentProjectUi = [
    readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8'),
    readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8'),
    readFileSync(new URL('../frontend/src/server-list.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../frontend/src/tab-manager.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../frontend/src/agent/agent-panel.ts', import.meta.url), 'utf8'),
  ].join('\n');

  it('与主项目共用语言偏好，并支持 URL、持久化设置和浏览器语言', () => {
    expect(html).toContain("const LOCALE_STORAGE_KEY = 'cloudssh_locale'");
    expect(html).toContain("new URLSearchParams(window.location.search).get('lang')");
    expect(html).toContain('navigator.languages');
    expect(html).toContain('id="language-toggle"');
  });

  it('提供完整的中英文词典和目标语言按钮', () => {
    expect(html).toContain("'zh-CN': {");
    expect(html).toContain("'en-US': {");
    expect(html).toContain("'language.switchTo': '切换到{language}'");
    expect(html).toContain("'language.switchTo': 'Switch to {language}'");
    expect(html).toContain('data-language-preview-label');
  });

  it('同步最新终端和 SFTP 预览，并使用非阻塞反馈', () => {
    expect(html).toContain('class="terminal-appbar"');
    expect(html).toContain('data-i18n="sftp.renameAction"');
    expect(html).toContain("'--scrollbar-thumb-hover'");
    expect(html).toContain('id="toast-region"');
    expect(html).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  });

  it('同步服务器搜索、区域、网络质量、终端选区和 Agent 代码块 UI', () => {
    for (const marker of [
      'server.searchPlaceholder',
      'server.regionLabel',
      'network-quality-dot',
      'ask-ai-selection',
      'agent-md-code-block',
      'agent-md-code-action',
    ]) {
      expect(currentProjectUi).toContain(marker);
      expect(html).toContain(marker);
    }

    expect(html).toContain('data-i18n="terminal.askAISelection"');
    expect(html).toContain('data-i18n="agent.codeFill"');
    expect(html).toContain('<option value="standard-dark">Standard Dark</option>');
    expect(html).toContain('<option value="standard-light">Standard Light</option>');
    expect(html).toContain("select.addEventListener('change', (event) => initTheme(event.target.value))");
  });
});
