/**
 * 快照写路径路由与纠错窗口回归（REQ-004 / F-004）。
 * 覆盖：未来月拒绝、当月 save、历史锁定月按窗口分流 correct / reject。
 */
import { describe, it, expect } from 'vitest';
import {
  decideWritePath,
  withinCorrectWindow,
  snapshotToCents,
  recorderPayloadFromSnapshot,
  buildSiteBody,
  mergeRecorderPayload,
} from '../../scripts/mcp/api-client.ts';
import { addMonths } from '../../backend/lib/month.ts';

const CUR = '2026-10';

describe('decideWritePath', () => {
  it('未来月 → reject', () => {
    expect(decideWritePath('2026-11', CUR, false)).toBe('reject');
    expect(decideWritePath('2026-12', CUR, true)).toBe('reject');
  });

  it('非法月份格式 → reject', () => {
    expect(decideWritePath('2026-13', CUR, false)).toBe('reject');
    expect(decideWritePath('abc', CUR, false)).toBe('reject');
  });

  it('当月 → save（无论历史是否存在）', () => {
    expect(decideWritePath(CUR, CUR, false)).toBe('save');
    expect(decideWritePath(CUR, CUR, true)).toBe('save');
  });

  it('历史月无快照 → save；有快照 → correct（窗口内）', () => {
    expect(decideWritePath('2026-09', CUR, false)).toBe('save');
    expect(decideWritePath('2026-09', CUR, true)).toBe('correct');
  });

  it('超出 20 个月窗口的锁定月 → reject', () => {
    const tooOld = addMonths(CUR, -25);
    expect(decideWritePath(tooOld, CUR, true)).toBe('reject');
  });

  it('窗口边界：第 19 个月内可纠错，第 20 个月起拒绝', () => {
    expect(decideWritePath(addMonths(CUR, -19), CUR, true)).toBe('correct');
    expect(decideWritePath(addMonths(CUR, -20), CUR, true)).toBe('reject');
  });
});

describe('withinCorrectWindow', () => {
  it('当月不算窗口内（当月直接 save）', () => {
    expect(withinCorrectWindow(CUR, CUR)).toBe(false);
  });
  it('最近一个历史月在窗口内', () => {
    expect(withinCorrectWindow(addMonths(CUR, -1), CUR)).toBe(true);
  });
  it('窗口首尾边界', () => {
    expect(withinCorrectWindow(addMonths(CUR, -19), CUR)).toBe(true);
    expect(withinCorrectWindow(addMonths(CUR, -20), CUR)).toBe(false);
  });
  it('未来月不在纠错窗口', () => {
    expect(withinCorrectWindow('2026-11', CUR)).toBe(false);
  });
});

describe('元→分归一与纠错基线', () => {
  const raw = {
    exists: true,
    month: '2026-09',
    treeConfigId: 2,
    catConfigId: 4,
    assets: [{ nodeId: 11, balance: 1234.56, hasNewFunds: true, updateSource: 'current' }],
    moduleGains: [{ nodeId: 11, gain: 12.5 }],
    income: [{ catItemId: 21, amount: 100 }],
    expense: [{ catItemId: 22, amount: 30.25 }],
    largeItems: [{ id: 1, direction: 'expense', catItemId: 22, name: '电脑', amount: 1000 }],
    debts: [{ debtId: 1, balance: 500, repayment: 20, fixedRepayment: true }],
    totals: { totalAssets: 1234.56, totalDebt: 500, netWorth: 734.56 },
  };

  it('snapshotToCents 全部换算为分整数', () => {
    const cents = snapshotToCents(raw) as Record<string, any>;
    expect(cents.assets[0].balanceCents).toBe(123456);
    expect(cents.moduleGains[0].gainCents).toBe(1250);
    expect(cents.income[0].amountCents).toBe(10000);
    expect(cents.expense[0].amountCents).toBe(3025);
    expect(cents.largeItems[0].amountCents).toBe(100000);
    expect(cents.debts[0].repaymentCents).toBe(2000);
    expect(cents.totals.netWorthCents).toBe(73456);
  });

  it('不存在月份返回 {exists:false}（carried/debtDefaults 兜底为空数组）', () => {
    expect(snapshotToCents(null)).toEqual({ exists: false });
    expect(snapshotToCents({ exists: false })).toMatchObject({ exists: false, carried: [], debtDefaults: [] });
  });

  it('exists:false 的 carried/debtDefaults 同样归一为分整数', () => {
    const out = snapshotToCents({
      exists: false,
      month: '2026-10',
      carried: [{ nodeId: 12, balance: 1234.56, lastUpdatedMonth: '2026-07' }],
      debtDefaults: [
        { debtId: 1, name: '房贷', fixedRepayment: true, monthlyPayment: 3000, lastBalance: 500 },
      ],
    }) as Record<string, any>;
    expect(out.carried[0].balanceCents).toBe(123456);
    expect(out.carried[0].balance).toBeUndefined();
    expect(out.debtDefaults[0].monthlyPaymentCents).toBe(300000);
    expect(out.debtDefaults[0].lastBalanceCents).toBe(50000);
    expect(out.debtDefaults[0].lastBalance).toBeUndefined();
  });

  it('纠错基线保留钉住配置 id 且可回写为站点 body', () => {
    const payload = recorderPayloadFromSnapshot(snapshotToCents(raw));
    expect(payload.treeConfigId).toBe(2);
    expect(payload.catConfigId).toBe(4);
    const body = buildSiteBody(payload) as Record<string, any>;
    expect(body.assets[0].balance).toBe(1234.56);
    expect(body.debts[0].repayment).toBe(20);
  });

  it('超两位小数的站点金额视为口径异常', () => {
    const bad = { ...raw, assets: [{ nodeId: 11, balance: 1.005, hasNewFunds: false, updateSource: 'current' }] };
    expect(() => snapshotToCents(bad)).toThrow('两位小数');
  });
});

describe('mergeRecorderPayload（纠错补丁按业务键合并）', () => {
  const base = {
    treeConfigId: 2,
    catConfigId: 4,
    assets: [
      { nodeId: 11, balanceCents: 100, hasNewFunds: false, updateSource: 'current' as const },
      { nodeId: 12, balanceCents: 200, hasNewFunds: false, updateSource: 'current' as const },
    ],
    income: [{ catItemId: 21, amountCents: 1000 }],
    expense: [{ catItemId: 31, amountCents: 500 }],
    debts: [{ debtId: 1, balanceCents: 900, repaymentCents: 50 }],
  };

  it('只改一个分类金额，其余条目保留', () => {
    const merged = mergeRecorderPayload(base, { income: [{ catItemId: 21, amountCents: 2000 }] });
    expect(merged.income).toEqual([{ catItemId: 21, amountCents: 2000 }]);
    expect(merged.expense).toEqual(base.expense);
    expect(merged.assets).toHaveLength(2);
    expect(merged.treeConfigId).toBe(2);
  });

  it('新增条目与既有条目并存；钉住配置 id 不可被补丁改动', () => {
    const merged = mergeRecorderPayload(base, {
      assets: [{ nodeId: 13, balanceCents: 300, hasNewFunds: true, updateSource: 'current' }],
      treeConfigId: 99,
      catConfigId: 99,
    } as any);
    expect(merged.assets.map((a) => a.nodeId).sort()).toEqual([11, 12, 13]);
    expect(merged.treeConfigId).toBe(2);
    expect(merged.catConfigId).toBe(4);
  });

  it('大额条目按 direction+catItemId+name 合并', () => {
    const b = { ...base, largeItems: [{ direction: 'expense' as const, catItemId: 31, name: '年夜饭', amountCents: 100 }] };
    const merged = mergeRecorderPayload(b, { largeItems: [{ direction: 'expense', catItemId: 31, name: '年夜饭', amountCents: 200 }] });
    expect(merged.largeItems).toHaveLength(1);
    expect(merged.largeItems![0].amountCents).toBe(200);
  });
});
