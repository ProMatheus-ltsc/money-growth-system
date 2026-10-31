/**
 * Vitest 独立配置（COMP-005）：只跑 tests/ 下的回归保护用例，node 环境、不依赖浏览器。
 * 测试仅引用纯模块（backend/lib 与 scripts/mcp），不触发 D1/Cloudflare 运行时。
 * 运行：npm test（= vitest run --config config/vitest.config.ts）
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['backend/lib/**/*.ts', 'backend/services/**/*.ts', 'scripts/mcp/**/*.ts'],
      thresholds: { lines: 60 },
    },
  },
});
