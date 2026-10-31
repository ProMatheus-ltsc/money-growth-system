/**
 * 运行时兼容回归（S7 BLOCKER）：MCP server 必须能在 Node strip-only 模式启动
 * （Node 22.18+ 默认类型擦除；参数属性等非可擦除语法会直接启动失败）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runNode(args: string[]) {
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
}

describe('Node strip-only 启动兼容', () => {
  it('--experimental-strip-types 可导入 server.ts（无可擦除性语法错误）', () => {
    const probe = runNode(['--experimental-strip-types', '-e', "await import('./scripts/mcp/server.ts')"]);
    const unsupported = /bad option|unknown option/i.test(`${probe.stderr}${probe.stdout}`);
    if (unsupported) {
      // 旧版 Node 无该开关：跳过（CI 使用 Node 22.18+ 会实际执行）
      expect(true).toBe(true);
      return;
    }
    expect(probe.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|TypeScript.*not supported/i);
    expect(probe.status).toBe(0);
  });

  it('源码中不出现参数属性（constructor(public readonly ...)）', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['scripts/mcp/api-client.ts', 'scripts/mcp/fx.ts', 'scripts/mcp/server.ts', 'scripts/mcp/schema.ts']) {
      const text = readFileSync(resolve(repoRoot, file), 'utf8');
      expect(text).not.toMatch(/constructor\s*\(\s*(public|private|protected|readonly)\s/);
    }
  });
});
