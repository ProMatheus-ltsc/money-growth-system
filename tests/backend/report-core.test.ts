/**
 * 报表核心纯逻辑回归（F-03/F-04/F-08）：总额、树图/桑基、收益率四态、三张表、期间聚合。
 */
import { describe, it, expect } from 'vitest';
import {
  debtRatioOf,
  totalsOf,
  buildTreemap,
  buildSankeyFromAmounts,
  buildSankey,
  buildGainCompare,
  buildBalanceSheet,
  buildIncomeStatement,
  buildCatDetails,
  buildCashFlow,
  buildTrend,
  resolveRange,
  buildUpdateStatus,
  reportLabel,
  aggregatePeriod,
} from '../../backend/services/reportCore.ts';
import { mockDb } from '../helpers/mockD1.ts';
import { bundleFactory, treeNodes, catItems, debts } from '../helpers/fixtures.ts';

const b = bundleFactory();

function dbHandler(sql: string) {
  if (sql.includes('FROM monthly_snapshots WHERE month')) return b.snapshot;
  if (sql.includes('FROM tree_configs WHERE id')) return b.treeConfig;
  if (sql.includes('FROM cat_configs WHERE id')) return b.catConfig;
  if (sql.includes('FROM tree_nodes')) return treeNodes();
  if (sql.includes('FROM cat_items')) return catItems();
  if (sql.includes('FROM debts ORDER BY')) return debts();
  if (sql.includes('SELECT month FROM monthly_snapshots')) return [{ month: '2026-09' }, { month: '2026-10' }];
  if (sql.includes('SELECT ms.month FROM snapshot_assets sa')) return { month: '2026-10' };
  if (sql.includes('balance_cents FROM snapshot_assets sa')) return { balance_cents: 10_000_00 };
  if (sql.includes('FROM snapshot_assets')) return b.assets;
  if (sql.includes('FROM snapshot_gains')) return b.gains;
  if (sql.includes('FROM snapshot_debts')) return b.debtsSnap;
  if (sql.includes('FROM snapshot_cat_amounts')) return b.catAmounts;
  if (sql.includes('FROM snapshot_large_items')) return b.largeItems;
  return null;
}

describe('reportCore 基础口径', () => {
  it('debtRatioOf 零资产返回 null', () => {
    expect(debtRatioOf(100, 0)).toBeNull();
    expect(debtRatioOf(50, 200)).toBe(0.25);
  });

  it('totalsOf 输出元与负债率', () => {
    const t = totalsOf(b);
    expect(t.totalAssets).toBe(330_000);
    expect(t.netWorth).toBe(272_000);
    expect(t.debtRatio).toBeCloseTo(0.1758, 4);
    expect(t.balance).toBe(13_000);
  });
});

describe('reportCore 图表数据', () => {
  it('buildTreemap 模块 → 子项金额', () => {
    const tm = buildTreemap(b);
    expect(tm.map((m) => m.module)).toEqual(['金融资产', '实物资产']);
    expect(tm[0].children.map((c) => c.name)).toEqual(expect.arrayContaining(['活期', '基金']));
  });

  it('buildSankey 剔除 0 金额并给出结余比', () => {
    const sk = buildSankey(b);
    expect(sk.income.map((i) => i.cat)).toEqual(['工资收入']);
    expect(sk.totalIncome).toBe(25_000);
    expect(sk.balance).toBe(13_000);
    expect(sk.balanceRatio).toBeCloseTo(0.52, 4);
  });

  it('buildSankeyFromAmounts 无收入时 balanceRatio 为 null', () => {
    expect(buildSankeyFromAmounts([], [{ cat: '餐饮', amountCents: 100 }]).balanceRatio).toBeNull();
  });
});

describe('reportCore 收益率四态', () => {
  it('有新增资金且填了收益 → converted', () => {
    const prev = bundleFactory({ assets: [{ node_id: 11, balance_cents: 5_000_00, has_new_funds: 0, update_source: 'current' }, { node_id: 12, balance_cents: 10_000_00, has_new_funds: 0, update_source: 'current' }, { node_id: 21, balance_cents: 300_000_00, has_new_funds: 0, update_source: 'current' }] });
    const rows = buildGainCompare(b, prev);
    const fin = rows.find((r) => r.module === '金融资产');
    expect(fin?.mode).toBe('converted');
    expect(fin?.gain).toBe(500);
  });

  it('无新增资金且上期有余额 → auto', () => {
    const prev = bundleFactory({ assets: [{ node_id: 11, balance_cents: 8_000_00, has_new_funds: 0, update_source: 'current' }, { node_id: 12, balance_cents: 15_000_00, has_new_funds: 0, update_source: 'current' }, { node_id: 21, balance_cents: 300_000_00, has_new_funds: 0, update_source: 'current' }] });
    const now = bundleFactory({ assets: [{ node_id: 11, balance_cents: 10_000_00, has_new_funds: 0, update_source: 'current' }, { node_id: 12, balance_cents: 20_000_00, has_new_funds: 0, update_source: 'current' }, { node_id: 21, balance_cents: 300_000_00, has_new_funds: 0, update_source: 'current' }] });
    const rows = buildGainCompare(now, prev);
    expect(rows.find((r) => r.module === '金融资产')?.mode).toBe('auto');
  });

  it('新增资金但收益留空 → blank', () => {
    const blank = bundleFactory({ gains: [{ module_node_id: 12, gain_cents: null }] });
    const rows = buildGainCompare(blank, null);
    expect(rows.find((r) => r.module === '金融资产')?.mode).toBe('blank');
  });

  it('无上期数据 → na', () => {
    const rows = buildGainCompare(bundleFactory({ gains: [], assets: [{ node_id: 11, balance_cents: 1, has_new_funds: 0, update_source: 'current' }, { node_id: 12, balance_cents: 1, has_new_funds: 0, update_source: 'current' }, { node_id: 21, balance_cents: 1, has_new_funds: 0, update_source: 'current' }] }), null);
    expect(rows.every((r) => r.mode === 'na')).toBe(true);
  });
});

describe('reportCore 三张表', () => {
  it('buildBalanceSheet 长短期负债拆分', () => {
    const bs = buildBalanceSheet(b);
    expect(bs.kpi.shortTermDebt).toBe(8_000);
    expect(bs.kpi.longTermDebt).toBe(50_000);
    expect(bs.debtDonut).toHaveLength(2);
    expect(bs.details.debts.map((d) => d.name)).toEqual(['房贷', '信用卡']);
  });

  it('buildIncomeStatement 含 sankey 与明细', () => {
    const is = buildIncomeStatement(b);
    expect(is.kpi.totalIncome).toBe(25_000);
    expect(is.groupBar.expense[0].cat).toBe('生活支出');
    expect(is.details.expense[0].children.map((c) => c.cat)).toEqual(['餐饮', '交通']);
  });

  it('buildCatDetails 大额明细挂在二级分类下', () => {
    const d = buildCatDetails(b);
    expect(d.expense[0].children[0].largeItems[0].name).toBe('年夜饭');
  });

  it('buildCashFlow 无上期返回 null；有上期时恒等式成立', () => {
    expect(buildCashFlow(b, null)).toBeNull();
    const prev = bundleFactory({ totalAssetsCents: 300_000_00 });
    const cf = buildCashFlow(b, prev)!;
    const parts = cf.waterfall.slice(1, 4).reduce((s, x) => s + x.amount, 0);
    expect(parts).toBeCloseTo(cf.waterfall[4].amount - cf.waterfall[0].amount, 6);
  });

  it('reportLabel 按报告类型生成标签', () => {
    expect(reportLabel('quarter', '2026-04')).toBe('2026Q2 季报');
    expect(reportLabel('half', '2026-04')).toBe('2026H2 半年报');
    expect(reportLabel('year', '2026-04')).toBe('2026 年报');
  });
});

describe('reportCore 异步聚合', () => {
  it('resolveRange 支持 12m/year/all 与非法值', async () => {
    const db = mockDb(dbHandler);
    const all = await resolveRange(db, 'all', null);
    expect(all.months).toEqual(['2026-09', '2026-10']);
    const year = await resolveRange(db, 'year', '2026');
    expect(year.months).toHaveLength(2);
    expect((await resolveRange(db, 'year', null)).error).toContain('year');
    expect((await resolveRange(db, 'week', null)).error).toContain('range');
    expect((await resolveRange(db, '12m', null)).range).toBe('12m');
  });

  it('buildTrend 输出月份、总额与模块序列', async () => {
    const trend = await buildTrend(mockDb(dbHandler), ['2026-09', '2026-10']);
    expect(trend.months).toEqual(['2026-09', '2026-10']);
    expect(trend.total).toHaveLength(2);
    expect(trend.byModule.map((m) => m.module)).toEqual(['金融资产', '实物资产']);
  });

  it('buildUpdateStatus 标注 updated/carried 与最近更新月', async () => {
    const carried = bundleFactory({ assets: [{ node_id: 11, balance_cents: 10_000_00, has_new_funds: 0, update_source: 'carried' }, { node_id: 12, balance_cents: 20_000_00, has_new_funds: 0, update_source: 'current' }, { node_id: 21, balance_cents: 300_000_00, has_new_funds: 0, update_source: 'current' }] });
    const rows = await buildUpdateStatus(mockDb(dbHandler), carried);
    expect(rows.find((r) => r.nodeId === 11)?.status).toBe('carried');
    expect(rows.find((r) => r.nodeId === 12)?.status).toBe('updated');
    expect(rows.find((r) => r.nodeId === 11)?.lastUpdatedMonth).toBe('2026-10');
  });

  it('aggregatePeriod 汇总期间收支', async () => {
    const agg = await aggregatePeriod(mockDb(dbHandler), '2026-09', '2026-10');
    expect(agg.bundles).toHaveLength(2);
    expect(agg.totalIncomeCents).toBe(50_000_00);
    expect(agg.incomeByName.get('工资收入')).toBe(50_000_00);
  });
});
