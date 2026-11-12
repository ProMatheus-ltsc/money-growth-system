/**
 * 快照聚合读取回归（F-04 四图同源）：loadBundle 装载、模块求和、分类路径与合计。
 */
import { describe, it, expect } from 'vitest';
import {
  getSnapshotRow,
  getLatestTreeConfig,
  getLatestCatConfig,
  getTreeNodes,
  getCatItems,
  getAllDebts,
  loadBundle,
  moduleSumCents,
  moduleHasNewFunds,
  catKeyPath,
  topCats,
  leafCats,
  catAmountByCat,
  requiredLeaves,
} from '../../backend/services/snapshotRepo.ts';
import { mockDb } from '../helpers/mockD1.ts';
import { treeNodes, catItems, debts, bundleFactory } from '../helpers/fixtures.ts';

const snapRow = bundleFactory().snapshot;

function handler(sql: string) {
  if (sql.includes('FROM monthly_snapshots WHERE month')) return snapRow;
  if (sql.includes('FROM tree_configs ORDER BY version')) return { id: 1, version: 1, effective_from_month: '2025-01', note: null };
  if (sql.includes('FROM cat_configs ORDER BY version')) return { id: 1, version: 1, threshold_cents: 100000 };
  if (sql.includes('FROM cat_configs WHERE id')) return { id: 1, version: 1, threshold_cents: 100000 };
  if (sql.includes('FROM tree_configs WHERE id')) return { id: 1, version: 1, effective_from_month: '2025-01', note: null };
  if (sql.includes('FROM tree_nodes')) return treeNodes();
  if (sql.includes('FROM cat_items')) return catItems();
  if (sql.includes('FROM debts ORDER BY')) return debts();
  if (sql.includes('FROM snapshot_assets')) return bundleFactory().assets;
  if (sql.includes('FROM snapshot_gains')) return bundleFactory().gains;
  if (sql.includes('FROM snapshot_debts')) return bundleFactory().debtsSnap;
  if (sql.includes('FROM snapshot_cat_amounts')) return bundleFactory().catAmounts;
  if (sql.includes('FROM snapshot_large_items')) return bundleFactory().largeItems;
  return null;
}

describe('snapshotRepo', () => {
  it('单项查询返回预期行', async () => {
    const db = mockDb(handler);
    expect((await getSnapshotRow(db, '2026-10'))?.month).toBe('2026-10');
    expect((await getLatestTreeConfig(db))?.version).toBe(1);
    expect((await getLatestCatConfig(db))?.threshold_cents).toBe(100000);
    expect(await getTreeNodes(db, 1)).toHaveLength(6);
    expect(await getCatItems(db, 1)).toHaveLength(6);
    expect(await getAllDebts(db)).toHaveLength(2);
  });

  it('无快照返回 null；配置缺失同样返回 null', async () => {
    const empty = mockDb(() => null);
    expect(await getSnapshotRow(empty, '2026-10')).toBeNull();
    expect(await loadBundle(empty, '2026-10')).toBeNull();
  });

  it('loadBundle 装载五表与钉住配置', async () => {
    const b = await loadBundle(mockDb(handler), '2026-10');
    expect(b?.snapshot.month).toBe('2026-10');
    expect(b?.treeNodes).toHaveLength(6);
    expect(b?.assets).toHaveLength(3);
    expect(b?.debtsMaster).toHaveLength(2);
  });

  it('模块求和按末级汇总', () => {
    const b = bundleFactory();
    expect(moduleSumCents(b, 1)).toBe(30_000_00);
    expect(moduleSumCents(b, 2)).toBe(300_000_00);
    expect(moduleHasNewFunds(b, 1)).toBe(true);
    expect(moduleHasNewFunds(b, 2)).toBe(false);
  });

  it('分类路径与一级分类排序', () => {
    const items = catItems();
    expect(catKeyPath(items, 111)).toBe('工资收入>月薪');
    expect(catKeyPath(items, 999)).toBe('');
    expect(topCats(items, 'expense').map((c) => c.name)).toEqual(['生活支出']);
    expect(leafCats(items, 'income').map((c) => c.id)).toEqual([111, 112]);
  });

  it('catAmountByCat 向上汇总到父分类', () => {
    const sums = catAmountByCat(bundleFactory());
    expect(sums.get(101)).toBe(25_000_00);
    expect(sums.get(201)).toBe(12_000_00);
    expect(sums.get(111)).toBe(20_000_00);
  });

  it('requiredLeaves 只返回启用末级', () => {
    expect(requiredLeaves(treeNodes()).map((n) => n.id)).toEqual([11, 12, 21]);
  });
});
