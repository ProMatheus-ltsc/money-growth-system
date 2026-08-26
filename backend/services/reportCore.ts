/**
 * 报表聚合核心（05 §3.10 / §3.11 的数据构造器）。
 * 被 /api/reports/*、/api/report-snapshots*、/api/pdf/payload、/api/ai/export 复用，
 * 保证「四图数据同源于当月快照」（PRD F-04 验收 1）。
 *
 * 金额口径：内部一律分（INTEGER），出参一律元（05 §1.1）。
 */
import type { Env } from '../env';
import { centsToYuan, round4 } from '../lib/money';
import { addMonths, monthOf, monthRange, yearOf } from '../lib/month';
import type { SnapshotBundle } from './snapshotRepo';
import { catAmountByCat, loadBundle, moduleHasNewFunds, moduleSumCents, topCats } from './snapshotRepo';
import { childrenOf, descendantLeaves, effectiveFreq, effectiveRate, nodeKeyPath, topLevelModules } from './treeUtil';

// ---------- 通用 ----------

export function debtRatioOf(totalDebtCents: number, totalAssetsCents: number): number | null {
  return totalAssetsCents > 0 ? round4(totalDebtCents / totalAssetsCents) : null;
}

export function totalsOf(b: SnapshotBundle) {
  const netWorth = b.snapshot.total_assets_cents - b.snapshot.total_debt_cents;
  return {
    totalAssets: centsToYuan(b.snapshot.total_assets_cents),
    totalDebt: centsToYuan(b.snapshot.total_debt_cents),
    netWorth: centsToYuan(netWorth),
    debtRatio: debtRatioOf(b.snapshot.total_debt_cents, b.snapshot.total_assets_cents),
    totalIncome: centsToYuan(b.snapshot.total_income_cents),
    totalExpense: centsToYuan(b.snapshot.total_expense_cents),
    balance: centsToYuan(b.snapshot.total_income_cents - b.snapshot.total_expense_cents),
  };
}

/** 树图数据：顶层模块 → 二级细分（子模块/账户），05 §3.10 treemap */
export function buildTreemap(b: SnapshotBundle) {
  const balanceOf = (nodeId: number) => {
    const leafIds = new Set(descendantLeaves(b.treeNodes, nodeId).map((n) => n.id));
    let sum = 0;
    for (const a of b.assets) if (leafIds.has(a.node_id)) sum += a.balance_cents;
    return sum;
  };
  return topLevelModules(b.treeNodes)
    .filter((m) => m.enabled === 1)
    .map((m) => {
      const kids = childrenOf(b.treeNodes, m.id);
      const children =
        kids.length > 0
          ? kids.map((k) => ({ name: k.name, amount: centsToYuan(balanceOf(k.id)) }))
          : descendantLeaves(b.treeNodes, m.id).map((l) => ({
              name: l.name,
              amount: centsToYuan(b.assets.find((a) => a.node_id === l.id)?.balance_cents ?? 0),
            }));
      return { module: m.name, amount: centsToYuan(balanceOf(m.id)), children };
    });
}

/** 桑基数据：单月收入类别 → 总收入 → 支出类别 + 结余（05 §3.10 sankey） */
export function buildSankeyFromAmounts(
  incomeByTopCat: { cat: string; amountCents: number }[],
  expenseByTopCat: { cat: string; amountCents: number }[]
) {
  const totalIncome = incomeByTopCat.reduce((s, i) => s + i.amountCents, 0);
  const totalExpense = expenseByTopCat.reduce((s, i) => s + i.amountCents, 0);
  const balance = totalIncome - totalExpense;
  return {
    income: incomeByTopCat.map((i) => ({ cat: i.cat, amount: centsToYuan(i.amountCents) })),
    totalIncome: centsToYuan(totalIncome),
    expense: expenseByTopCat.map((i) => ({ cat: i.cat, amount: centsToYuan(i.amountCents) })),
    balance: centsToYuan(balance),
    balanceRatio: totalIncome > 0 ? round4(balance / totalIncome) : null,
  };
}

export function buildSankey(b: SnapshotBundle) {
  const sums = catAmountByCat(b);
  const pick = (direction: 'income' | 'expense') =>
    topCats(b.catItems, direction)
      .map((c) => ({ cat: c.name, amountCents: sums.get(c.id) ?? 0 }))
      .filter((c) => c.amountCents !== 0 || true);
  return buildSankeyFromAmounts(pick('income'), pick('expense'));
}

// ---------- 趋势 ----------

export interface TrendResult {
  months: string[];
  total: number[];
  expected: number[];
  byModule: { module: string; amounts: number[] }[];
}

/**
 * 趋势数据（05 §3.10 trend）：
 * - total 实际总资产（实线）；
 * - expected 按「首月各模块余额 × (1+目标月收益率)^n」复利生成（虚线，口径与 demo 一致）；
 * - byModule 各顶层模块金额序列（堆叠面积分层）。
 */
export async function buildTrend(db: Env['DB'], monthList: string[]): Promise<TrendResult> {
  const bundles: (SnapshotBundle | null)[] = await Promise.all(monthList.map((m) => loadBundle(db, m)));
  const present = bundles.filter((b): b is SnapshotBundle => b !== null);
  const months: string[] = [];
  const total: number[] = [];
  const moduleSeries = new Map<string, number[]>();
  const baseByModule = new Map<string, number>();
  const rateByModule = new Map<string, number>();
  let baseSet = false;

  for (let i = 0; i < monthList.length; i++) {
    const b = bundles[i];
    if (!b) continue;
    months.push(monthList[i]);
    total.push(centsToYuan(b.snapshot.total_assets_cents));
    for (const m of topLevelModules(b.treeNodes)) {
      if (m.enabled !== 1) continue;
      const amt = moduleSumCents(b, m.id);
      const arr = moduleSeries.get(m.name) ?? [];
      // 序列对齐：前面缺月补 0 对齐长度
      while (arr.length < months.length - 1) arr.push(0);
      arr.push(centsToYuan(amt));
      moduleSeries.set(m.name, arr);
      if (!baseSet) {
        baseByModule.set(m.name, amt);
        const annual = effectiveRate(b.treeNodes, m.id);
        rateByModule.set(m.name, annual === null ? 0 : annual / 12);
      }
    }
    baseSet = baseSet || present.length > 0;
  }
  // 对齐所有模块序列长度
  for (const [, arr] of moduleSeries) while (arr.length < months.length) arr.push(0);

  const expected = months.map((_, i) => {
    let sum = 0;
    for (const [name, base] of baseByModule) {
      const r = rateByModule.get(name) ?? 0;
      sum += base * Math.pow(1 + r, i);
    }
    return centsToYuan(Math.round(sum));
  });

  return {
    months,
    total,
    expected,
    byModule: [...moduleSeries.entries()].map(([module, amounts]) => ({ module, amounts })),
  };
}

/** 按 range 计算月份窗口（快照月 ∩ 范围） */
export async function resolveRange(
  db: Env['DB'],
  range: string | undefined,
  year: string | null
): Promise<{ range: string; months: string[]; error?: string }> {
  const r = range ?? '12m';
  const { results } = await db.prepare('SELECT month FROM monthly_snapshots ORDER BY month ASC').all<{ month: string }>();
  const all = results.map((x) => x.month);
  if (r === 'year') {
    if (!year || !/^\d{4}$/.test(year)) return { range: r, months: [], error: 'range=year 时必须提供 year 参数' };
    return { range: r, months: all.filter((m) => m.startsWith(year)) };
  }
  if (r === 'all') return { range: r, months: all };
  if (r === '12m') {
    const now = new Date();
    const cur = `${now.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 7)}`;
    const cutoff = addMonths(cur, -11);
    return { range: r, months: all.filter((m) => m >= cutoff) };
  }
  return { range: r, months: [], error: "range 取值必须为 '12m'/'year'/'all'" };
}

// ---------- 收益率对比（F-03 四态） ----------

export interface GainCompareItem {
  module: string;
  targetMonthlyRate: number | null;
  actualRate: number | null;
  mode: 'auto' | 'converted' | 'blank' | 'na';
  gain: number | null;
}

export function buildGainCompare(b: SnapshotBundle, prev: SnapshotBundle | null): GainCompareItem[] {
  const out: GainCompareItem[] = [];
  for (const m of topLevelModules(b.treeNodes)) {
    if (m.enabled !== 1) continue;
    const annual = effectiveRate(b.treeNodes, m.id);
    const targetMonthlyRate = annual === null ? null : round4(annual / 12);
    const cur = moduleSumCents(b, m.id);
    const prevAmt = prev ? moduleSumCents(prev, m.id) : 0;
    const hasNew = moduleHasNewFunds(b, m.id);
    if (hasNew) {
      const leafIds = new Set(descendantLeaves(b.treeNodes, m.id).map((n) => n.id));
      const gainRows = b.gains.filter((g) => leafIds.has(g.module_node_id));
      const totalGainCents = gainRows.reduce((sum, g) => sum + (g.gain_cents ?? 0), 0);
      const allNull = gainRows.length === 0 || gainRows.every((g) => g.gain_cents === null);
      if (allNull) {
        out.push({ module: m.name, targetMonthlyRate, actualRate: null, mode: 'blank', gain: null });
      } else if (prevAmt <= 0) {
        out.push({
          module: m.name,
          targetMonthlyRate,
          actualRate: null,
          mode: 'na',
          gain: centsToYuan(totalGainCents),
        });
      } else {
        out.push({
          module: m.name,
          targetMonthlyRate,
          actualRate: round4(totalGainCents / prevAmt),
          mode: 'converted',
          gain: centsToYuan(totalGainCents),
        });
      }
    } else if (prevAmt > 0) {
      out.push({
        module: m.name,
        targetMonthlyRate,
        actualRate: round4((cur - prevAmt) / prevAmt),
        mode: 'auto',
        gain: null,
      });
    } else {
      out.push({ module: m.name, targetMonthlyRate, actualRate: null, mode: 'na', gain: null });
    }
  }
  return out;
}

// ---------- 更新状态表（F-12） ----------

export async function buildUpdateStatus(db: Env['DB'], b: SnapshotBundle) {
  const out: { nodeId: number; name: string; freq: string; status: 'updated' | 'carried'; lastUpdatedMonth: string | null }[] = [];
  const parents = new Set(b.treeNodes.map((n) => n.parent_id).filter((p): p is number => p !== null));
  const leaves = b.treeNodes.filter((n) => n.enabled === 1 && !parents.has(n.id));
  for (const leaf of leaves) {
    const row = b.assets.find((a) => a.node_id === leaf.id);
    const last = await db
      .prepare(
        `SELECT ms.month FROM snapshot_assets sa
         JOIN monthly_snapshots ms ON ms.id = sa.snapshot_id
         WHERE sa.node_id = ? AND sa.update_source = 'current'
         ORDER BY ms.month DESC LIMIT 1`
      )
      .bind(leaf.id)
      .first<{ month: string }>();
    out.push({
      nodeId: leaf.id,
      name: nodeKeyPath(b.treeNodes, leaf.id),
      freq: effectiveFreq(b.treeNodes, leaf.id),
      status: row && row.update_source === 'carried' ? 'carried' : 'updated',
      lastUpdatedMonth: last?.month ?? null,
    });
  }
  return out;
}

// ---------- 财务三张表（05 §3.11） ----------

export function buildBalanceSheet(b: SnapshotBundle) {
  const debtByTerm = { short: 0, long: 0 };
  const debtsDetail: { name: string; term: string; balance: number }[] = [];
  for (const sd of b.debtsSnap) {
    const master = b.debtsMaster.find((d) => d.id === sd.debt_id);
    const term = master?.term ?? 'long';
    debtByTerm[term] += sd.balance_cents;
    debtsDetail.push({ name: master?.name ?? `负债#${sd.debt_id}`, term, balance: centsToYuan(sd.balance_cents) });
  }
  const assetsDetail = topLevelModules(b.treeNodes)
    .filter((m) => m.enabled === 1)
    .map((m) => ({ name: m.name, amount: centsToYuan(moduleSumCents(b, m.id)) }));
  return {
    kpi: {
      totalAssets: centsToYuan(b.snapshot.total_assets_cents),
      totalDebt: centsToYuan(b.snapshot.total_debt_cents),
      shortTermDebt: centsToYuan(debtByTerm.short),
      longTermDebt: centsToYuan(debtByTerm.long),
      netWorth: centsToYuan(b.snapshot.total_assets_cents - b.snapshot.total_debt_cents),
      debtRatio: debtRatioOf(b.snapshot.total_debt_cents, b.snapshot.total_assets_cents),
    },
    assetTreemap: buildTreemap(b),
    debtDonut: [
      { term: 'short', amount: centsToYuan(debtByTerm.short) },
      { term: 'long', amount: centsToYuan(debtByTerm.long) },
    ],
    details: { assets: assetsDetail, debts: debtsDetail },
  };
}

export function buildIncomeStatement(b: SnapshotBundle) {
  const sums = catAmountByCat(b);
  const groupOf = (direction: 'income' | 'expense') =>
    topCats(b.catItems, direction).map((c) => ({ cat: c.name, amount: centsToYuan(sums.get(c.id) ?? 0) }));
  return {
    kpi: {
      totalIncome: centsToYuan(b.snapshot.total_income_cents),
      totalExpense: centsToYuan(b.snapshot.total_expense_cents),
      balance: centsToYuan(b.snapshot.total_income_cents - b.snapshot.total_expense_cents),
    },
    sankey: buildSankey(b),
    groupBar: { income: groupOf('income'), expense: groupOf('expense') },
    details: buildCatDetails(b),
  };
}

/**
 * 收支明细：一级 → 二级 → 大额单笔（历史版本分类带 historical 标记，前端归入「历史分类」区，F-02b 规则 5）。
 * historical 判定：该分类（按名称路径）不存在于最新分类配置中。
 */
export function buildCatDetails(b: SnapshotBundle) {
  const ofDirection = (direction: 'income' | 'expense') => {
    return topCats(b.catItems, direction).map((top) => {
      const children = b.catItems
        .filter((i) => i.parent_id === top.id)
        .sort((x, y) => x.sort_order - y.sort_order || x.id - y.id)
        .map((leaf) => ({
          cat: leaf.name,
          amount: centsToYuan(b.catAmounts.find((ca) => ca.cat_item_id === leaf.id)?.amount_cents ?? 0),
          largeItems: b.largeItems
            .filter((li) => li.cat_item_id === leaf.id && li.direction === direction)
            .map((li) => ({ name: li.name, amount: centsToYuan(li.amount_cents) })),
        }));
      return {
        cat: top.name,
        amount: centsToYuan(
          b.catItems
            .filter((i) => i.parent_id === top.id)
            .reduce((s, leaf) => s + (b.catAmounts.find((ca) => ca.cat_item_id === leaf.id)?.amount_cents ?? 0), 0)
        ),
        children,
      };
    });
  };
  return { income: ofDirection('income'), expense: ofDirection('expense') };
}

/**
 * 现金流量表（03-prd Q8 定论口径）：
 * closing=当月末总资产，opening=上月末总资产，netCashFlow = closing − opening（恒等）；
 * 构成 = 当期结余 + 负债净变动（负债增加为正） + 估值与其他（平衡项）。
 * 上月无快照返回 null（前端提示）。
 */
export function buildCashFlow(b: SnapshotBundle, prev: SnapshotBundle | null) {
  if (!prev) return null;
  const opening = prev.snapshot.total_assets_cents;
  const closing = b.snapshot.total_assets_cents;
  const netCashFlow = closing - opening;
  const balance = b.snapshot.total_income_cents - b.snapshot.total_expense_cents;
  const debtNetChange = b.snapshot.total_debt_cents - prev.snapshot.total_debt_cents;
  const valuation = netCashFlow - balance - debtNetChange;
  return {
    kpi: {
      openingCash: centsToYuan(opening),
      netCashFlow: centsToYuan(netCashFlow),
      closingCash: centsToYuan(closing),
    },
    waterfall: [
      { name: '期初现金', amount: centsToYuan(opening), type: 'start' as const },
      { name: '当期结余', amount: centsToYuan(balance), type: 'delta' as const },
      { name: '负债净变动', amount: centsToYuan(debtNetChange), type: 'delta' as const },
      { name: '估值与其他（平衡项）', amount: centsToYuan(valuation), type: 'delta' as const },
      { name: '期末现金', amount: centsToYuan(closing), type: 'end' as const },
    ],
    details: [
      { name: '当期结余', formula: '总收入 − 总支出', amount: centsToYuan(balance) },
      { name: '负债净变动', formula: '期末总负债 − 期初总负债（负债增加为正/流入）', amount: centsToYuan(debtNetChange) },
      {
        name: '估值与其他（平衡项）',
        formula: '净现金流 − 当期结余 − 负债净变动（吸收估值/新增资金归因差，保证恒等）',
        amount: centsToYuan(valuation),
      },
    ],
  };
}

export async function buildFinanceReport(db: Env['DB'], b: SnapshotBundle) {
  const prevMonth = addMonths(b.snapshot.month, -1);
  const prev = await loadBundle(db, prevMonth);
  return {
    month: b.snapshot.month,
    balanceSheet: buildBalanceSheet(b),
    incomeStatement: buildIncomeStatement(b),
    cashFlow: buildCashFlow(b, prev),
    notes: { debtRatioNote: '唯一住房资产价值未计入资产，房贷负债计入' },
  };
}

// ---------- 资产报表聚合（05 §3.10） ----------

export async function buildAssetReport(
  db: Env['DB'],
  b: SnapshotBundle,
  range: string | undefined,
  year: string | null
) {
  const month = b.snapshot.month;
  const prev = await loadBundle(db, addMonths(month, -1));
  const resolved = await resolveRange(db, range, year);
  const trend = await buildTrend(db, resolved.months);
  return {
    kpi: {
      totalAssets: centsToYuan(b.snapshot.total_assets_cents),
      netWorth: centsToYuan(b.snapshot.total_assets_cents - b.snapshot.total_debt_cents),
      momGrowth: prev
        ? prev.snapshot.total_assets_cents > 0
          ? round4(
              (b.snapshot.total_assets_cents - prev.snapshot.total_assets_cents) / prev.snapshot.total_assets_cents
            )
          : null
        : null,
      debtRatio: debtRatioOf(b.snapshot.total_debt_cents, b.snapshot.total_assets_cents),
    },
    trend,
    treemap: buildTreemap(b),
    sankey: buildSankey(b),
    gainCompare: buildGainCompare(b, prev),
    updateStatus: await buildUpdateStatus(db, b),
  };
}

// ---------- 报告快照标签 ----------

export function reportLabel(reportType: string, startMonth: string): string {
  const y = yearOf(startMonth);
  const m = monthOf(startMonth);
  if (reportType === 'quarter') return `${y}Q${(m - 1) / 3 + 1} 季报`;
  if (reportType === 'half') return `${y}H${m === 1 ? 1 : 2} 半年报`;
  return `${y} 年报`;
}

// ---------- 期间聚合（报告快照用） ----------

export interface PeriodAgg {
  months: string[];
  bundles: SnapshotBundle[];
  periodBalanceCents: number;
  incomeByName: Map<string, number>;
  expenseByName: Map<string, number>;
  totalIncomeCents: number;
  totalExpenseCents: number;
}

export async function aggregatePeriod(db: Env['DB'], startMonth: string, endMonth: string): Promise<PeriodAgg> {
  const months = monthRange(startMonth, endMonth);
  const loaded = await Promise.all(months.map((m) => loadBundle(db, m)));
  const bundles: SnapshotBundle[] = [];
  const incomeByName = new Map<string, number>();
  const expenseByName = new Map<string, number>();
  let periodBalanceCents = 0;
  let totalIncomeCents = 0;
  let totalExpenseCents = 0;
  for (const b of loaded) {
    if (!b) continue;
    bundles.push(b);
    periodBalanceCents += b.snapshot.total_income_cents - b.snapshot.total_expense_cents;
    totalIncomeCents += b.snapshot.total_income_cents;
    totalExpenseCents += b.snapshot.total_expense_cents;
    const sums = catAmountByCat(b);
    for (const dir of ['income', 'expense'] as const) {
      const target = dir === 'income' ? incomeByName : expenseByName;
      for (const top of topCats(b.catItems, dir)) {
        const amt = sums.get(top.id) ?? 0;
        if (amt !== 0) target.set(top.name, (target.get(top.name) ?? 0) + amt);
      }
    }
  }
  return { months, bundles, periodBalanceCents, incomeByName, expenseByName, totalIncomeCents, totalExpenseCents };
}

