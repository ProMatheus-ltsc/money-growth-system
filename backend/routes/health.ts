/**
 * 财务健康指标 API（CPA 视角）：
 * - GET /health  返回流动性比率、储蓄率、偿债比率、净资产增长率、集中度预警、流动性结构等
 * - GET /health/config  返回健康配置阈值
 * - PUT /health/config  更新健康配置阈值（仅 admin）
 * 权限：admin + viewer（只读可见）。
 */
import { Hono } from 'hono';
import { invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { centsToYuan, round4 } from '../lib/money';
import { addMonths, isValidMonth } from '../lib/month';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { loadBundle, moduleSumCents } from '../services/snapshotRepo';
import { descendantLeaves, topLevelModules, type TreeNodeRow } from '../services/treeUtil';

interface HealthRatio {
  label: string;
  value: number | null;
  benchmark: string;
  status: 'excellent' | 'good' | 'warning' | 'danger';
  description: string;
}

interface ConcentrationItem {
  module: string;
  amount: number;
  ratio: number;
  warning: boolean;
}

interface LiquidityBreakdown {
  level: 'high' | 'medium' | 'low';
  label: string;
  amount: number;
  ratio: number;
}

const health = new Hono<AppEnv>();

function nodeLiquidity(n: TreeNodeRow): 'high' | 'medium' | 'low' {
  return n.liquidity ?? 'medium';
}

health.get('/', requireAuth, async (c) => {
  const month = c.req.query('month');
  if (!month || !isValidMonth(month)) throw invalidParam('month 参数必填且格式为 YYYY-MM');

  const bundle = await loadBundle(c.env.DB, month);
  if (!bundle) throw notFound(`${month} 尚无资产快照`);

  const prevMonth = addMonths(month, -1);
  const prevBundle = await loadBundle(c.env.DB, prevMonth);

  const configRows = await c.env.DB.prepare('SELECT key, value FROM health_config').all();
  const config = new Map<string, string>();
  for (const r of configRows.results as { key: string; value: string }[]) config.set(r.key, r.value);
  const concentrationThreshold = parseFloat(config.get('concentration_threshold') ?? '0.5');
  const liquidityMonthsMin = parseInt(config.get('liquidity_months_min') ?? '3', 10);
  const debtServiceMax = parseFloat(config.get('debt_service_ratio_max') ?? '0.4');
  const savingsRateMin = parseFloat(config.get('savings_rate_min') ?? '0.2');
  const cpiRate = parseFloat(config.get('cpi_annual_rate') ?? '0.02');

  const totalAssets = bundle.snapshot.total_assets_cents;
  const totalDebt = bundle.snapshot.total_debt_cents;
  const totalIncome = bundle.snapshot.total_income_cents;
  const totalExpense = bundle.snapshot.total_expense_cents;
  const netWorth = totalAssets - totalDebt;
  const balance = totalIncome - totalExpense;

  // --- 1. 储蓄率 = 当月结余 / 当月总收入 ---
  const savingsRate = totalIncome > 0 ? round4(balance / totalIncome) : null;
  const savingsStatus: HealthRatio['status'] =
    savingsRate === null ? 'warning'
      : savingsRate >= 0.3 ? 'excellent'
        : savingsRate >= savingsRateMin ? 'good'
          : savingsRate >= 0.1 ? 'warning' : 'danger';

  // --- 2. 偿债比率 = 每月还款总额 / 月收入 ---
  const monthlyRepayment = bundle.debtsMaster
    .filter((d) => d.enabled === 1)
    .reduce((s, d) => s + d.monthly_payment_cents, 0);
  const debtServiceRatio = totalIncome > 0 ? round4(monthlyRepayment / totalIncome) : null;
  const debtServiceStatus: HealthRatio['status'] =
    debtServiceRatio === null ? 'warning'
      : debtServiceRatio <= 0.28 ? 'excellent'
        : debtServiceRatio <= debtServiceMax ? 'good'
          : debtServiceRatio <= 0.5 ? 'warning' : 'danger';

  // --- 3. 流动性比率 = 高流动性资产 / 月均支出 ---
  const highLiquidLeafIds = new Set<number>();
  const modules = topLevelModules(bundle.treeNodes).filter((m) => m.enabled === 1);
  for (const m of modules) {
    if (nodeLiquidity(m) === 'high') {
      const leaves = descendantLeaves(bundle.treeNodes, m.id);
      for (const l of leaves) highLiquidLeafIds.add(l.id);
    } else {
      const leaves = descendantLeaves(bundle.treeNodes, m.id);
      for (const l of leaves) {
        if (nodeLiquidity(l) === 'high') highLiquidLeafIds.add(l.id);
      }
    }
  }
  let highLiquidTotal = 0;
  for (const a of bundle.assets) {
    if (highLiquidLeafIds.has(a.node_id)) highLiquidTotal += a.balance_cents;
  }
  const liquidityRatio = totalExpense > 0 ? round4(highLiquidTotal / totalExpense) : null;
  const liquidityStatus: HealthRatio['status'] =
    liquidityRatio === null ? 'warning'
      : liquidityRatio >= 6 ? 'excellent'
        : liquidityRatio >= liquidityMonthsMin ? 'good'
          : liquidityRatio >= 1 ? 'warning' : 'danger';

  // --- 4. 净资产增长率 = (本月净资产 - 上月净资产) / |上月净资产| ---
  const prevNetWorth = prevBundle ? prevBundle.snapshot.total_assets_cents - prevBundle.snapshot.total_debt_cents : null;
  const netWorthGrowth = prevNetWorth !== null && prevNetWorth !== 0
    ? round4((netWorth - prevNetWorth) / Math.abs(prevNetWorth))
    : null;
  const growthStatus: HealthRatio['status'] =
    netWorthGrowth === null ? 'warning'
      : netWorthGrowth >= 0.05 ? 'excellent'
        : netWorthGrowth >= 0 ? 'good'
          : netWorthGrowth >= -0.05 ? 'warning' : 'danger';

  // --- 5. 负债率 ---
  const debtRatio = totalAssets > 0 ? round4(totalDebt / totalAssets) : null;
  const debtRatioStatus: HealthRatio['status'] =
    debtRatio === null ? 'warning'
      : debtRatio <= 0.3 ? 'excellent'
        : debtRatio <= 0.5 ? 'good'
          : debtRatio <= 0.7 ? 'warning' : 'danger';

  const ratios: HealthRatio[] = [
    {
      label: '储蓄率',
      value: savingsRate,
      benchmark: `≥${(savingsRateMin * 100).toFixed(0)}% 为良好，≥30% 为优秀`,
      status: savingsStatus,
      description: '当月结余占总收入比例，反映财富积累能力',
    },
    {
      label: '偿债比率',
      value: debtServiceRatio,
      benchmark: `≤${(debtServiceMax * 100).toFixed(0)}% 为安全线`,
      status: debtServiceStatus,
      description: '每月还款额占月收入比例，衡量偿债压力',
    },
    {
      label: '流动性覆盖',
      value: liquidityRatio,
      benchmark: `≥${liquidityMonthsMin}个月支出为安全`,
      status: liquidityStatus,
      description: '高流动性资产可覆盖多少个月支出（紧急备用金充足度）',
    },
    {
      label: '净资产增速',
      value: netWorthGrowth,
      benchmark: '环比正增长为健康',
      status: growthStatus,
      description: '净资产月环比增长率，反映整体财富变动方向',
    },
    {
      label: '负债率',
      value: debtRatio,
      benchmark: '≤50% 为稳健',
      status: debtRatioStatus,
      description: '总负债占总资产比例，衡量杠杆水平',
    },
  ];

  // --- 6. 资产集中度 ---
  const concentration: ConcentrationItem[] = modules.map((m) => {
    const amt = moduleSumCents(bundle, m.id);
    const ratio = totalAssets > 0 ? round4(amt / totalAssets) : 0;
    return { module: m.name, amount: centsToYuan(amt), ratio, warning: ratio >= concentrationThreshold };
  }).sort((a, b) => b.ratio - a.ratio);

  // --- 7. 流动性结构 ---
  const liquidityMap = new Map<'high' | 'medium' | 'low', number>();
  for (const m of modules) {
    const liq = nodeLiquidity(m);
    const amt = moduleSumCents(bundle, m.id);
    liquidityMap.set(liq, (liquidityMap.get(liq) ?? 0) + amt);
  }
  const liquidityLabels: Record<string, string> = { high: '高流动性（随时变现）', medium: '中流动性（短期可变现）', low: '低流动性（长期锁定）' };
  const liquidityBreakdown: LiquidityBreakdown[] = (['high', 'medium', 'low'] as const).map((level) => {
    const amt = liquidityMap.get(level) ?? 0;
    return { level, label: liquidityLabels[level], amount: centsToYuan(amt), ratio: totalAssets > 0 ? round4(amt / totalAssets) : 0 };
  });

  // --- 8. 投资回报率对标（实际收益率 = 名义收益率 - CPI） ---
  const roiComparison: { module: string; nominalRate: number | null; realRate: number | null; cpiRate: number }[] = [];
  const prevBundleForRoi = prevBundle;
  for (const m of modules) {
    const curAmt = moduleSumCents(bundle, m.id);
    const prevAmt = prevBundleForRoi ? moduleSumCents(prevBundleForRoi, m.id) : 0;
    const nominalRate = prevAmt > 0 ? round4((curAmt - prevAmt) / prevAmt) : null;
    const monthlyCpi = round4(cpiRate / 12);
    const realRate = nominalRate !== null ? round4(nominalRate - monthlyCpi) : null;
    roiComparison.push({ module: m.name, nominalRate, realRate, cpiRate: monthlyCpi });
  }

  // --- 9. 综合健康评分（0-100） ---
  const statusScore: Record<string, number> = { excellent: 100, good: 75, warning: 50, danger: 25 };
  const overallScore = Math.round(ratios.reduce((s, r) => s + statusScore[r.status], 0) / ratios.length);
  const overallStatus: HealthRatio['status'] =
    overallScore >= 85 ? 'excellent' : overallScore >= 65 ? 'good' : overallScore >= 45 ? 'warning' : 'danger';

  return ok(c, {
    month,
    overallScore,
    overallStatus,
    ratios,
    concentration,
    concentrationThreshold,
    liquidityBreakdown,
    roiComparison,
    cpiRate,
    summary: {
      totalAssets: centsToYuan(totalAssets),
      totalDebt: centsToYuan(totalDebt),
      netWorth: centsToYuan(netWorth),
      totalIncome: centsToYuan(totalIncome),
      totalExpense: centsToYuan(totalExpense),
      balance: centsToYuan(balance),
      monthlyRepayment: centsToYuan(monthlyRepayment),
      highLiquidAssets: centsToYuan(highLiquidTotal),
    },
  });
});

// 健康配置阈值查询
health.get('/config', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT key, value, updated_at FROM health_config').all<{ key: string; value: string; updated_at: string }>();
  return ok(c, { config: results });
});

// 健康配置阈值更新（仅 admin）
health.put('/config', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, string>>().catch(() => null);
  if (!body || typeof body !== 'object') throw invalidParam('请求体必须为 JSON 对象');
  const nowIso = new Date().toISOString();
  const allowed = ['concentration_threshold', 'liquidity_months_min', 'debt_service_ratio_max', 'savings_rate_min', 'cpi_annual_rate'];
  const stmts: ReturnType<typeof c.env.DB.prepare>[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) continue;
    stmts.push(c.env.DB.prepare('INSERT OR REPLACE INTO health_config (key, value, updated_at) VALUES (?, ?, ?)').bind(key, String(value), nowIso));
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  return ok(c, { updated: stmts.length });
});

export default health;
