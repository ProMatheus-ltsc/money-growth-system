/**
 * 月度快照（05 §3.7/§3.8/§3.9，F-02/F-02b/F-02c/F-03/F-12）：
 * - GET  /snapshots        列表·趋势聚合（仅 admin；viewer 趋势走 reports/assets）
 * - GET  /snapshots/:month 单月详情（有快照全量 / 无快照：沿用清单 + 负债默认值）
 * - PUT  /snapshots/:month 保存当月快照（仅当前月；历史月 → HISTORY_LOCKED）
 */
import { Hono } from 'hono';
import type { ErrorDetail } from '../lib/errors';
import { historyLocked, invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { centsToYuan, round4 } from '../lib/money';
import { addMonths, isValidMonth } from '../lib/month';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';
import {
  getAllDebts,
  getCatItems,
  getLatestCatConfig,
  getLatestTreeConfig,
  getSnapshotRow,
  getTreeNodes,
  loadBundle,
  moduleSumCents,
} from '../services/snapshotRepo';
import { asObject, serverCurrentMonth, validateSnapshotInput, writeSnapshot } from '../services/snapshotWriter';
import type { Freq } from '../services/treeUtil';
import { effectiveFreq, FREQ_INTERVAL, topAncestor, topLevelModules } from '../services/treeUtil';

const snapshots = new Hono<AppEnv>();

// §3.7 月度快照列表（趋势聚合）
snapshots.get('/', requireAuth, requireAdmin, async (c) => {
  const range = c.req.query('range') ?? '12m';
  const year = c.req.query('year') ?? null;
  if (range !== '12m' && range !== 'year' && range !== 'all') {
    throw invalidParam("range 取值必须为 '12m'/'year'/'all'");
  }
  if (range === 'year' && (!year || !/^\d{4}$/.test(year))) {
    throw invalidParam('range=year 时必须提供 year 参数');
  }
  const { results } = await c.env.DB.prepare('SELECT * FROM monthly_snapshots ORDER BY month ASC').all();
  let rows = results as { month: string; total_assets_cents: number; total_debt_cents: number; total_income_cents: number; total_expense_cents: number; corrected_at: string | null }[];
  if (range === 'year') rows = rows.filter((r) => r.month.startsWith(year as string));
  if (range === '12m') {
    const cutoff = addMonths(serverCurrentMonth(), -11);
    rows = rows.filter((r) => r.month >= cutoff);
  }

  const months = rows.map((r) => ({
    month: r.month,
    totalAssets: centsToYuan(r.total_assets_cents),
    totalDebt: centsToYuan(r.total_debt_cents),
    netWorth: centsToYuan(r.total_assets_cents - r.total_debt_cents),
    debtRatio: r.total_assets_cents > 0 ? round4(r.total_debt_cents / r.total_assets_cents) : null,
    totalIncome: centsToYuan(r.total_income_cents),
    totalExpense: centsToYuan(r.total_expense_cents),
    balance: centsToYuan(r.total_income_cents - r.total_expense_cents),
    corrected: r.corrected_at !== null,
  }));

  // byModule：顶层模块金额序列（模块名取各月钉住版本）
  const byModuleMap = new Map<string, { month: string; amount: number }[]>();
  for (const row of rows) {
    const b = await loadBundle(c.env.DB, row.month);
    if (!b) continue;
    for (const m of topLevelModules(b.treeNodes)) {
      if (m.enabled !== 1) continue;
      const arr = byModuleMap.get(m.name) ?? [];
      arr.push({ month: row.month, amount: centsToYuan(moduleSumCents(b, m.id)) });
      byModuleMap.set(m.name, arr);
    }
  }
  const byModule = [...byModuleMap.entries()].map(([module, points]) => ({ module, points }));

  return ok(c, { range, months, byModule });
});

// §3.8 单月快照详情
snapshots.get('/:month', requireAuth, requireAdmin, async (c) => {
  const month = c.req.param('month');
  if (!isValidMonth(month)) throw invalidParam('month 格式应为 YYYY-MM');

  const bundle = await loadBundle(c.env.DB, month);
  if (bundle) {
    const b = bundle;
    const s = b.snapshot;
    const totalAssets = s.total_assets_cents;
    const totalDebt = s.total_debt_cents;
    const catDirection = new Map(b.catItems.map((i) => [i.id, i.direction]));
    return ok(c, {
      exists: true,
      month,
      treeConfigId: s.tree_config_id,
      catConfigId: s.cat_config_id,
      treeNodes: b.treeNodes.map((n) => ({
        id: n.id,
        parentId: n.parent_id,
        name: n.name,
        nodeType: n.node_type,
        enabled: n.enabled === 1,
        sortOrder: n.sort_order,
        identityInfo: n.identity_info,
        assetCategory: n.asset_category ?? 'financial',
      })),
      assets: b.assets.map((a) => ({
        nodeId: a.node_id,
        balance: centsToYuan(a.balance_cents),
        hasNewFunds: a.has_new_funds === 1,
        updateSource: a.update_source,
      })),
      moduleGains: b.gains.map((g) => ({
        nodeId: g.module_node_id,
        gain: g.gain_cents === null ? null : centsToYuan(g.gain_cents),
      })),
      income: b.catAmounts
        .filter((ca) => catDirection.get(ca.cat_item_id) === 'income')
        .map((ca) => ({ catItemId: ca.cat_item_id, amount: centsToYuan(ca.amount_cents) })),
      expense: b.catAmounts
        .filter((ca) => catDirection.get(ca.cat_item_id) === 'expense')
        .map((ca) => ({ catItemId: ca.cat_item_id, amount: centsToYuan(ca.amount_cents) })),
      largeItems: b.largeItems.map((li) => ({
        id: li.id,
        direction: li.direction,
        catItemId: li.cat_item_id,
        name: li.name,
        amount: centsToYuan(li.amount_cents),
      })),
      debts: b.debtsSnap.map((sd) => {
        const master = b.debtsMaster.find((d) => d.id === sd.debt_id);
        return {
          debtId: sd.debt_id,
          balance: centsToYuan(sd.balance_cents),
          repayment: centsToYuan(sd.repayment_cents),
          fixedRepayment: master ? master.fixed_repayment === 1 : true,
        };
      }),
      totals: {
        totalAssets: centsToYuan(totalAssets),
        totalDebt: centsToYuan(totalDebt),
        netWorth: centsToYuan(totalAssets - totalDebt),
        debtRatio: totalAssets > 0 ? round4(totalDebt / totalAssets) : null,
        totalIncome: centsToYuan(s.total_income_cents),
        totalExpense: centsToYuan(s.total_expense_cents),
        balance: centsToYuan(s.total_income_cents - s.total_expense_cents),
      },
      correctedAt: s.corrected_at,
      locked: month < serverCurrentMonth(),
    });
  }

  // ---- 尚无快照：录入模板辅助信息（沿用上期清单 + 负债默认值） ----
  const treeConfig = await getLatestTreeConfig(c.env.DB);
  if (!treeConfig) throw notFound('资产树配置不存在');
  const treeNodes = await getTreeNodes(c.env.DB, treeConfig.id);
  const parents = new Set(treeNodes.map((n) => n.parent_id).filter((p): p is number => p !== null));
  const leaves = treeNodes.filter((n) => n.enabled === 1 && !parents.has(n.id));

  const carried: { nodeId: number; balance: number; lastUpdatedMonth: string }[] = [];
  for (const leaf of leaves) {
    const freq: Freq = effectiveFreq(treeNodes, leaf.id);
    const interval = FREQ_INTERVAL[freq];
    if (interval === null || interval <= 1) continue; // 月度/不定期：本期录入，无沿用
    const last = await c.env.DB.prepare(
      `SELECT sa.balance_cents, ms.month FROM snapshot_assets sa
       JOIN monthly_snapshots ms ON ms.id = sa.snapshot_id
       WHERE sa.node_id = ? AND sa.update_source = 'current'
       ORDER BY ms.month DESC LIMIT 1`
    )
      .bind(leaf.id)
      .first<{ balance_cents: number; month: string }>();
    if (!last) continue; // 从未录入过：需要首次录入
    // 非更新月（距上次更新不足一个周期）→ 沿用上期
    const idx = (y: string) => Number(y.slice(0, 4)) * 12 + Number(y.slice(5, 7));
    if ((idx(month) - idx(last.month)) % interval !== 0 || month === last.month) {
      carried.push({ nodeId: leaf.id, balance: centsToYuan(last.balance_cents), lastUpdatedMonth: last.month });
    }
  }

  const debts = await getAllDebts(c.env.DB);
  const latestSnapMonth = (await c.env.DB.prepare('SELECT MAX(month) AS m FROM monthly_snapshots').first<{ m: string | null }>())?.m;
  const debtDefaults: { debtId: number; name: string; fixedRepayment: boolean; monthlyPayment: number; lastBalance: number }[] = [];
  for (const d of debts.filter((x) => x.enabled === 1)) {
    let lastBalance = d.balance_cents;
    if (latestSnapMonth) {
      const sb = await loadBundle(c.env.DB, latestSnapMonth);
      const found = sb?.debtsSnap.find((x) => x.debt_id === d.id);
      if (found) lastBalance = found.balance_cents;
    }
    debtDefaults.push({
      debtId: d.id,
      name: d.name,
      fixedRepayment: d.fixed_repayment === 1,
      monthlyPayment: centsToYuan(d.monthly_payment_cents),
      lastBalance: centsToYuan(lastBalance),
    });
  }

  return ok(c, { exists: false, month, carried, debtDefaults });
});

// §3.9 保存当月快照
snapshots.put('/:month', requireAuth, requireAdmin, async (c) => {
  const month = c.req.param('month');
  if (!isValidMonth(month)) throw invalidParam('month 格式应为 YYYY-MM');
  const cur = serverCurrentMonth();
  if (month > cur) throw invalidParam('不能保存未来月份的快照');

  const body = asObject(await c.req.json().catch(() => null));
  if (!body) throw invalidParam('请求体必须为 JSON 对象');

  // 配置版本必须为最新（历史口径由钉住机制保护；当月录入一律用最新版本）
  const errors: ErrorDetail[] = [];
  const latestTree = await getLatestTreeConfig(c.env.DB);
  const latestCat = await getLatestCatConfig(c.env.DB);
  if (!latestTree || !latestCat) throw notFound('资产树或分类配置不存在');
  if (body.treeConfigId !== latestTree.id) {
    errors.push({ field: 'treeConfigId', message: `必须使用最新资产树配置（v${latestTree.version}）` });
  }
  if (body.catConfigId !== latestCat.id) {
    errors.push({ field: 'catConfigId', message: `必须使用最新分类配置（v${latestCat.version}）` });
  }
  if (errors.length > 0) throw invalidParam('快照校验失败', errors);

  const validated = await validateSnapshotInput(c.env.DB, month, body, errors);
  if (!validated || errors.length > 0) throw invalidParam('快照校验失败', errors);

  const result = await writeSnapshot(c.env.DB, month, validated);
  return ok(c, result);
});

export default snapshots;
