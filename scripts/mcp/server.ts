/**
 * money-growth MCP stdio server（COMP-001 入口）。
 * 轻量 JSON-RPC 2.0 逐行协议（initialize / tools/list / tools/call），无外部依赖，
 * 便于站点 typecheck 直接通过；工具实现全部委托 api-client / fx / idempotency / schema。
 *
 * 安全边界（REQ-006 与 04-contracts §1.1）：
 * - 工具入参绝不接受凭据；凭据仅从进程 env / 仓库外 env 文件读取。
 * - 出站仅允许 MGS_URL 主机 + 两个免费汇率源主机（guardedFetch 强制校验）。
 * - 无 DELETE 能力；单工具调用超时 20s；写操作幂等，命中不重复写。
 * - 写路径（save/correct/reject）由脚本判定，不依赖提示词。
 *
 * 运行：node scripts/mcp/server.ts（Node ≥ 22.18，类型擦除默认开启；由 config/money-growth-mcp.json 注册）
 */
import { createInterface } from 'node:readline';
import {
  MgsClient,
  MgsApiError,
  guardedFetch,
  loadCredentials,
  decideWritePath,
  withinCorrectWindow,
  buildSiteBody,
  snapshotToCents,
  recorderPayloadFromSnapshot,
  mergeRecorderPayload,
  type RecorderPayload,
} from './api-client.ts';
import { FxService } from './fx.ts';
import { IdempotencyLedger, payloadFingerprint } from './idempotency.ts';
import { validateRecorderPayload } from './schema.ts';
import { currentMonth } from '../../backend/lib/month.ts';

const FX_HOSTS = ['api.frankfurter.dev', 'open.er-api.com'];

const TOOLS = [
  { name: 'mg_verify_auth', description: '三步鉴权探活，返回角色/掩码账户/令牌到期', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'mg_get_configs', description: '读取最新资产树/分类配置（treeConfigId/catConfigId/叶子节点/二级分类/阈值）；传 month 时附带该月钉住版本', inputSchema: { type: 'object', properties: { month: { type: 'string' } } } },
  { name: 'mg_get_snapshot', description: '读取指定月快照（金额统一为分整数）', inputSchema: { type: 'object', required: ['month'], properties: { month: { type: 'string' } } } },
  { name: 'mg_check_lock_window', description: '判定锁定与纠错窗口，返回 writePath=save|correct|reject', inputSchema: { type: 'object', required: ['month'], properties: { month: { type: 'string' } } } },
  { name: 'mg_save_snapshot', description: '保存快照：锁定月自动切纠错端点，未来月/超窗拒绝且零写请求；幂等键去重', inputSchema: { type: 'object', required: ['month', 'payload', 'idempotencyKey'], properties: { month: { type: 'string' }, payload: { type: 'object' }, idempotencyKey: { type: 'string' } } } },
  { name: 'mg_correct_snapshot', description: '纠错窗口内锁定月：patch 为部分录入载荷，基于该月钉住快照合并后提交', inputSchema: { type: 'object', required: ['month', 'patch', 'idempotencyKey'], properties: { month: { type: 'string' }, patch: { type: 'object' }, idempotencyKey: { type: 'string' } } } },
  { name: 'mg_lookup_rate', description: '免费汇率查询（HKD/SGD/USD → CNY）；可传 amountCents 直接换算人民币分', inputSchema: { type: 'object', required: ['base'], properties: { base: { type: 'string', enum: ['HKD', 'SGD', 'USD'] }, quote: { type: 'string', enum: ['CNY'] }, amountCents: { type: 'integer' } } } },
  { name: 'mg_prepare_checklist', description: '生成录入确认清单数据（month/items/path/status + pending/failures）', inputSchema: { type: 'object', required: ['items', 'writePath'], properties: { month: { type: 'string' }, items: { type: 'array' }, writePath: { type: 'string' }, statuses: { type: 'object' }, pending: { type: 'array' }, failures: { type: 'array' }, path: { type: 'string' }, status: { type: 'string' } } } },
];

export class MoneyGrowthServer {
  private readonly ledger = new IdempotencyLedger();
  private client: MgsClient | null = null;
  private fxService: FxService | null = null;

  private mgs(): MgsClient {
    if (!this.client) {
      const creds = loadCredentials();
      const allow = [new URL(creds.baseUrl).hostname, ...FX_HOSTS];
      this.client = new MgsClient({ creds, fetchImpl: guardedFetch(allow) });
    }
    return this.client;
  }

  private fx(): FxService {
    if (!this.fxService) {
      const extra: string[] = [];
      for (const name of ['MGS_FX_PRIMARY_URL', 'MGS_FX_FALLBACK_URL']) {
        const template = (process.env[name] ?? '').trim();
        if (!template) continue;
        try {
          extra.push(new URL(template.replace('{base}', 'HKD')).hostname);
        } catch {
          throw new MgsApiError('E_SCHEMA', 0, `${name} 不是合法 URL 模板`);
        }
      }
      this.fxService = new FxService({
        fetchImpl: guardedFetch([...FX_HOSTS, ...extra]) as never,
        now: () => Date.now(),
      });
    }
    return this.fxService;
  }

  private async snapshotCents(month: string): Promise<Record<string, unknown>> {
    return snapshotToCents(await this.mgs().getSnapshot(month));
  }

  private assertPayload(payload: unknown, month: string): RecorderPayload {
    const merged = { ...(payload as Record<string, unknown>), month };
    const issues = validateRecorderPayload(merged);
    if (issues.length > 0) {
      throw new MgsApiError('E_SCHEMA', 0, 'payload 不符合 config/recorder.schema.json', issues);
    }
    return payload as RecorderPayload;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case 'mg_verify_auth':
        return this.mgs().verifyAuth();

      case 'mg_get_configs': {
        const configs = await this.mgs().getConfigs();
        const month = typeof args.month === 'string' ? args.month : '';
        if (!month) return configs;
        const snap = await this.snapshotCents(month);
        return {
          ...configs,
          month,
          monthExists: snap.exists === true,
          pinnedTreeConfigId: snap.exists === true ? snap.treeConfigId : null,
          pinnedCatConfigId: snap.exists === true ? snap.catConfigId : null,
        };
      }

      case 'mg_get_snapshot':
        return this.snapshotCents(String(args.month));

      case 'mg_check_lock_window': {
        const month = String(args.month);
        const cur = currentMonth();
        const snap = await this.snapshotCents(month);
        const exists = snap.exists === true;
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
        const cur = currentMonth();
        const snap = await this.snapshotCents(month);
        const exists = snap.exists === true;
        const path = decideWritePath(month, cur, exists);
        if (path === 'reject') {
          const reason = !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
            ? 'E_SCHEMA: 月份格式应为 YYYY-MM'
            : month > cur
              ? 'E_WINDOW_EXCEEDED: 未来月份禁止保存'
              : 'E_WINDOW_EXCEEDED: 目标月超出最近 20 个月纠错窗口，拒绝修改';
          return { written: false, writePath: 'rejected', zeroWrite: true, reason };
        }
        const payload = this.assertPayload(args.payload, month);
        const prior = this.ledger.lookup(key);
        if (prior) {
          return { ...prior, idempotentHit: true, reason: 'E_DUP_IDEMPOTENT' };
        }
        const body = buildSiteBody(payload);
        if (path === 'correct') {
          // 契约 §2：save 命中锁定月自动切 correct（同幂等键）
          const pinned = recorderPayloadFromSnapshot(snap);
          const merged: RecorderPayload = { ...pinned, ...payload, treeConfigId: pinned.treeConfigId, catConfigId: pinned.catConfigId };
          const result = await this.mgs().correctSnapshot(month, buildSiteBody(merged));
          const record = { written: true, writePath: 'correct', idempotentHit: false, correctedAt: result.correctedAt, readbackDiff: result.diff };
          this.ledger.record(key, record);
          return record;
        }
        const result = await this.mgs().saveSnapshot(month, body);
        const record = { written: true, writePath: 'save', idempotentHit: false, readbackDiff: result };
        this.ledger.record(key, record);
        return record;
      }

      case 'mg_correct_snapshot': {
        const month = String(args.month);
        const key = String(args.idempotencyKey);
        const cur = currentMonth();
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
          return { corrected: false, zeroWrite: true, reason: 'E_SCHEMA: 月份格式应为 YYYY-MM' };
        }
        if (month >= cur) {
          return { corrected: false, zeroWrite: true, reason: 'E_SCHEMA: 当月/未来月请走保存（mg_save_snapshot），无需纠错' };
        }
        if (!withinCorrectWindow(month, cur)) {
          return { corrected: false, zeroWrite: true, reason: 'E_WINDOW_EXCEEDED: 目标月超出最近 20 个月纠错窗口，拒绝修改' };
        }
        const prior = this.ledger.lookup(key);
        if (prior) {
          return { ...prior, idempotentHit: true, reason: 'E_DUP_IDEMPOTENT' };
        }
        const snap = await this.snapshotCents(month);
        if (snap.exists !== true) {
          return { corrected: false, zeroWrite: true, reason: 'E_SCHEMA: 目标月无快照，无需纠错，请走保存' };
        }
        const pinned = recorderPayloadFromSnapshot(snap);
        const patch = args.patch as Record<string, unknown> | undefined;
        const PATCH_KEYS = ['assets', 'moduleGains', 'income', 'expense', 'largeItems', 'debts'];
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new MgsApiError('E_SCHEMA', 0, 'patch 必须为对象');
        }
        const unknownKeys = Object.keys(patch).filter((k) => !PATCH_KEYS.includes(k));
        if (unknownKeys.length > 0) {
          throw new MgsApiError('E_SCHEMA', 0, `patch 含不支持的字段：${unknownKeys.join(', ')}`);
        }
        const present = PATCH_KEYS.filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
        if (present.length === 0) {
          throw new MgsApiError('E_SCHEMA', 0, 'patch 至少需要包含一个明细数组（assets/moduleGains/income/expense/largeItems/debts）');
        }
        for (const key of present) {
          if (!Array.isArray((patch as Record<string, unknown>)[key])) {
            throw new MgsApiError('E_SCHEMA', 0, `patch.${key} 必须为数组`);
          }
        }
        const merged = mergeRecorderPayload(pinned, patch as Partial<RecorderPayload>);
        this.assertPayload(merged, month);
        const result = await this.mgs().correctSnapshot(month, buildSiteBody(merged));
        const record = { corrected: true, writePath: 'correct', idempotentHit: false, correctedAt: result.correctedAt, readbackDiff: result.diff };
        this.ledger.record(key, record);
        return record;
      }

      case 'mg_lookup_rate': {
        const base = String(args.base);
        if (!['HKD', 'SGD', 'USD'].includes(base)) {
          throw new MgsApiError('E_SCHEMA', 0, `不支持的币种：${base}（仅 HKD/SGD/USD）`);
        }
        if (args.quote !== undefined && args.quote !== 'CNY') {
          throw new MgsApiError('E_SCHEMA', 0, `quote 仅支持 CNY，收到 ${String(args.quote)}`);
        }
        const rate = await this.fx().lookupRate(base as never);
        if (typeof args.amountCents === 'number') {
          return { ...rate, cnyCents: this.fx().convertCentsToCny(args.amountCents, rate.rate) };
        }
        return rate;
      }

      case 'mg_prepare_checklist': {
        if (!Array.isArray(args.items)) {
          throw new MgsApiError('E_SCHEMA', 0, 'items 必须为数组');
        }
        const items = (args.items as Record<string, unknown>[]).map((raw, index) => ({
          category: String(raw.category ?? ''),
          originalAmount: raw.originalAmount ?? null,
          currency: String(raw.currency ?? 'CNY'),
          rate: raw.rate ?? null,
          rateSource: raw.rateSource ?? null,
          rateFetchedAt: raw.rateFetchedAt ?? null,
          cnyYuan: raw.cnyYuan ?? null,
          storedCents: typeof raw.storedCents === 'number' ? raw.storedCents : null,
          screenshotRef: String(raw.screenshotRef ?? ''),
          writePath: String(raw.writePath ?? args.writePath ?? 'save'),
          status: String(raw.status ?? 'ok'),
          index,
        }));
        const failures = Array.isArray(args.failures) ? args.failures : [];
        const pendingItems = Array.isArray(args.pending) ? args.pending : [];
        const overall = failures.length > 0 ? 'failed' : pendingItems.length > 0 ? 'partial' : 'ok';
        return {
          month: args.month ?? null,
          items,
          writePath: args.writePath ?? 'save',
          path: typeof args.path === 'string' && args.path.trim() ? args.path : 'templates/mg-checklist.html',
          status: typeof args.status === 'string' && args.status.trim() ? args.status : overall,
          statuses: args.statuses ?? {},
          pending: pendingItems,
          failures,
          fingerprint: payloadFingerprint({ items, writePath: args.writePath }),
        };
      }

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

function respond(id: number | string | null | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function respondError(id: number | string | null | undefined, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } });
}

function errorPayload(e: unknown): Record<string, unknown> {
  if (e instanceof MgsApiError) return { code: e.code, message: e.message, details: e.details ?? null };
  return { code: 'INTERNAL', message: (e as Error).message };
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
      serverInfo: { name: 'money-growth-mcp', version: '0.2.0' },
    });
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return null;
  if (msg.method === 'ping') return respond(msg.id, {});
  if (msg.method === 'tools/list') return respond(msg.id, { tools: server.tools() });
  if (msg.method === 'tools/call') {
    const name = String((msg.params as { name?: string })?.name ?? '');
    const args = ((msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {}) as Record<string, unknown>;
    try {
      const out = await Promise.race([
        server.call(name, args),
        new Promise((_, rej) => setTimeout(() => rej(new MgsApiError('TIMEOUT', 0, '单工具调用超 20s')), 20_000)),
      ]);
      return respond(msg.id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      return respond(msg.id, { content: [{ type: 'text', text: JSON.stringify({ error: errorPayload(e) }) }], isError: true });
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
