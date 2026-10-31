/**
 * money-growth MCP stdio server（COMP-001 入口）。
 * 轻量 JSON-RPC 2.0 逐行协议（initialize / tools/list / tools/call），无外部依赖，
 * 便于站点 typecheck 直接通过；工具实现全部委托 api-client / fx / idempotency。
 *
 * 安全边界（REQ-006 与 04-contracts §1.1）：
 * - 工具入参绝不接受凭据；凭据仅从进程 env / 仓库外 env 文件读取。
 * - 出站只允许 MGS_URL 主机 + 两个免费汇率源主机。
 * - 无 DELETE 能力；单工具调用超时 20s；写操作幂等，命中不重复写。
 *
 * 运行：node --experimental-strip-types scripts/mcp/server.ts（由 config/money-growth-mcp.json 注册）
 */
import { createInterface } from 'node:readline';
import { MgsClient, defaultFetch, loadCredentials, decideWritePath, withinCorrectWindow, buildSiteBody } from './api-client.ts';
import { FxService } from './fx.ts';
import { idempotencyKey, IdempotencyLedger, payloadFingerprint } from './idempotency.ts';
import { currentMonth } from '../../backend/lib/month.ts';

const TOOLS = [
  { name: 'mg_verify_auth', description: '三步鉴权探活，返回角色/掩码账户/令牌到期', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'mg_get_snapshot', description: '读取指定月快照原始 JSON', inputSchema: { type: 'object', required: ['month'], properties: { month: { type: 'string' } } } },
  { name: 'mg_check_lock_window', description: '判定锁定与纠错窗口', inputSchema: { type: 'object', required: ['month'], properties: { month: { type: 'string' } } } },
  { name: 'mg_save_snapshot', description: '保存当月快照（分整数载荷，幂等键去重）', inputSchema: { type: 'object', required: ['month', 'payload', 'idempotencyKey'], properties: { month: { type: 'string' }, payload: { type: 'object' }, idempotencyKey: { type: 'string' } } } },
  { name: 'mg_correct_snapshot', description: '纠错窗口内锁定月快照', inputSchema: { type: 'object', required: ['month', 'patch', 'idempotencyKey'], properties: { month: { type: 'string' }, patch: { type: 'object' }, idempotencyKey: { type: 'string' } } } },
  { name: 'mg_lookup_rate', description: '免费汇率查询（港币/新币/美元 → 人民币）', inputSchema: { type: 'object', required: ['base'], properties: { base: { type: 'string', enum: ['HKD', 'SGD', 'USD', 'CNY'] }, quote: { type: 'string' } } } },
  { name: 'mg_prepare_checklist', description: '生成录入确认清单数据', inputSchema: { type: 'object', required: ['items', 'writePath', 'statuses'], properties: { items: { type: 'array' }, writePath: { type: 'string' }, statuses: { type: 'object' } } } },
];

const ALLOWED_HOSTS = new Set(['api.frankfurter.dev', 'open.er-api.com']);

export class MoneyGrowthServer {
  private readonly ledger = new IdempotencyLedger();
  private client: MgsClient | null = null;

  private mgs(): MgsClient {
    if (!this.client) {
      const creds = loadCredentials();
      ALLOWED_HOSTS.add(new URL(creds.baseUrl).hostname);
      this.client = new MgsClient({ creds, fetchImpl: defaultFetch() });
    }
    return this.client;
  }

  private fx(): FxService {
    return new FxService({ fetchImpl: defaultFetch() as never, now: () => Date.now() });
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case 'mg_verify_auth':
        return this.mgs().verifyAuth();
      case 'mg_get_snapshot': {
        const data = await this.mgs().getSnapshot(String(args.month));
        return data ?? { exists: false, month: args.month };
      }
      case 'mg_check_lock_window': {
        const month = String(args.month);
        const cur = currentMonth();
        const snap = await this.mgs().getSnapshot(month);
        const exists = Boolean(snap && (snap as { exists?: boolean }).exists);
        return {
          locked: month < cur && exists,
          withinCorrectWindow: withinCorrectWindow(month, cur),
          writePath: decideWritePath(month, cur, exists),
          basis: `serverCurrentMonth=${cur}; historyExists=${exists}`,
        };
      }
      case 'mg_save_snapshot': {
        const month = String(args.month);
        const key = String(args.idempotencyKey);
        const siteBody = buildSiteBody(args.payload as never);
        if (!this.ledger.markIfAbsent(key)) {
          const snap = await this.mgs().getSnapshot(month);
          return { written: false, idempotentHit: true, readbackDiff: snap ?? null, reason: 'E_DUP_IDEMPOTENT' };
        }
        const result = await this.mgs().saveSnapshot(month, siteBody);
        return { written: true, idempotentHit: false, readbackDiff: result };
      }
      case 'mg_correct_snapshot': {
        const month = String(args.month);
        const key = String(args.idempotencyKey);
        const cur = currentMonth();
        if (!withinCorrectWindow(month, cur)) {
          return { corrected: false, reason: 'E_WINDOW_EXCEEDED', readbackDiff: null };
        }
        if (!this.ledger.markIfAbsent(key)) {
          return { corrected: false, reason: 'E_DUP_IDEMPOTENT', readbackDiff: await this.mgs().getSnapshot(month) };
        }
        const body = buildSiteBody(args.patch as never);
        const r = await this.mgs().correctSnapshot(month, body);
        return { corrected: true, readbackDiff: r.diff, correctedAt: r.correctedAt };
      }
      case 'mg_lookup_rate':
        return this.fx().lookupRate(String(args.base) as never);
      case 'mg_prepare_checklist':
        return {
          month: args.month ?? null,
          items: args.items ?? [],
          writePath: args.writePath ?? 'save',
          statuses: args.statuses ?? {},
          fingerprint: payloadFingerprint({ items: args.items ?? [], writePath: args.writePath }),
        };
      default:
        throw new Error(`TOOL_UNAVAILABLE: 未注册工具 ${tool}`);
    }
  }

  tools(): unknown[] {
    return TOOLS;
  }
}

// ---------------- stdio JSON-RPC 传输 ----------------

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function respond(id: number | string | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function respondError(id: number | string | undefined, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } });
}

export async function handleLine(server: MoneyGrowthServer, line: string): Promise<string | null> {
  let msg: RpcMessage;
  try {
    msg = JSON.parse(line) as RpcMessage;
  } catch {
    return respondError(null, 'OUTPUT_INVALID: 非 JSON 行');
  }
  if (msg.method === 'initialize') {
    return respond(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'money-growth-mcp', version: '0.1.0' },
    });
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return null;
  if (msg.method === 'tools/list') return respond(msg.id, { tools: server.tools() });
  if (msg.method === 'tools/call') {
    const name = String((msg.params as { name?: string })?.name ?? '');
    const args = ((msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {}) as Record<string, unknown>;
    try {
      const out = await Promise.race([
        server.call(name, args),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 20_000)),
      ]);
      return respond(msg.id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      return respond(msg.id, { content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }], isError: true });
    }
  }
  return respondError(msg.id, `TOOL_UNAVAILABLE: 未知方法 ${msg.method}`);
}

/* istanbul ignore next */
export function main(): void {
  const server = new MoneyGrowthServer();
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    void handleLine(server, line).then((out) => {
      if (out) process.stdout.write(`${out}\n`);
    });
  });
}

/* istanbul ignore next */
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  main();
}
