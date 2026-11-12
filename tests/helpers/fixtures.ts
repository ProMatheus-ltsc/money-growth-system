/**
 * 服务层测试夹具：资产树 / 分类 / 负债 / 快照包。
 * 树形：模块 1「金融资产」(年化 6%) → 末级 11「活期」、12「基金」；模块 2「实物资产」→ 末级 21「自住房」
 */
import type { SnapshotBundle, CatItemRow, DebtRow } from '../../backend/services/snapshotRepo';
import type { TreeNodeRow } from '../../backend/services/treeUtil';

export function treeNodes(): TreeNodeRow[] {
  const base = {
    config_id: 1,
    identity_info: null,
    is_placeholder: 0,
    asset_category: 'financial' as const,
    liquidity: 'medium' as const,
  };
  return [
    { ...base, id: 1, parent_id: null, name: '金融资产', node_type: 'module', target_rate_annual: 0.06, update_freq: null, enabled: 1, sort_order: 1 },
    { ...base, id: 11, parent_id: 1, name: '活期', node_type: 'leaf', target_rate_annual: null, update_freq: 'monthly', enabled: 1, sort_order: 1 },
    { ...base, id: 12, parent_id: 1, name: '基金', node_type: 'leaf', target_rate_annual: null, update_freq: 'quarterly', enabled: 1, sort_order: 2 },
    { ...base, id: 13, parent_id: 1, name: '停用账户', node_type: 'leaf', target_rate_annual: null, update_freq: 'irregular', enabled: 0, sort_order: 3 },
    { ...base, id: 2, parent_id: null, name: '实物资产', node_type: 'module', target_rate_annual: null, update_freq: null, enabled: 1, sort_order: 2, asset_category: 'physical' },
    { ...base, id: 21, parent_id: 2, name: '自住房', node_type: 'leaf', target_rate_annual: 0.02, update_freq: 'annual', enabled: 1, sort_order: 1, asset_category: 'physical' },
  ];
}

export function catItems(): CatItemRow[] {
  return [
    { id: 101, config_id: 1, parent_id: null, direction: 'income', name: '工资收入', sort_order: 1 },
    { id: 111, config_id: 1, parent_id: 101, direction: 'income', name: '月薪', sort_order: 1 },
    { id: 112, config_id: 1, parent_id: 101, direction: 'income', name: '奖金', sort_order: 2 },
    { id: 201, config_id: 1, parent_id: null, direction: 'expense', name: '生活支出', sort_order: 1 },
    { id: 211, config_id: 1, parent_id: 201, direction: 'expense', name: '餐饮', sort_order: 1 },
    { id: 212, config_id: 1, parent_id: 201, direction: 'expense', name: '交通', sort_order: 2 },
  ];
}

export function debts(): DebtRow[] {
  return [
    {
      id: 1, name: '房贷', debt_type: 'mortgage', term: 'long', balance_cents: 50_000_00,
      annual_rate: 0.041, monthly_payment_cents: 3_000_00, fixed_repayment: 1, enabled: 1, sort_order: 1,
    },
    {
      id: 2, name: '信用卡', debt_type: 'credit_card', term: 'short', balance_cents: 8_000_00,
      annual_rate: 0.18, monthly_payment_cents: 0, fixed_repayment: 0, enabled: 1, sort_order: 2,
    },
  ];
}

export function bundleFactory(overrides: {
  month?: string;
  totalAssetsCents?: number;
  assets?: SnapshotBundle['assets'];
  gains?: SnapshotBundle['gains'];
  catAmounts?: SnapshotBundle['catAmounts'];
  largeItems?: SnapshotBundle['largeItems'];
  debtsSnap?: SnapshotBundle['debtsSnap'];
  treeNodes?: TreeNodeRow[];
  catItems?: CatItemRow[];
} = {}): SnapshotBundle {
  const month = overrides.month ?? '2026-10';
  const assets = overrides.assets ?? [
    { node_id: 11, balance_cents: 10_000_00, has_new_funds: 0, update_source: 'current' as const },
    { node_id: 12, balance_cents: 20_000_00, has_new_funds: 1, update_source: 'current' as const },
    { node_id: 21, balance_cents: 300_000_00, has_new_funds: 0, update_source: 'current' as const },
  ];
  const totalAssetsCents = overrides.totalAssetsCents ?? assets.reduce((s, a) => s + a.balance_cents, 0);
  return {
    snapshot: {
      id: 1, month, tree_config_id: 1, cat_config_id: 1,
      total_assets_cents: totalAssetsCents, total_debt_cents: 58_000_00,
      total_income_cents: 25_000_00, total_expense_cents: 12_000_00,
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', corrected_at: null,
    },
    treeConfig: { id: 1, version: 1, effective_from_month: '2025-01', note: null },
    treeNodes: overrides.treeNodes ?? treeNodes(),
    catConfig: { id: 1, version: 1, threshold_cents: 1_000_00 },
    catItems: overrides.catItems ?? catItems(),
    assets,
    gains: overrides.gains ?? [{ module_node_id: 12, gain_cents: 500_00 }],
    debtsSnap: overrides.debtsSnap ?? [
      { debt_id: 1, balance_cents: 50_000_00, repayment_cents: 3_000_00 },
      { debt_id: 2, balance_cents: 8_000_00, repayment_cents: 1_000_00 },
    ],
    catAmounts: overrides.catAmounts ?? [
      { cat_item_id: 111, amount_cents: 20_000_00 },
      { cat_item_id: 112, amount_cents: 5_000_00 },
      { cat_item_id: 211, amount_cents: 8_000_00 },
      { cat_item_id: 212, amount_cents: 4_000_00 },
    ],
    largeItems: overrides.largeItems ?? [
      { id: 1, direction: 'expense', cat_item_id: 211, name: '年夜饭', amount_cents: 2_000_00 },
    ],
    debtsMaster: debts(),
  };
}
