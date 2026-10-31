/**
 * 免费汇率主备降级链回归（REQ-002 / F-002 / E_FX_UNAVAILABLE / E_FX_STALE 语义）。
 * 全脱网：fetch 与时钟注入 stub，断言来源字段与错误码，不允许陈旧值回流。
 */
import { describe, it, expect } from 'vitest';
import { FxService, FxError } from '../../scripts/mcp/fx.ts';

type Stub = { ok: boolean; status: number; body?: unknown };

function makeService(script: Record<string, (url: string) => Stub>, startMs = Date.UTC(2026, 9, 31, 0, 0, 0)) {
  let nowMs = startMs;
  const calls: string[] = [];
  const svc = new FxService({
    fetchImpl: async (url: string) => {
      calls.push(url);
      const host = Object.keys(script).find((h) => url.includes(h));
      if (!host) return { ok: false, status: 404, json: async () => ({}) };
      const stub = script[host](url);
      return { ok: stub.ok, status: stub.status, json: async () => stub.body ?? {} };
    },
    now: () => nowMs,
  });
  return { svc, advance: (ms: number) => { nowMs += ms; }, calls };
}

const FRANK = (rate: number) => (url: string) =>
  url.includes('symbols=CNY') ? { ok: true, status: 200, body: { rates: { CNY: rate } } } : { ok: false, status: 404 };

describe('FxService.lookupRate 降级链', () => {
  it('主源可用 → frankfurter', async () => {
    const { svc } = makeService({ 'api.frankfurter.dev': FRANK(0.9234) });
    const r = await svc.lookupRate('HKD');
    expect(r.source).toBe('frankfurter');
    expect(Number(r.rate)).toBeCloseTo(0.9234, 6);
  });

  it('主源故障 → 备源 er-api', async () => {
    const { svc, calls } = makeService({
      'api.frankfurter.dev': () => ({ ok: false, status: 503 }),
      'open.er-api.com': () => ({ ok: true, status: 200, body: { rates: { CNY: 0.9221 } } }),
    });
    const r = await svc.lookupRate('SGD');
    expect(r.source).toBe('er-api');
    expect(r.rate).toBe('0.922100');
    expect(calls).toHaveLength(2);
  });
  it('主备全挂 → E_FX_UNAVAILABLE（禁止陈旧替代）', async () => {
    const { svc } = makeService({
      'api.frankfurter.dev': () => ({ ok: false, status: 500 }),
      'open.er-api.com': () => ({ ok: false, status: 500 }),
    });
    await expect(svc.lookupRate('USD')).rejects.toMatchObject({ code: 'E_FX_UNAVAILABLE' });
  });

  it('fetch 抛异常同样降级到备源', async () => {
    const svc = new FxService({
      fetchImpl: async (url: string) => {
        if (url.includes('frankfurter')) throw new Error('network down');
        return { ok: true, status: 200, json: async () => ({ rates: { CNY: 7.1 } }) };
      },
      now: () => Date.now(),
    });
    const r = await svc.lookupRate('USD');
    expect(r.source).toBe('er-api');
    expect(r.rate).toBe('7.100000');
  });

  it('缓存 <20h 直接命中 cache，不再出网', async () => {
    const { svc, advance, calls } = makeService({ 'api.frankfurter.dev': FRANK(0.9) });
    await svc.lookupRate('HKD');
    advance(19 * 3600_000);
    const r = await svc.lookupRate('HKD');
    expect(r.source).toBe('cache');
    expect(calls).toHaveLength(1);
  });

  it('缓存 >24h（E_FX_STALE 语义）→ 强制刷新；刷新全挂不得回吐陈旧值', async () => {
    let failNow = false;
    const { svc, advance } = makeService({
      'api.frankfurter.dev': (url) => (failNow ? { ok: false, status: 503 } : FRANK(0.9)(url)),
      'open.er-api.com': () => ({ ok: false, status: 500 }),
    });
    await svc.lookupRate('HKD');
    failNow = true;
    advance(25 * 3600_000);
    await expect(svc.lookupRate('HKD')).rejects.toBeInstanceOf(FxError);
  });

  it('CNY→CNY 恒等，不出网', async () => {
    const { svc, calls } = makeService({});
    const r = await svc.lookupRate('CNY');
    expect(r.rate).toBe('1');
    expect(calls).toHaveLength(0);
  });
});

describe('convertCentsToCny（分整数精确换算）', () => {
  it('四舍五入到分', async () => {
    const { svc } = makeService({});
    expect(svc.convertCentsToCny(10000, '0.923456')).toBe(9235);
    expect(svc.convertCentsToCny(1, '7.1')).toBe(7);
  });
  it('非法入参拒绝', () => {
    const { svc } = makeService({});
    expect(() => svc.convertCentsToCny(1.5, '0.9')).toThrow('分整数');
    expect(() => svc.convertCentsToCny(100, '0')).toThrow();
  });
});
