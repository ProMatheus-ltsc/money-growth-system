/**
 * money-growth-system HTTP API 客户端（COMP-001 / REQ-003、REQ-004、REQ-006）。
 * - 凭据只从进程环境变量或仓库外 env 文件（MGS_ENV，默认 ~/secrets/money-growth.env）读取，
 *   任何日志与错误信息仅输出掩码（maskSecret）。
 * - 鉴权三步：POST /api/auth/verify-invite → gateToken → POST /api/auth/login → Bearer（7 天）。
 * - 站点 API 金额为「元」（≤2 位小数），录入模型金额为「分」整数；换算只发生在本模块边界。
 * - 网络与实现与站点语义（routes/snapshots.ts、routes/correct.ts、routes/auth.ts）一致。
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { addMonths, isValidMonth } from '../../backend/lib/month.ts';

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

export class MgsApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'MgsApiError';
  }
}

/** 凭据掩码：保留前 3 位，其余 ***（REQ-006 验收：日志不得出现明文） */
export function maskSecret(v: string | undefined): string {
  if (!v) return '<unset>';
  const head = v.slice(0, 3);
  return `${head}***`;
}

export interface Credentials {
  baseUrl: string;
  inviteCode: string;
  username: string;
  password: string;
}

/** 解析仓库外 env 文件（KEY=VALUE，忽略注释/空行），不打印任何值 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/** 凭据装载：process.env 优先（空白串视为未设置），缺失项回落 env 文件；缺项报 E_SCHEMA 且只回显变量名 */
export function loadCredentials(env: Record<string, string | undefined> = process.env): Credentials {
  let fileVars: Record<string, string> = {};
  const rawPath = (env.MGS_ENV ?? '').trim() || resolve(homedir(), 'secrets/money-growth.env');
  const path = rawPath.startsWith('~') ? resolve(homedir(), rawPath.slice(2)) : rawPath;
  if (existsSync(path)) fileVars = parseEnvFile(readFileSync(path, 'utf8'));
  const pick = (k: string): string | undefined => {
    const fromEnv = env[k];
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
    const fromFile = fileVars[k];
    return typeof fromFile === 'string' && fromFile.trim() ? fromFile.trim() : undefined;
  };
  const missing = ['MGS_URL', 'MGS_INVITE_CODE', 'MGS_USERNAME', 'MGS_PASSWORD'].filter((k) => !pick(k));
  if (missing.length > 0) {
    throw new MgsApiError('E_SCHEMA', 0, `缺少凭据变量：${missing.join(', ')}（请配置仓库外 ${path}）`);
  }
  return {
    baseUrl: (pick('MGS_URL') as string).replace(/\/+$/, ''),
    inviteCode: pick('MGS_INVITE_CODE') as string,
    username: pick('MGS_USERNAME') as string,
    password: pick('MGS_PASSWORD') as string,
  };
}

/**
 * 写路径判定（纯函数，路由逻辑与站点一致）：
 * - 未来月 → reject
 * - 当月 → save（PUT 快照）
 * - 历史月无快照 → save；有快照 → correct（POST 纠错端点）
 * - correct 仅允许最近 20 个自然月窗口（含当月），超窗 reject
 */
export type WritePath = 'save' | 'correct' | 'reject';

export function decideWritePath(
  month: string,
  currentMonth: string,
  historyExists: boolean,
  correctWindowMonths = 20
): WritePath {
  if (!isValidMonth(month) || !isValidMonth(currentMonth)) return 'reject';
  if (month > currentMonth) return 'reject';
  if (month === currentMonth) return 'save';
  if (!historyExists) return 'save';
  const earliest = addMonths(currentMonth, -(correctWindowMonths - 1));
  return month < earliest ? 'reject' : 'correct';
}

/** 是否落在 correct 纠错窗口（最近 window 个自然月，含当月）内 */
export function withinCorrectWindow(month: string, currentMonth: string, window = 20): boolean {
  if (!isValidMonth(month) || !isValidMonth(currentMonth)) return false;
  const earliest = addMonths(currentMonth, -(window - 1));
  return month >= earliest && month < currentMonth;
}

/** 鉴权失败处置策略：LOCKED_OUT 熔断不重试；过期允许一次自动重登；其余上抛 */
export type AuthPolicy = 'stop_locked' | 'relogin_once' | 'fail';

export function authFailurePolicy(status: number, code: string): AuthPolicy {
  if (status === 423 || code === 'LOCKED_OUT') return 'stop_locked';
  if (status === 401 || code === 'UNAUTHORIZED' || code === 'GATE_EXPIRED') return 'relogin_once';
  return 'fail';
}

/** 分 → 元（站点 API 边界换算；分整数 → 最多 2 位小数） */
export function centsToYuan(cents: number): number {
  if (!Number.isInteger(cents)) throw new MgsApiError('E_SCHEMA', 0, `金额必须为分整数，收到 ${cents}`);
  return Math.round(cents) / 100;
}

// ---------------- 录入模型（分整数）与站点 body（元） ----------------

export interface RecorderPayload {
  treeConfigId: number;
  catConfigId: number;
  assets: { nodeId: number; balanceCents: number; hasNewFunds: boolean; updateSource: 'current' | 'carried' }[];
  moduleGains?: { nodeId: number; gainCents: number | null }[];
  income?: { catItemId: number; amountCents: number }[];
  expense?: { catItemId: number; amountCents: number }[];
  largeItems?: { direction: 'income' | 'expense'; catItemId: number; name: string; amountCents: number }[];
  debts: { debtId: number; balanceCents: number; repaymentCents: number }[];
}

/** 分模型 → 站点 PUT/correct 请求体（元） */
export function buildSiteBody(p: RecorderPayload): Record<string, unknown> {
  return {
    treeConfigId: p.treeConfigId,
    catConfigId: p.catConfigId,
    assets: p.assets.map((a) => ({
      nodeId: a.nodeId,
      balance: centsToYuan(a.balanceCents),
      hasNewFunds: a.hasNewFunds,
      updateSource: a.updateSource,
    })),
    moduleGains: (p.moduleGains ?? []).map((g) => ({
      nodeId: g.nodeId,
      gain: g.gainCents === null ? null : centsToYuan(g.gainCents),
    })),
    income: (p.income ?? []).map((i) => ({ catItemId: i.catItemId, amount: centsToYuan(i.amountCents) })),
    expense: (p.expense ?? []).map((i) => ({ catItemId: i.catItemId, amount: centsToYuan(i.amountCents) })),
    largeItems: (p.largeItems ?? []).map((l) => ({
      direction: l.direction,
      catItemId: l.catItemId,
      name: l.name,
      amount: centsToYuan(l.amountCents),
    })),
    debts: p.debts.map((d) => ({
      debtId: d.debtId,
      balance: centsToYuan(d.balanceCents),
      repayment: centsToYuan(d.repaymentCents),
    })),
  };
}

// ---------------- HTTP 客户端 ----------------

interface Session {
  token: string;
  expiresAt: string;
  role: string;
}

export interface SiteResponse<T = unknown> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
}

export class MgsClient {
  private readonly creds: Credentials;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private session: Session | null = null;

  constructor(deps: { creds?: Credentials; fetchImpl: FetchLike; timeoutMs?: number }) {
    this.creds = deps.creds ?? loadCredentials();
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? 20_000;
  }

  private async http<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body?: unknown,
    opts: { auth?: boolean; allowRelogin?: boolean } = {}
  ): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.auth !== false) {
      if (!this.session) await this.authenticate();
      headers.authorization = `Bearer ${this.session!.token}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.creds.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new MgsApiError('TIMEOUT', 0, `请求超时或网络失败：${method} ${path}（${(e as Error).name}）`);
    } finally {
      clearTimeout(timer);
    }
    const json = (await res.json().catch(() => null)) as SiteResponse<T> | null;
    const errCode = json?.error?.code ?? '';
    if (!json || !json.success) {
      const message = json?.error?.message ?? `HTTP ${res.status}`;
      throw this.mapError(res.status, errCode, message, json?.error?.details, method, path, opts);
    }
    return json.data as T;
  }

  private mapError(
    status: number,
    code: string,
    message: string,
    details: unknown,
    method: string,
    path: string,
    opts: { auth?: boolean; allowRelogin?: boolean }
  ): MgsApiError {
    if (status === 423 || code === 'LOCKED_OUT') {
      return new MgsApiError('E_AUTH_LOCKED', status, `登录限速锁定：${message}（不得重试，等待解锁或报告用户）`, details);
    }
    if ((status === 401 || code === 'UNAUTHORIZED' || code === 'GATE_EXPIRED') && opts.auth !== false) {
      if (opts.allowRelogin !== false) {
        // E_AUTH_EXPIRED：自动重登一次；再次失败由 authenticate 上抛
        this.session = null;
        return new MgsApiError('E_AUTH_EXPIRED', status, `会话过期，将自动重登一次：${message}`, details);
      }
      return new MgsApiError('E_AUTH_EXPIRED', status, `重登后仍鉴权失败：${message}`, details);
    }
    if (status === 409 && code === 'HISTORY_LOCKED') {
      return new MgsApiError('E_HISTORY_LOCKED', status, '历史月已锁定，需走纠错端点', details);
    }
    if (status === 400 && message.includes('纠错仅支持')) {
      return new MgsApiError('E_WINDOW_EXCEEDED', status, message, details);
    }
    if (code === 'INVALID' || code === 'INVALID_PARAM') {
      return new MgsApiError('E_SCHEMA', status, `参数校验失败：${message}`, details);
    }
    return new MgsApiError(code || `HTTP_${status}`, status, `${method} ${path} 失败：${message}`, details);
  }

  /** 三步鉴权：verify-invite → login → Bearer；LOCKED_OUT 熔断不重试 */
  async authenticate(): Promise<Session> {
    const gate = await this.http<{ gateToken: string; expiresAt: string }>(
      '/api/auth/verify-invite',
      'POST',
      { code: this.creds.inviteCode },
      { auth: false }
    );
    let session: Session;
    try {
      session = await this.http<Session>('/api/auth/login', 'POST',
        { gateToken: gate.gateToken, username: this.creds.username, password: this.creds.password },
        { auth: false });
    } catch (e) {
      const err = e as MgsApiError;
      if (err.code === 'E_AUTH_LOCKED') {
        throw new MgsApiError('E_AUTH_LOCKED', err.status,
          `账号/IP 已锁定（${maskSecret(this.creds.username)}）：${err.message}。禁止重试，15 分钟后或请人工处理`, err.details);
      }
      throw err;
    }
    this.session = session;
    return session;
  }

  /** 带一次过期自动重登的请求包装（TIMEOUT 不重试写操作） */
  private async withRelogin<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const err = e as MgsApiError;
      if (err.code === 'E_AUTH_EXPIRED') {
        await this.authenticate();
        return await this.httpWrapOnce<T>(fn);
      }
      throw err;
    }
  }

  private async httpWrapOnce<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const err = e as MgsApiError;
      if (err.code === 'E_AUTH_EXPIRED') {
        throw new MgsApiError('E_AUTH_EXPIRED', err.status, '自动重登后仍鉴权失败，上抛');
      }
      throw err;
    }
  }

  /** 探活：返回角色 + 掩码账户 + 令牌到期 */
  async verifyAuth(): Promise<{ role: string; maskedAccount: string; tokenExpiresAt: string }> {
    const session = this.session ?? (await this.authenticate());
    await this.http<{ username?: string }>('/api/auth/me', 'GET');
    return { role: session.role, maskedAccount: maskSecret(this.creds.username), tokenExpiresAt: session.expiresAt };
  }

  /** 读取月快照（原站点结构，金额为元；输出层由 server 统一换算为分） */
  async getSnapshot(month: string): Promise<Record<string, unknown> | null> {
    return this.withRelogin(() =>
      this.http<Record<string, unknown>>(`/api/snapshots/${encodeURIComponent(month)}`, 'GET')
    );
  }

  /** 保存当月快照（站点语义：month<当月 且已有快照会抛 HISTORY_LOCKED，由调用方路由） */
  async saveSnapshot(month: string, siteBody: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withRelogin(() =>
      this.http<Record<string, unknown>>(`/api/snapshots/${encodeURIComponent(month)}`, 'PUT', siteBody, {
        allowRelogin: true,
      })
    );
  }

  /** 纠错端点（仅窗口内锁定月；confirmed 必须为 true，沿用钉住配置版本） */
  async correctSnapshot(
    month: string,
    snapshotBody: Record<string, unknown>
  ): Promise<{ month: string; correctedAt: string; diff: unknown }> {
    return this.withRelogin(() =>
      this.http<{ month: string; correctedAt: string; diff: unknown }>(
        `/api/snapshots/${encodeURIComponent(month)}/correct`,
        'POST',
        { confirmed: true, snapshot: snapshotBody }
      )
    );
  }

  /** 当前资产树/分类配置（含叶子节点与二级分类候选，供首次录入组装载荷） */
  async getConfigs(): Promise<Record<string, unknown>> {
    const [tree, cat] = await Promise.all([
      this.withRelogin(() => this.http<Record<string, unknown>>('/api/tree', 'GET')),
      this.withRelogin(() => this.http<Record<string, unknown>>('/api/cat-configs', 'GET')),
    ]);
    const nodes = (tree.nodes ?? []) as Record<string, unknown>[];
    const leaves = nodes
      .filter((n) => n.parentId !== null && n.enabled === true)
      .map((n) => ({
        id: n.id,
        parentId: n.parentId,
        name: n.name,
        updateFreq: n.updateFreq,
        isPlaceholder: n.isPlaceholder,
      }));
    return {
      treeConfigId: tree.configId,
      treeVersion: tree.version,
      catConfigId: cat.configId,
      catVersion: cat.version,
      threshold: cat.threshold,
      nodes: leaves,
      income: cat.income,
      expense: cat.expense,
    };
  }
}

/** 元（站点 API 口径）→ 分整数；非整数分视为口径异常 */
export function yuanToCentsStrict(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new MgsApiError('E_SCHEMA', 0, `${field} 不是有效数值：${String(v)}`);
  }
  const cents = Math.round(v * 100);
  if (Math.abs(v * 100 - cents) > 1e-6) {
    throw new MgsApiError('E_SCHEMA', 0, `${field} 超过两位小数：${v}`);
  }
  return cents;
}

/** 站点快照（元）→ 录入模型（分整数），供读回比对与 mg_get_snapshot 输出 */
export function snapshotToCents(raw: Record<string, unknown> | null): Record<string, unknown> {
  if (!raw) return { exists: false };
  if (raw.exists === false) {
    const asObj = (v: unknown): Record<string, unknown>[] =>
      Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
    return {
      ...raw,
      exists: false,
      carried: asObj(raw.carried).map((c) => {
        const { balance, ...rest } = c;
        return { ...rest, balanceCents: yuanToCentsStrict(balance, 'carried.balance') };
      }),
      debtDefaults: asObj(raw.debtDefaults).map((d) => {
        const { monthlyPayment, lastBalance, ...rest } = d;
        return {
          ...rest,
          monthlyPaymentCents: yuanToCentsStrict(monthlyPayment, 'debtDefaults.monthlyPayment'),
          lastBalanceCents: yuanToCentsStrict(lastBalance, 'debtDefaults.lastBalance'),
        };
      }),
    };
  }
  const asObj = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  const totals = (raw.totals ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    assets: asObj(raw.assets).map((a) => {
      const { balance, ...rest } = a;
      return { ...rest, balanceCents: yuanToCentsStrict(balance, 'assets.balance') };
    }),
    moduleGains: asObj(raw.moduleGains).map((g) => {
      const { gain, ...rest } = g;
      return { ...rest, gainCents: gain === null || gain === undefined ? null : yuanToCentsStrict(gain, 'moduleGains.gain') };
    }),
    income: asObj(raw.income).map((i) => {
      const { amount, ...rest } = i;
      return { ...rest, amountCents: yuanToCentsStrict(amount, 'income.amount') };
    }),
    expense: asObj(raw.expense).map((i) => {
      const { amount, ...rest } = i;
      return { ...rest, amountCents: yuanToCentsStrict(amount, 'expense.amount') };
    }),
    largeItems: asObj(raw.largeItems).map((l) => {
      const { amount, ...rest } = l;
      return { ...rest, amountCents: yuanToCentsStrict(amount, 'largeItems.amount') };
    }),
    debts: asObj(raw.debts).map((d) => {
      const { balance, repayment, ...rest } = d;
      return {
        ...rest,
        balanceCents: yuanToCentsStrict(balance, 'debts.balance'),
        repaymentCents: yuanToCentsStrict(repayment, 'debts.repayment'),
      };
    }),
    totals: {
      totalAssetsCents: yuanToCentsStrict(totals.totalAssets, 'totals.totalAssets'),
      totalDebtCents: yuanToCentsStrict(totals.totalDebt, 'totals.totalDebt'),
      netWorthCents: yuanToCentsStrict(totals.netWorth, 'totals.netWorth'),
    },
  };
}

/** 站点快照（分模型）→ 完整录入载荷（纠错时以钉住版本为基线再合并补丁） */
export function recorderPayloadFromSnapshot(
  snap: Record<string, unknown>
): RecorderPayload {
  if (snap.exists === false) {
    throw new MgsApiError('E_SCHEMA', 0, '目标月无快照，无法生成纠错基线');
  }
  const cents = snap.assets as { balanceCents?: number }[] | undefined;
  if (!cents || cents.some((a) => typeof a.balanceCents !== 'number')) {
    throw new MgsApiError('E_SCHEMA', 0, '快照未按分口径归一，拒绝生成纠错基线');
  }
  return {
    treeConfigId: Number(snap.treeConfigId),
    catConfigId: Number(snap.catConfigId),
    assets: (snap.assets as Record<string, unknown>[]).map((a) => ({
      nodeId: Number(a.nodeId),
      balanceCents: Number(a.balanceCents),
      hasNewFunds: Boolean(a.hasNewFunds),
      updateSource: (a.updateSource === 'carried' ? 'carried' : 'current') as 'current' | 'carried',
    })),
    moduleGains: ((snap.moduleGains ?? []) as Record<string, unknown>[]).map((g) => ({
      nodeId: Number(g.nodeId),
      gainCents: g.gainCents === null || g.gainCents === undefined ? null : Number(g.gainCents),
    })),
    income: ((snap.income ?? []) as Record<string, unknown>[]).map((i) => ({
      catItemId: Number(i.catItemId),
      amountCents: Number(i.amountCents),
    })),
    expense: ((snap.expense ?? []) as Record<string, unknown>[]).map((i) => ({
      catItemId: Number(i.catItemId),
      amountCents: Number(i.amountCents),
    })),
    largeItems: ((snap.largeItems ?? []) as Record<string, unknown>[]).map((l) => ({
      direction: (l.direction === 'income' ? 'income' : 'expense') as 'income' | 'expense',
      catItemId: Number(l.catItemId),
      name: String(l.name),
      amountCents: Number(l.amountCents),
    })),
    debts: ((snap.debts ?? []) as Record<string, unknown>[]).map((d) => ({
      debtId: Number(d.debtId),
      balanceCents: Number(d.balanceCents),
      repaymentCents: Number(d.repaymentCents),
    })),
  };
}

/** 出站白名单 fetch：只允许 MGS_URL 主机 + 两个免费汇率源主机 */
export function guardedFetch(allowedHosts: Iterable<string>): FetchLike {
  const allow = new Set(Array.from(allowedHosts, (h) => h.toLowerCase()));
  return async (url, init) => {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new MgsApiError('E_SCHEMA', 0, `非法出站地址：${url}`);
    }
    if (!allow.has(host)) {
      throw new MgsApiError('E_SCHEMA', 0, `出站被拒绝（不在白名单）：${host}`);
    }
    return (await fetch(url, init as RequestInit)) as Awaited<ReturnType<FetchLike>>;
  };
}

/** 供 fetch 注入的默认实现 */
export function defaultFetch(): FetchLike {
  return (url, init) => fetch(url, init as RequestInit) as ReturnType<FetchLike>;
}
