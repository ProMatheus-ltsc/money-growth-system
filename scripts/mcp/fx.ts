/**
 * 免费汇率源查询与降级（COMP-001 / REQ-002）。
 * 主源 Frankfurter（ECB，无密钥）→ 备源 open.er-api.com（无密钥）。
 * 主备全挂 → 抛 E_FX_UNAVAILABLE；缓存超 24h → 强制刷新，刷新失败同样抛 E_FX_UNAVAILABLE
 * （禁止用陈旧汇率替代，陈旧判定仅用于触发刷新与告警）。
 * 网络与时钟均可注入，便于脱网单测（tests/shared/fx-degrade.test.ts）。
 */

export type FxCode = 'HKD' | 'SGD' | 'USD' | 'CNY';

export interface RateResult {
  /** 1 单位 base = rate 单位 quote，十进制字符串 ≤6 位，避免浮点歧义 */
  rate: string;
  source: 'frankfurter' | 'er-api' | 'cache';
  /** ISO UTC 时间 */
  fetchedAt: string;
}

export class FxError extends Error {
  constructor(public readonly code: 'E_FX_UNAVAILABLE' | 'E_FX_STALE', message: string) {
    super(message);
    this.name = 'FxError';
  }
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface FxDeps {
  fetchImpl: FetchLike;
  now: () => number;
  timeoutMs?: number;
}

const PRIMARY_URL = (base: FxCode): string =>
  `https://api.frankfurter.dev/v1/latest?base=${base}&symbols=CNY`;
const FALLBACK_URL = (base: FxCode): string =>
  `https://open.er-api.com/v6/latest/${base}`;

const FRESH_MS = 20 * 3600_000; // 20h 内直接命中缓存
const STALE_MS = 24 * 3600_000; // 超 24h 视为陈旧：必须刷新

interface CacheEntry {
  result: RateResult;
  atMs: number;
}

function parseRate(raw: unknown, base: FxCode): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  // frankfurter: { rates: { CNY: number } }
  const rates = rec.rates;
  if (typeof rates === 'object' && rates !== null) {
    const v = (rates as Record<string, unknown>).CNY;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function toRateString(rate: number): string {
  return rate.toFixed(6);
}

export class FxService {
  private readonly cache = new Map<FxCode, CacheEntry>();
  private readonly deps: FxDeps;

  constructor(deps: FxDeps) {
    this.deps = { timeoutMs: 20_000, ...deps };
  }

  private async fetchJson(url: string): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    try {
      const res = await this.deps.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 查询 base→CNY 实时汇率；主备全挂抛 E_FX_UNAVAILABLE，绝不返回陈旧值 */
  async lookupRate(base: FxCode): Promise<RateResult> {
    if (base === 'CNY') {
      return { rate: '1', source: 'cache', fetchedAt: new Date(this.deps.now()).toISOString() };
    }
    const hit = this.cache.get(base);
    if (hit) {
      const age = this.deps.now() - hit.atMs;
      if (age < FRESH_MS) return { ...hit.result, source: 'cache' };
      // age ≥ 24h：E_FX_STALE 语义 = 强制刷新；刷新失败不得回退陈旧缓存
      if (age > STALE_MS) {
        this.cache.delete(base);
      }
    }
    const primary = await this.fetchJson(PRIMARY_URL(base));
    const p = parseRate(primary, base);
    if (p !== null) {
      const result: RateResult = {
        rate: toRateString(p),
        source: 'frankfurter',
        fetchedAt: new Date(this.deps.now()).toISOString(),
      };
      this.cache.set(base, { result, atMs: this.deps.now() });
      return result;
    }
    const fallbackRaw = await this.fetchJson(FALLBACK_URL(base));
    const f = parseRate(fallbackRaw, base);
    if (f !== null) {
      const result: RateResult = {
        rate: toRateString(f),
        source: 'er-api',
        fetchedAt: new Date(this.deps.now()).toISOString(),
      };
      this.cache.set(base, { result, atMs: this.deps.now() });
      return result;
    }
    throw new FxError('E_FX_UNAVAILABLE', `主备汇率源均不可用（${base}→CNY），条目转待确认，不使用陈旧值`);
  }

  /** 分整数金额换算为人民币分（四舍五入）；rate 用十进制字符串精确乘 */
  convertCentsToCny(amountCents: number, rate: string): number {
    if (!Number.isInteger(amountCents)) throw new Error('amountCents 必须为分整数');
    const scaled = Number(rate);
    if (!Number.isFinite(scaled) || scaled <= 0) throw new FxError('E_FX_UNAVAILABLE', '汇率非法');
    return Math.round(amountCents * scaled);
  }
}
