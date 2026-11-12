/**
 * 快照校验与写入回归（F-02 / 05 §3.9）：末级覆盖、carried 防改、收益/分类/大额/负债规则、事务写入汇总。
 */
import { describe, it, expect } from 'vitest';
import { validateSnapshotInput, writeSnapshot, serverCurrentMonth, prevMonthOf, asObject } from '../../backend/services/snapshotWriter.ts';
import { mockDb, ranSql } from '../helpers/mockD1.ts';
import { treeNodes, catItems, debts } from '../helpers/fixtures.ts';

const THRESHOLD = 1_000_00;

function handler(sql: string, args: unknown[]) {
  if (sql.includes('FROM tree_nodes')) return treeNodes();
  if (sql.includes('FROM cat_items')) return catItems();
  if (sql.includes('FROM cat_configs WHERE id')) return { threshold_cents: THRESHOLD };
  if (sql.includes('FROM debts ORDER BY')) return debts();
  if (sql.includes('JOIN monthly_snapshots ms ON ms.id = sa.snapshot_id') && sql.includes("update_source = 'current'")) {
    return { balance_cents: 10_000_00 };
  }
  if (sql.includes('FROM monthly_snapshots WHERE month')) return null;
  return null;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    treeConfigId: 1,
    catConfigId: 1,
    assets: [
      { nodeId: 11, balance: 10_000, hasNewFunds: false, updateSource: 'carried' },
      { nodeId: 12, balance: 20_000, hasNewFunds: true, updateSource: 'current' },
      { nodeId: 21, balance: 300_000, hasNewFunds: false, updateSource: 'current' },
    ],
    moduleGains: [{ nodeId: 12, gain: 500 }],
    income: [{ catItemId: 111, amount: 20_000 }],
    expense: [{ catItemId: 211, amount: 8_000 }],
    largeItems: [{ direction: 'expense', catItemId: 211, name: '年夜饭', amount: 2_000 }],
    debts: [
      { debtId: 1, balance: 50_000, repayment: 1 },
      { debtId: 2, balance: 8_000, repayment: 1_000 },
    ],
    ...overrides,
  } as Record<string, unknown>;
}

async function validate(overrides: Record<string, unknown> = {}, db = mockDb(handler)) {
  const errors: { field: string; message: string }[] = [];
  const out = await validateSnapshotInput(db as never, '2026-10', body(overrides) as never, errors);
  return { out, errors };
}

describe('validateSnapshotInput 正常路径', () => {
  it('完整合法请求通过并汇总', async () => {
    const { out, errors } = await validate();
    expect(errors).toEqual([]);
    expect(out?.totals.totalAssetsCents).toBe(330_000_00);
    expect(out?.totals.totalIncomeCents).toBe(20_000_00);
    // 固定还款负债由服务端覆盖为定额
    expect(out?.debts.find((d) => d.debt_id === 1)?.repayment_cents).toBe(3_000_00);
    expect(out?.debts.find((d) => d.debt_id === 2)?.repayment_cents).toBe(1_000_00);
  });
});

describe('validateSnapshotInput 错误路径', () => {
  it('缺配置 id 直接返回', async () => {
    const { out, errors } = await validate({ treeConfigId: undefined });
    expect(out).toBeNull();
    expect(errors.some((e) => e.field === 'treeConfigId')).toBe(true);
  });

  it('未知/停用节点被拒绝', async () => {
    const { errors } = await validate({ assets: [{ nodeId: 13, balance: 1, hasNewFunds: false, updateSource: 'current' }] });
    expect(errors.some((e) => e.message.includes('启用末级'))).toBe(true);
  });

  it('重复录入与缺末级都会报错', async () => {
    const { errors } = await validate({
      assets: [
        { nodeId: 11, balance: 1, hasNewFunds: false, updateSource: 'current' },
        { nodeId: 11, balance: 2, hasNewFunds: false, updateSource: 'current' },
      ],
    });
    expect(errors.some((e) => e.message.includes('重复录入'))).toBe(true);
    expect(errors.some((e) => e.message.includes('缺少启用末级节点'))).toBe(true);
  });

  it('carried 余额必须等于上次 current 值', async () => {
    const mismatch = await validate({
      assets: [{ nodeId: 11, balance: 1, hasNewFunds: false, updateSource: 'carried' }],
    });
    expect(mismatch.errors.some((e) => e.message.includes('必须等于上次录入值'))).toBe(true);

    const noPrev = await validate(
      { assets: [{ nodeId: 11, balance: 1, hasNewFunds: false, updateSource: 'carried' }] },
      mockDb((sql) => (sql.includes('JOIN monthly_snapshots') ? null : handler(sql, [])))
    );
    expect(noPrev.errors.some((e) => e.message.includes('无可沿用的上期录入值'))).toBe(true);
  });

  it('收益只能挂在新增资金的节点上', async () => {
    const { errors } = await validate({ moduleGains: [{ nodeId: 11, gain: 1 }] });
    expect(errors.some((e) => e.message.includes('新增资金'))).toBe(true);
  });

  it('分类方向不符/重复被拒绝', async () => {
    const { errors } = await validate({
      income: [
        { catItemId: 211, amount: 1 },
        { catItemId: 111, amount: 1 },
        { catItemId: 111, amount: 2 },
      ],
    });
    expect(errors.some((e) => e.field === 'income[0].catItemId')).toBe(true);
    expect(errors.some((e) => e.message.includes('分类重复录入'))).toBe(true);
  });

  it('大额低于阈值或名称超长被拒绝', async () => {
    const { errors } = await validate({
      largeItems: [
        { direction: 'expense', catItemId: 211, name: '小额', amount: 1 },
        { direction: 'expense', catItemId: 211, name: 'x'.repeat(51), amount: 2_000 },
      ],
    });
    expect(errors.some((e) => e.message.includes('低于阈值'))).toBe(true);
    expect(errors.some((e) => e.message.includes('1~50'))).toBe(true);
  });

  it('非固定还款负债必须填当次还款', async () => {
    const { errors } = await validate({
      debts: [
        { debtId: 1, balance: 50_000, repayment: 1 },
        { debtId: 2, balance: 8_000 },
      ],
    });
    expect(errors.some((e) => e.field === 'debts[1].repayment')).toBe(true);
  });

  it('缺启用负债项被拒绝', async () => {
    const { errors } = await validate({ debts: [{ debtId: 1, balance: 50_000, repayment: 1 }] });
    expect(errors.some((e) => e.message.includes('缺少启用负债项'))).toBe(true);
  });
});

describe('writeSnapshot', () => {
  it('新月份插入主表并批量写明细', async () => {
    const db = mockDb(handler);
    const { out } = await validate();
    const res = await writeSnapshot(db, '2026-10', out!);
    expect(res.month).toBe('2026-10');
    expect(res.totals.totalAssets).toBe(330_000);
    expect(ranSql(db, 'INSERT INTO monthly_snapshots')).toBe(true);
    expect(ranSql(db, 'INSERT INTO snapshot_assets')).toBe(true);
    expect(ranSql(db, 'UPDATE debts SET balance_cents')).toBe(true);
  });

  it('已有快照走覆盖路径（先删明细再写）', async () => {
    const db = mockDb((sql, args) =>
      sql.includes('FROM monthly_snapshots WHERE month') ? { id: 7 } : handler(sql, args)
    );
    const { out } = await validate();
    const res = await writeSnapshot(db, '2026-10', out!);
    expect(res.month).toBe('2026-10');
    expect(ranSql(db, 'DELETE FROM snapshot_assets')).toBe(true);
    expect(ranSql(db, 'UPDATE monthly_snapshots SET')).toBe(true);
  });

  it('serverCurrentMonth / prevMonthOf / asObject 工具', () => {
    expect(serverCurrentMonth()).toMatch(/^\d{4}-\d{2}$/);
    expect(prevMonthOf('2026-01')).toBe('2025-12');
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject(null)).toBeNull();
    expect(asObject([1])).toBeNull();
  });

  // P1 回归：负债主档只由「最新月」推进，历史纠错不得回写主档余额
  describe('负债主档同步边界', () => {
    it('写入月份 = 现存最大月 → 同步主档', async () => {
      const db = mockDb((sql, args) =>
        sql.includes('SELECT MAX(month) AS m FROM monthly_snapshots') ? { m: '2026-10' } : handler(sql, args)
      );
      const { out } = await validate();
      const res = await writeSnapshot(db, '2026-10', out!);
      expect(res.debtMasterSynced).toBe(true);
      expect(ranSql(db, 'UPDATE debts SET balance_cents')).toBe(true);
    });

    it('无任何快照（首月）→ 视为最新，同步主档', async () => {
      const db = mockDb(handler);
      const { out } = await validate();
      const res = await writeSnapshot(db, '2026-10', out!);
      expect(res.debtMasterSynced).toBe(true);
      expect(ranSql(db, 'UPDATE debts SET balance_cents')).toBe(true);
    });

    it('写入历史月（更早）→ 不同步主档，避免纠错污染负债页默认值', async () => {
      const db = mockDb((sql, args) =>
        sql.includes('SELECT MAX(month) AS m FROM monthly_snapshots') ? { m: '2026-11' } : handler(sql, args)
      );
      const { out } = await validate();
      const res = await writeSnapshot(db, '2026-09', out!);
      expect(res.debtMasterSynced).toBe(false);
      expect(ranSql(db, 'UPDATE debts SET balance_cents')).toBe(false);
      // 快照明细照常写入，只是不回写主档
      expect(ranSql(db, 'INSERT INTO snapshot_debts')).toBe(true);
    });

    it('覆盖路径（已有快照）同样遵守主档同步边界', async () => {
      const db = mockDb((sql, args) => {
        if (sql.includes('SELECT MAX(month) AS m FROM monthly_snapshots')) return { m: '2026-11' };
        if (sql.includes('FROM monthly_snapshots WHERE month')) return { id: 7 };
        return handler(sql, args);
      });
      const { out } = await validate();
      const res = await writeSnapshot(db, '2026-09', out!);
      expect(res.debtMasterSynced).toBe(false);
      expect(ranSql(db, 'UPDATE debts SET balance_cents')).toBe(false);
      expect(ranSql(db, 'UPDATE monthly_snapshots SET')).toBe(true);
    });
  });
});
