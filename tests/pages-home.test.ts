import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const homeHtml = readFileSync(resolve(root, 'docs/index.html'), 'utf8');
const homeScript = readFileSync(resolve(root, 'docs/assets/home.js'), 'utf8');
const homeStyles = readFileSync(resolve(root, 'docs/assets/home.css'), 'utf8');
const changelogMarkdown = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const changelogDataScript = readFileSync(resolve(root, 'docs/assets/changelog-data.js'), 'utf8');
const pagesWorkflow = readFileSync(resolve(root, '.github/workflows/github-pages.yml'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const deploymentSection = homeHtml.slice(
  homeHtml.indexOf('<section class="section shell deploy-section"'),
  homeHtml.indexOf('<section class="section changelog-section"'),
);

describe('GitHub Pages 项目主页', () => {
  it('使用独立主页并保留所有核心入口', () => {
    expect(homeHtml).not.toContain('http-equiv="refresh"');
    expect(homeHtml).toContain('https://ssh.newbietan.cn');
    expect(homeHtml).toContain('https://sshtest.newbietan.cn');
    expect(homeHtml).toContain('href="https://cte.newbietan.cn/theme-editor/"');
    expect(homeHtml).not.toContain('href="theme-editor/"');
    expect(homeHtml).toContain('https://github.com/newbietan/CloudSSH');
    expect(homeHtml).toContain('data-i18n="capability.privacyText"');
  });

  it('通过 B 站播放器直接嵌入演示视频并提供外部回退链接', () => {
    expect(homeHtml).toContain('https://player.bilibili.com/player.html?bvid=BV1UgMt6UEdF');
    expect(homeHtml).toContain('https://www.bilibili.com/video/BV1UgMt6UEdF');
    expect(homeHtml).toContain('allowfullscreen');
    expect(homeHtml).toContain('referrerpolicy="strict-origin-when-cross-origin"');
  });

  it('提供赛博朋克风格的可展开完整 README 资料库', () => {
    expect(homeHtml).toContain('<details class="docs-vault reveal">');
    expect(homeHtml.match(/class="doc-module"/g)?.length).toBeGreaterThanOrEqual(10);
    expect(homeHtml).toContain('完整功能清单');
    expect(homeHtml).toContain('SSH-2.0 算法矩阵');
    expect(homeHtml).toContain('AUTO_SYNC_UPSTREAM=true');
    expect(homeHtml).toContain('TURNSTILE_SECRET');
    expect(homeHtml).toContain('GITHUB_CLIENT_SECRET');
    expect(homeHtml).toContain('CLOUDFLARE_API_TOKEN');
    expect(homeHtml).toContain('Hibernation API');
    expect(homeHtml).toContain('SSRF');
    expect(homeHtml).toContain('Apache License 2.0');
    expect(homeHtml).toContain('data-locale-copy="zh-CN"');
    expect(homeHtml).toContain('data-locale-copy="en-US"');
    expect(homeStyles).toContain('--magenta: #ff2bd6');
    expect(homeStyles).toContain('.docs-vault');
    expect(homeStyles).toContain('font-size: 17px');
  });

  it('在主页内直接提供完整的双语部署教程而不是跳转 README', () => {
    expect(deploymentSection).toContain('class="deploy-manual reveal"');
    expect(deploymentSection.match(/class="deploy-guide(?: deploy-guide--warning)?" open/g)?.length).toBe(12);
    expect(deploymentSection).toContain('pnpm run build:frontend');
    expect(deploymentSection).toContain('pnpm run deploy:test');
    expect(deploymentSection).toContain('AUTO_SYNC_UPSTREAM=true');
    expect(deploymentSection).toContain('TURNSTILE_SECRET');
    expect(deploymentSection).toContain('GITHUB_CLIENT_SECRET');
    expect(deploymentSection).toContain('/api/auth/callback');
    expect(deploymentSection).toContain('npx wrangler secret set');
    expect(deploymentSection).toContain('cloudssh-test');
    expect(deploymentSection).toContain('migration tag');
    expect(deploymentSection).toContain('data-locale-copy="zh-CN"');
    expect(deploymentSection).toContain('data-locale-copy="en-US"');
    expect(deploymentSection).not.toContain('github.com/newbietan/CloudSSH#quick-start');
    expect(homeStyles).toContain('.deploy-manual');
    expect(homeStyles).toContain('.deploy-variable-grid');
  });

  it('从 CHANGELOG.md 自动生成主页版本时间线', () => {
    const payload = changelogDataScript
      .replace(/^.*window\.CLOUDSSH_CHANGELOG = /s, '')
      .replace(/;\s*$/, '');
    const changelogData = JSON.parse(payload);
    const changelogVersions = [...changelogMarkdown.matchAll(/^## \[([^\]]+)] - \d{4}-\d{2}-\d{2}$/gm)]
      .map((match) => match[1]);

    expect(homeHtml).toContain('id="changelog"');
    expect(homeHtml).toContain('src="assets/changelog-data.js"');
    expect(homeScript).toContain('window.CLOUDSSH_CHANGELOG?.releases');
    expect(changelogData.releases.map((release: { version: string }) => release.version)).toEqual(changelogVersions);
    expect(changelogData.releases[0].version).toBe(packageJson.version);
    expect(pagesWorkflow).toContain("- 'CHANGELOG.md'");
    expect(pagesWorkflow).toContain('node scripts/sync-pages-changelog.js');
    expect(existsSync(resolve(root, 'scripts/sync-pages-changelog.js'))).toBe(true);
  });

  it('为主页的所有本地化文本提供中英文翻译', () => {
    const keys = [...homeHtml.matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g)]
      .map((match) => match[1]);
    const locales = ['zh-CN', 'en-US'];

    expect(new Set(keys).size).toBeGreaterThan(90);
    locales.forEach((locale, index) => {
      const start = homeScript.indexOf(`'${locale}': {`);
      const end = index < locales.length - 1
        ? homeScript.indexOf(`  '${locales[index + 1]}': {`)
        : homeScript.indexOf('\n  }\n};', start);
      const dictionary = homeScript.slice(start, end);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      keys.forEach((key) => expect(dictionary, `${locale} 缺少 ${key}`).toContain(`'${key}':`));
    });

    expect(homeScript).toContain("url.searchParams.set('lang'");
    expect(homeScript).toContain("localStorage.setItem(localeStorageKey, locale)");
  });

  it('本地资源完整且响应式样式尊重减少动效偏好', () => {
    expect(existsSync(resolve(root, 'docs/assets/home.css'))).toBe(true);
    expect(existsSync(resolve(root, 'docs/assets/home.js'))).toBe(true);
    expect(existsSync(resolve(root, 'docs/assets/changelog-data.js'))).toBe(true);
    expect(existsSync(resolve(root, 'docs/assets/og-cloudssh.png'))).toBe(true);
    expect(existsSync(resolve(root, 'scripts/build-pages-og.js'))).toBe(true);
    expect(existsSync(resolve(root, 'docs/theme-editor/favicon.svg'))).toBe(true);
    expect(homeHtml).toContain('https://newbietan.github.io/CloudSSH/assets/og-cloudssh.png');
    expect(homeStyles).toContain('@media (max-width: 760px)');
    expect(homeStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(homeHtml).toContain('<noscript><style>.reveal { opacity: 1; transform: none; }</style></noscript>');
  });

  it('中英文 README 保持精简并统一引导到项目主页', () => {
    const chineseReadme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const englishReadme = readFileSync(resolve(root, 'README_en.md'), 'utf8');

    expect(chineseReadme).toContain('https://newbietan.github.io/CloudSSH/?lang=zh-CN');
    expect(englishReadme).toContain('https://newbietan.github.io/CloudSSH/?lang=en-US');
    expect(chineseReadme).toContain('https://cte.newbietan.cn/theme-editor/');
    expect(englishReadme).toContain('https://cte.newbietan.cn/theme-editor/');
    expect(chineseReadme.split('\n').length).toBeLessThan(220);
    expect(englishReadme.split('\n').length).toBeLessThan(220);
  });
});
