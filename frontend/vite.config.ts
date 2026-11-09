import { defineConfig, normalizePath } from 'vite';
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
      // Worker 不提供独立字体路由：即使子集增长，也必须内联这两个字体。
      // 其他资源保留 Vite 默认阈值，不扩大全局内联范围。
      assetsInlineLimit: (filePath) =>
        /\/src\/assets\/fonts\/(?:material-symbols-outlined-subset|jetbrains-mono)\.woff2$/.test(
          normalizePath(filePath)
        )
          ? true
          : undefined,
      modulePreload: {
        polyfill: false,
      },
    },
  };
});
