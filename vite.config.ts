import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// @shared/core 以 vendor 源码集成（04 §3.8）：
// - '@shared/core'      → vendor/shared-core/src/index.ts（主入口）
// - '@shared/core/<子路径>' → vendor/shared-core/src/<子路径>（逐模块子路径，与上游 exports 对齐）
// Vite/esbuild 直接编译其 TS 源码；构建期零外网拉取。
const vendorSrc = fileURLToPath(new URL('./vendor/shared-core/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@shared\/core$/, replacement: `${vendorSrc}/index.ts` },
      { find: /^@shared\/core\/(.+)$/, replacement: `${vendorSrc}/$1` },
    ],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
  },
});
