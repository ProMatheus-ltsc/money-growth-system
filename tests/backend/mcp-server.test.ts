/**
 * MCP 传输层回归（COMP-001 工具面）：initialize / tools/list / ping / 未知方法 / 未知工具。
 * 不触网、不读凭据（只走不需要鉴权的分支）。
 */
import { describe, it, expect } from 'vitest';
import { MoneyGrowthServer, handleLine } from '../../scripts/mcp/server.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const server = new MoneyGrowthServer();

async function rpc(payload: unknown): Promise<any> {
  const out = await handleLine(server, JSON.stringify(payload));
  return out === null ? null : JSON.parse(out);
}

describe('MCP stdio 协议', () => {
  it('initialize 返回协议版本与 serverInfo', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.result.protocolVersion).toBe('2024-11-05');
    expect(res.result.serverInfo.name).toBe('money-growth-mcp');
    expect(res.result.capabilities.tools).toEqual({});
  });

  it('notifications 不产生响应；ping 返回空对象', async () => {
    expect(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' })).result).toEqual({});
  });

  it('tools/list 暴露 8 个 mg_* 工具且与注册文件一致', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const names = res.result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(8);
    const cfgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../config/money-growth-mcp.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(names.sort()).toEqual([...cfg.mcpServers['money-growth'].notes.tools].sort());
  });

  it('未知工具返回 isError + TOOL_UNAVAILABLE', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mg_drop_table', arguments: {} } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('TOOL_UNAVAILABLE');
  });

  it('mg_prepare_checklist 无需鉴权且包含 failures[]', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'mg_prepare_checklist', arguments: { items: [{ category: '餐饮' }], writePath: 'save', failures: [{ item: 'x', error: 'y' }] } },
    });
    const data = JSON.parse(res.result.content[0].text);
    expect(data.writePath).toBe('save');
    expect(data.failures).toHaveLength(1);
    expect(data.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('非 JSON 行返回 OUTPUT_INVALID；未知方法返回 TOOL_UNAVAILABLE', async () => {
    const bad = JSON.parse((await handleLine(server, 'not-json'))!);
    expect(bad.error.message).toContain('OUTPUT_INVALID');
    const unknown = await rpc({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
    expect(unknown.error.message).toContain('TOOL_UNAVAILABLE');
  });
});
