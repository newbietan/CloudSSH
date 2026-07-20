import { defineConfig } from 'vite';

export default defineConfig({
  // @xterm/xterm 6 ships pre-minified ESM. Re-running esbuild's syntax
  // minifier can drop a declaration in InputHandler.requestMode, causing
  // DECRQM queries from Vim and other TUIs to throw and stop terminal input.
  // Keep the other minification passes enabled while avoiding that transform.
  // https://github.com/xtermjs/xterm.js/issues/5800
  esbuild: {
    minifySyntax: false,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: {
      polyfill: false,
    },
  },
});
