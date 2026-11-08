import { defineConfig } from 'vite';
import { e2eApiIsolation } from './e2e-server';

export default defineConfig(({ mode }) => {
  const isE2E = process.env.E2E_TEST === 'true' || mode === 'e2e';

  return {
    // @xterm/xterm 6 ships pre-minified ESM. Re-running esbuild's syntax
    // minifier can drop a declaration in InputHandler.requestMode, causing
    // DECRQM queries from Vim and other TUIs to throw and stop terminal input.
    // Keep the other minification passes enabled while avoiding that transform.
    // https://github.com/xtermjs/xterm.js/issues/5800
    esbuild: {
      minifySyntax: false,
    },
    plugins: isE2E ? [e2eApiIsolation()] : [],
    server: {
      // 本地全栈开发代理到 wrangler；E2E 不启动后端，API 由自动 fixture 拦截。
      // 漏网请求由 E2E 专用中间件返回带标记的 501 JSON，绝不落入 SPA HTML 回退。
      proxy: isE2E
        ? undefined
        : {
            '/api': {
              target: 'http://localhost:8787',
              ws: true,
            },
          },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // 本地字体（Material Symbols 裁剪版 + JetBrains Mono）以 base64
      // 内联进 CSS，以便 scripts/build-html.js 把整份 CSS 内联进 Worker 的 html.ts。
      // 当前 Worker 未配置静态资源服务，public/ 字体不会随 Worker 发布，字体必须放
      // frontend/src/assets/ 并走 Vite 资源管线，不能放 public/。
      assetsInlineLimit: 100 * 1024,
      modulePreload: {
        polyfill: false,
      },
    },
  };
});
