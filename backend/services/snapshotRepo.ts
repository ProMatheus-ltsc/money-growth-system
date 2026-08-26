/**
 * 快照聚合读取：把月度快照 + 所钉住的配置版本 + 五张明细表装载为 SnapshotBundle，
 * 供报表/报告快照/纠错差异等场景复用（保证四图同源，PRD F-04 验收 1）。
 */
import type { Env } from '../env';
import type { TreeNodeRow } from './treeUtil';
import { descendantLeaves, enabledLeaves } from './treeUtil';

export interface SnapshotRow {
  id: number;
  month: string;
  tree_config_id: number;
  cat_config_id: number;
  total_assets_cents: number;
  total_debt_cents: number;
  total_income_cents: number;
  total_expense_cents: number;
  created_at: string;
  updated_at: string;
  corrected_at: string | null;
}

export interface CatItemRow {
  id: number;
  config_id: number;
  parent_id: number | null;
  direction: 'income' | 'expense';
  name: string;
  sort_order: number;
}

export interface CatConfigRow {
  id: number;
  version: number;
  threshold_cents: number;
}

export interface TreeConfigRow {
  id: number;
  version: number;
  effective_from_month: string;
  note: string | null;
}

export interface DebtRow {
  id: number;
  name: string;
  debt_type: 'mortgage' | 'auto_loan' | 'credit_card' | 'other';
  term: 'short' | 'long';
  balance_cents: number;
  annual_rate: number;
  monthly_payment_cents: number;
  fixed_repayment: number;
  enabled: number;
  sort_order: number;
}

export interface SnapshotBundle {
  snapshot: SnapshotRow;
  treeConfig: TreeConfigRow;
  treeNodes: TreeNodeRow[];
  catConfig: CatConfigRow;
  catItems: CatItemRow[];
  assets: { node_id: number; balance_cents: number; has_new_funds: number; update_source: 'current' | 'carried' }[];
  gains: { module_node_id: number; gain_cents: number | null }[];
  debtsSnap: { debt_id: number; balance_cents: number; repayment_cents: number }[];
  catAmounts: { cat_item_id: number; amount_cents: number }[];
  largeItems: { id: number; direction: 'income' | 'expense'; cat_item_id: number; name: string; amount_cents: number }[];
  debtsMaster: DebtRow[];
}

export async function getSnapshotRow(db: Env['DB'], month: string): Promise<SnapshotRow | null> {
  return (await db
    .prepare('SELECT * FROM monthly_snapshots WHERE month = ?')
    .bind(month)
    .first()) as SnapshotRow | null;
}

export async function getLatestTreeConfig(db: Env['DB']): Promise<TreeConfigRow | null> {
  return (await db
    .prepare('SELECT * FROM tree_configs ORDER BY version DESC LIMIT 1')
    .first()) as TreeConfigRow | null;
}

export async function getLatestCatConfig(db: Env['DB']): Promise<CatConfigRow | null> {
  return (await db
    .prepare('SELECT * FROM cat_configs ORDER BY version DESC LIMIT 1')
    .first()) as CatConfigRow | null;
}

export async function getTreeNodes(db: Env['DB'], configId: number): Promise<TreeNodeRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM tree_nodes WHERE config_id = ? ORDER BY sort_order, id')
    .bind(configId)
    .all<TreeNodeRow>();
  return results;
}

export async function getCatItems(db: Env['DB'], configId: number): Promise<CatItemRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM cat_items WHERE config_id = ? ORDER BY sort_order, id')
    .bind(configId)
    .all<CatItemRow>();
  return results;
}

export async function getAllDebts(db: Env['DB']): Promise<DebtRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM debts ORDER BY sort_order, id')
    .all<DebtRow>();
  return results;
}

/** 加载某月完整快照包；无快照返回 null */
export async function loadBundle(db: Env['DB'], month: string): Promise<SnapshotBundle | null> {
  const snapshot = await getSnapshotRow(db, month);
  if (!snapshot) return null;
  const [treeConfig, treeNodes, catConfig, catItems, assets, gains, debtsSnap, catAmounts, largeItems, debtsMaster] =
    await Promise.all([
      db.prepare('SELECT * FROM tree_configs WHERE id = ?').bind(snapshot.tree_config_id).first<TreeConfigRow>(),
      getTreeNodes(db, snapshot.tree_config_id),
      db.prepare('SELECT * FROM cat_configs WHERE id = ?').bind(snapshot.cat_config_id).first<CatConfigRow>(),
      getCatItems(db, snapshot.cat_config_id),
      db
        .prepare('SELECT node_id, balance_cents, has_new_funds, update_source FROM snapshot_assets WHERE snapshot_id = ?')
        .bind(snapshot.id)
        .all(),
      db.prepare('SELECT module_node_id, gain_cents FROM snapshot_gains WHERE snapshot_id = ?').bind(snapshot.id).all(),
      db.prepare('SELECT debt_id, balance_cents, repayment_cents FROM snapshot_debts WHERE snapshot_id = ?').bind(snapshot.id).all(),
      db.prepare('SELECT cat_item_id, amount_cents FROM snapshot_cat_amounts WHERE snapshot_id = ?').bind(snapshot.id).all(),
      db
        .prepare('SELECT id, direction, cat_item_id, name, amount_cents FROM snapshot_large_items WHERE snapshot_id = ?')
        .bind(snapshot.id)
        .all(),
      getAllDebts(db),
    ]);
  if (!treeConfig || !catConfig) return null;
  return {
    snapshot,
    treeConfig,
    treeNodes,
    catConfig,
    catItems,
    assets: assets.results as SnapshotBundle['assets'],
    gains: gains.results as SnapshotBundle['gains'],
    debtsSnap: debtsSnap.results as SnapshotBundle['debtsSnap'],
    catAmounts: catAmounts.results as SnapshotBundle['catAmounts'],
    largeItems: largeItems.results as SnapshotBundle['largeItems'],
    debtsMaster,
  };
}

/** 模块（顶层节点）当月余额 = 其后代末级录入余额之和 */
export function moduleSumCents(b: SnapshotBundle, moduleId: number): number {
  const leafIds = new Set(descendantLeaves(b.treeNodes, moduleId).map((n) => n.id));
  let sum = 0;
  for (const a of b.assets) if (leafIds.has(a.node_id)) sum += a.balance_cents;
  return sum;
}

/** 顶层模块是否存在新增资金（任一末级 has_new_funds=1） */
export function moduleHasNewFunds(b: SnapshotBundle, moduleId: number): boolean {
  const leafIds = new Set(descendantLeaves(b.treeNodes, moduleId).map((n) => n.id));
  return b.assets.some((a) => leafIds.has(a.node_id) && a.has_new_funds === 1);
}

/** 分类项（叶子分类）名称路径："一级>二级" */
export function catKeyPath(items: CatItemRow[], catItemId: number): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const parts: string[] = [];
  let cur = byId.get(catItemId);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parent_id !== null ? byId.get(cur.parent_id) : undefined;
  }
  return parts.join('>');
}

/** 一级分类（parent_id = null） */
export function topCats(items: CatItemRow[], direction: 'income' | 'expense'): CatItemRow[] {
  return items
    .filter((i) => i.parent_id === null && i.direction === direction)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

export function leafCats(items: CatItemRow[], direction: 'income' | 'expense'): CatItemRow[] {
  const parents = new Set(items.map((i) => i.parent_id).filter((p): p is number => p !== null));
  return items.filter((i) => i.direction === direction && !parents.has(i.id));
}

/** 一级分类合计 = 其二级之和（服务端求和，F-02b 规则 1） */
export function catAmountByCat(b: SnapshotBundle): Map<number, number> {
  const byId = new Map(b.catItems.map((i) => [i.id, i]));
  const sums = new Map<number, number>();
  for (const ca of b.catAmounts) {
    let cur = byId.get(ca.cat_item_id);
    while (cur) {
      sums.set(cur.id, (sums.get(cur.id) ?? 0) + ca.amount_cents);
      cur = cur.parent_id !== null ? byId.get(cur.parent_id) : undefined;
    }
  }
  return sums;
}

/** 当前配置下全部启用末级节点（用于录入覆盖校验） */
export function requiredLeaves(nodes: TreeNodeRow[]): TreeNodeRow[] {
  return enabledLeaves(nodes);
}
