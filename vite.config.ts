import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// @shared/core 以 file: 依赖接入（RCA 模式，04 §3.8 V1.2）：
// - package.json: "@shared/core": "file:../shared-core"（兄弟目录 junction/拷贝）
// - vite alias '@shared/core' → ../shared-core/src（主入口）
// - '@shared/core/<子路径>' 按上游 exports 映射；Vite/esbuild 直接编译其 TS 源码。
// - echarts 子路径同样 alias 到本项目 node_modules（共享源码位于仓库外，无法向上解析）。
// 构建依赖：父目录须存在 shared-core（本地 junction；CI 先 clone，仿 root-cause-analysis deploy.yml）。
const vendorSrc = fileURLToPath(new URL('../shared-core/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 防双 React：共享包（../shared-core）自身 node_modules 含 react 副本，
    // 共享源码 import 'react' 若不强制去重会打包两份 → hooks dispatcher null 白屏（S5 经验）
    dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom', 'react-hook-form'],
    alias: [
      { find: /^@shared\/core$/, replacement: `${vendorSrc}/index.ts` },
      { find: /^@shared\/core\/(.+)$/, replacement: `${vendorSrc}/$1` },
      { find: /^echarts\/(core|charts|components|renderers)$/, replacement: path.resolve(__dirname, 'node_modules/echarts/$1') },
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
