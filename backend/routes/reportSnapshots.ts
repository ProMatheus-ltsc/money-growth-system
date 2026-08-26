/**
 * 定期报告快照（05 §3.18~§3.21，F-13）：
 * - GET  /report-snapshots          列表（frozen 恒 true）
 * - POST /report-snapshots          生成（期间对齐/缺月拒绝/重复 409；事务内聚合冻结）
 * - GET  /report-snapshots/:id      详情（数据全部取自冻结 payload）
 * - GET  /report-snapshots/compare  任意两份跨期对比
 * 读接口 admin + viewer；生成仅 admin（写操作，决策 D6）。
 */
import { Hono } from 'hono';
import type { ErrorDetail } from '../lib/errors';
import { conflict, invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { centsToYuan, round4 } from '../lib/money';
import { addMonths, isValidMonth, monthDiff, monthOf, monthRange } from '../lib/month';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';
import {
  aggregatePeriod,
  buildBalanceSheet,
  buildSankeyFromAmounts,
  buildTreemap,
  reportLabel,
} from '../services/reportCore';
import { loadBundle } from '../services/snapshotRepo';

const reportSnapshots = new Hono<AppEnv>();

interface ReportPayload {
  kpis: { totalAssets: number; netWorth: number; debtRatio: number | null; periodBalance: number };
  charts: {
    treemap: unknown;
    waterfall: { name: string; amount: number; type: 'start' | 'delta' | 'end' }[];
    sankey: unknown;
    debtDonut: { term: string; amount: number }[];
  };
  statements: {
    balanceSheet: unknown;
    incomeStatement: { kpi: { totalIncome: number; totalExpense: number; balance: number }; groupBar: { income: { cat: string; amount: number }[]; expense: { cat: string; amount: number }[] } };
    cashFlow: { kpi: { openingCash: number | null; netCashFlow: number; closingCash: number }; waterfall: { name: string; amount: number; type: 'start' | 'delta' | 'end' }[] } | null;
  };
  details: {
    incomeByCat: { cat: string; amount: number }[];
    expenseByCat: { cat: string; amount: number }[];
    debts: { name: string; term: string; balance: number; repayment: number }[];
    monthlyBalances: { month: string; balance: number }[];
  };
  aiRecordIds: number[];
}

function rowOut(r: {
  id: number; report_type: string; start_month: string; end_month: string; generated_at: string;
  total_assets_cents: number; net_worth_cents: number; debt_ratio: number; period_balance_cents: number;
}) {
  return {
    id: r.id,
    reportType: r.report_type,
    startMonth: r.start_month,
    endMonth: r.end_month,
    generatedAt: r.generated_at,
    totalAssets: centsToYuan(r.total_assets_cents),
    netWorth: centsToYuan(r.net_worth_cents),
    debtRatio: r.debt_ratio,
    periodBalance: centsToYuan(r.period_balance_cents),
    frozen: true,
  };
}

// §3.18 列表
reportSnapshots.get('/', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM report_snapshots ORDER BY generated_at DESC').all();
  return ok(c, { list: (results as Parameters<typeof rowOut>[0][]).map(rowOut) });
});

// §3.19 生成报告快照
reportSnapshots.post('/', requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw invalidParam('请求体必须为 JSON 对象');
  const errors: ErrorDetail[] = [];
  const reportType = body.reportType;
  if (reportType !== 'quarter' && reportType !== 'half' && reportType !== 'year') {
    errors.push({ field: 'reportType', message: "reportType 必须为 'quarter'/'half'/'year'" });
  }
  const startMonth = typeof body.startMonth === 'string' ? body.startMonth : null;
  const endMonth = typeof body.endMonth === 'string' ? body.endMonth : null;
  if (!startMonth || !isValidMonth(startMonth)) errors.push({ field: 'startMonth', message: 'startMonth 格式应为 YYYY-MM' });
  if (!endMonth || !isValidMonth(endMonth)) errors.push({ field: 'endMonth', message: 'endMonth 格式应为 YYYY-MM' });
  if (errors.length > 0) throw invalidParam('报告参数校验失败', errors);

  const span = reportType === 'quarter' ? 3 : reportType === 'half' ? 6 : 12;
  const startM = monthOf(startMonth!);
  const validStart = reportType === 'quarter' ? [1, 4, 7, 10] : reportType === 'half' ? [1, 7] : [1];
  if (!validStart.includes(startM)) {
    throw invalidParam('报告期间未对齐自然期间', [
      { field: 'startMonth', message: `${reportType === 'quarter' ? '季度' : reportType === 'half' ? '半年' : '年度'}起始月须为 ${validStart.map((m) => String(m).padStart(2, '0')).join('/')} 月` },
    ]);
  }
  if (monthDiff(startMonth!, endMonth!) + 1 !== span) {
    throw invalidParam('报告期间长度不符', [
      { field: 'endMonth', message: `${reportType} 期间须恰为 ${span} 个月（起止月间隔 ${span - 1} 个月）` },
    ]);
  }

  // 期间内每月必须存在快照（年报要求完整自然年 12 个月，决策 D4）
  const months = monthRange(startMonth!, endMonth!);
  const missing: string[] = [];
  for (const m of months) {
    const s = await c.env.DB.prepare('SELECT id FROM monthly_snapshots WHERE month = ?').bind(m).first();
    if (!s) missing.push(m);
  }
  if (missing.length > 0) {
    throw invalidParam('报告期间数据不完整', missing.map((m) => ({ field: 'startMonth..endMonth', message: `缺少月度快照：${m}` })));
  }

  // 重复期间拒绝（F-13 规则 2）
  const dup = await c.env.DB.prepare(
    'SELECT id FROM report_snapshots WHERE report_type = ? AND start_month = ? AND end_month = ?'
  )
    .bind(reportType, startMonth, endMonth)
    .first();
  if (dup) throw conflict(`${startMonth} ~ ${endMonth} 的${reportType === 'quarter' ? '季报' : reportType === 'half' ? '半年报' : '年报'}已存在，重复期间不允许重复生成`);

  // ---- 事务内聚合生成 payload ----
  const agg = await aggregatePeriod(c.env.DB, startMonth!, endMonth!);
  const endBundle = agg.bundles[agg.bundles.length - 1];
  const startBundle = agg.bundles[0];
  const end = endBundle.snapshot;

  const periodBalance = agg.periodBalanceCents;
  const netWorth = end.total_assets_cents - end.total_debt_cents;

  // 净资产变动瀑布（精简）：期初净资产 → +期间结余 → ±估值与其他 → 期末净资产
  const prevOfStart = await loadBundle(c.env.DB, addMonths(startMonth!, -1));
  const openingNW = prevOfStart
    ? prevOfStart.snapshot.total_assets_cents - prevOfStart.snapshot.total_debt_cents
    : netWorth - periodBalance;
  const valuationNW = netWorth - openingNW - periodBalance;

  // 期间收支流向桑基（各月各类别累加的伪快照）
  const sankey = buildSankeyFromAmounts(
    [...agg.incomeByName.entries()].map(([cat, amountCents]) => ({ cat, amountCents })),
    [...agg.expenseByName.entries()].map(([cat, amountCents]) => ({ cat, amountCents }))
  );

  // 期末负债结构
  const debtByTerm = { short: 0, long: 0 };
  for (const sd of endBundle.debtsSnap) {
    const master = endBundle.debtsMaster.find((d) => d.id === sd.debt_id);
    debtByTerm[master?.term ?? 'long'] += sd.balance_cents;
  }

  // 期间现金流（期间累加口径）
  const closingCash = end.total_assets_cents;
  const openingCash = prevOfStart ? prevOfStart.snapshot.total_assets_cents : null;
  const netCashFlow = openingCash !== null ? closingCash - openingCash : null;
  const debtNetChangePeriod = prevOfStart ? end.total_debt_cents - prevOfStart.snapshot.total_debt_cents : null;

  // 关联 AI 记录（期间内月份）
  const placeholders = months.map(() => '?').join(',');
  const aiRows = await c.env.DB.prepare(`SELECT id FROM ai_analyses WHERE asset_month IN (${placeholders}) ORDER BY analysis_date`)
    .bind(...months)
    .all<{ id: number }>();

  // 期间负债还款合计（按负债项）
  const repaymentByDebt = new Map<number, number>();
  for (const b of agg.bundles) {
    for (const sd of b.debtsSnap) repaymentByDebt.set(sd.debt_id, (repaymentByDebt.get(sd.debt_id) ?? 0) + sd.repayment_cents);
  }

  const payload: ReportPayload = {
    kpis: {
      totalAssets: centsToYuan(end.total_assets_cents),
      netWorth: centsToYuan(netWorth),
      debtRatio: end.total_assets_cents > 0 ? round4(end.total_debt_cents / end.total_assets_cents) : null,
      periodBalance: centsToYuan(periodBalance),
    },
    charts: {
      treemap: buildTreemap(endBundle),
      waterfall: [
        { name: '期初净资产', amount: centsToYuan(openingNW), type: 'start' },
        { name: '期间结余', amount: centsToYuan(periodBalance), type: 'delta' },
        { name: '估值与其他（平衡项）', amount: centsToYuan(valuationNW), type: 'delta' },
        { name: '期末净资产', amount: centsToYuan(netWorth), type: 'end' },
      ],
      sankey,
      debtDonut: [
        { term: 'short', amount: centsToYuan(debtByTerm.short) },
        { term: 'long', amount: centsToYuan(debtByTerm.long) },
      ],
    },
    statements: {
      balanceSheet: buildBalanceSheet(endBundle),
      incomeStatement: {
        kpi: {
          totalIncome: centsToYuan(agg.totalIncomeCents),
          totalExpense: centsToYuan(agg.totalExpenseCents),
          balance: centsToYuan(agg.totalIncomeCents - agg.totalExpenseCents),
        },
        groupBar: {
          income: [...agg.incomeByName.entries()].map(([cat, v]) => ({ cat, amount: centsToYuan(v) })),
          expense: [...agg.expenseByName.entries()].map(([cat, v]) => ({ cat, amount: centsToYuan(v) })),
        },
      },
      cashFlow:
        openingCash !== null
          ? {
              kpi: { openingCash: centsToYuan(openingCash), netCashFlow: centsToYuan(netCashFlow!), closingCash: centsToYuan(closingCash) },
              waterfall: [
                { name: '期初现金', amount: centsToYuan(openingCash), type: 'start' },
                { name: '期间结余', amount: centsToYuan(periodBalance), type: 'delta' },
                { name: '负债净变动', amount: centsToYuan(debtNetChangePeriod!), type: 'delta' },
                {
                  name: '估值与其他（平衡项）',
                  amount: centsToYuan(netCashFlow! - periodBalance - debtNetChangePeriod!),
                  type: 'delta',
                },
                { name: '期末现金', amount: centsToYuan(closingCash), type: 'end' },
              ],
            }
          : null,
    },
    details: {
      incomeByCat: [...agg.incomeByName.entries()].map(([cat, v]) => ({ cat, amount: centsToYuan(v) })),
      expenseByCat: [...agg.expenseByName.entries()].map(([cat, v]) => ({ cat, amount: centsToYuan(v) })),
      debts: endBundle.debtsSnap.map((sd) => {
        const master = endBundle.debtsMaster.find((d) => d.id === sd.debt_id);
        return {
          name: master?.name ?? `负债#${sd.debt_id}`,
          term: master?.term ?? 'long',
          balance: centsToYuan(sd.balance_cents),
          repayment: centsToYuan(repaymentByDebt.get(sd.debt_id) ?? 0),
        };
      }),
      monthlyBalances: agg.bundles.map((b) => ({
        month: b.snapshot.month,
        balance: centsToYuan(b.snapshot.total_income_cents - b.snapshot.total_expense_cents),
      })),
    },
    aiRecordIds: aiRows.results.map((r) => r.id),
  };

  const now = new Date().toISOString();
  let id: number;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO report_snapshots (report_type, start_month, end_month, generated_at,
       total_assets_cents, net_worth_cents, debt_ratio, period_balance_cents, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        reportType,
        startMonth,
        endMonth,
        now,
        end.total_assets_cents,
        netWorth,
        payload.kpis.debtRatio ?? 0,
        periodBalance,
        JSON.stringify(payload)
      )
      .run();
    id = Number(res.meta.last_row_id);
  } catch (e) {
    // UNIQUE(report_type, start_month, end_month) 冲突兜底（并发场景）
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      throw conflict(`${startMonth} ~ ${endMonth} 的报告已存在，重复期间不允许重复生成`);
    }
    throw e;
  }

  return ok(c, {
    id,
    reportType,
    startMonth,
    endMonth,
    generatedAt: now,
    totalAssets: payload.kpis.totalAssets,
    netWorth: payload.kpis.netWorth,
    debtRatio: payload.kpis.debtRatio,
    periodBalance: payload.kpis.periodBalance,
    frozen: true,
  });
});

// §3.21 跨期对比（路由须置于 /:id 之前，避免 'compare' 被当作 id）
reportSnapshots.get('/compare', requireAuth, async (c) => {
  const a = Number(c.req.query('a'));
  const b = Number(c.req.query('b'));
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
    throw invalidParam('a 与 b 必须为两个不同的报告快照');
  }
  const load = async (id: number) => {
    const r = await c.env.DB.prepare('SELECT * FROM report_snapshots WHERE id = ?').bind(id).first<{
      id: number; report_type: string; start_month: string; end_month: string; payload_json: string;
    }>();
    if (!r) throw notFound(`报告快照 ${id} 不存在`);
    return { ...r, payload: JSON.parse(r.payload_json) as ReportPayload };
  };
  const [ra, rb] = await Promise.all([load(a), load(b)]);

  const summary = (r: { id: number; report_type: string; start_month: string; end_month: string; payload: ReportPayload }) => ({
    id: r.id,
    label: reportLabel(r.report_type, r.start_month),
    reportType: r.report_type,
    startMonth: r.start_month,
    endMonth: r.end_month,
    kpis: r.payload.kpis,
  });

  const directionOf = (diff: number): 'up' | 'down' | 'flat' => (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat');
  const diffRow = (metric: string, aValue: number, bValue: number, isRatio = false) => {
    const absDiff = round4(bValue - aValue);
    return {
      metric,
      aValue,
      bValue,
      absDiff,
      pctDiff: isRatio || aValue === 0 ? null : round4((bValue - aValue) / Math.abs(aValue)),
      direction: directionOf(absDiff),
    };
  };

  const diffs = [
    diffRow('totalAssets', ra.payload.kpis.totalAssets, rb.payload.kpis.totalAssets),
    diffRow('netWorth', ra.payload.kpis.netWorth, rb.payload.kpis.netWorth),
    diffRow('debtRatio', ra.payload.kpis.debtRatio ?? 0, rb.payload.kpis.debtRatio ?? 0, true),
    diffRow('periodBalance', ra.payload.kpis.periodBalance, rb.payload.kpis.periodBalance),
  ];

  // 逐模块余额对比（一侧缺失该侧金额 null）
  const aModules = new Map((ra.payload.charts.treemap as { module: string; amount: number }[]).map((t) => [t.module, t.amount]));
  const bModules = new Map((rb.payload.charts.treemap as { module: string; amount: number }[]).map((t) => [t.module, t.amount]));
  const moduleNames = [...new Set([...aModules.keys(), ...bModules.keys()])];
  const moduleCompare = moduleNames.map((module) => {
    const aAmount = aModules.has(module) ? aModules.get(module)! : null;
    const bAmount = bModules.has(module) ? bModules.get(module)! : null;
    return {
      module,
      aAmount,
      bAmount,
      absDiff: aAmount !== null && bAmount !== null ? round4(bAmount - aAmount) : null,
      pctDiff: aAmount !== null && bAmount !== null && aAmount !== 0 ? round4((bAmount - aAmount) / Math.abs(aAmount)) : null,
    };
  });

  // 负债对比
  const aDebts = new Map(ra.payload.details.debts.map((d) => [d.name, d.balance]));
  const bDebts = new Map(rb.payload.details.debts.map((d) => [d.name, d.balance]));
  const debtNames = [...new Set([...aDebts.keys(), ...bDebts.keys()])];
  const debtCompare = debtNames.map((name) => {
    const aBalance = aDebts.has(name) ? aDebts.get(name)! : null;
    const bBalance = bDebts.has(name) ? bDebts.get(name)! : null;
    return {
      name,
      aBalance,
      bBalance,
      absDiff: aBalance !== null && bBalance !== null ? round4(bBalance - aBalance) : null,
    };
  });

  return ok(c, { a: summary(ra), b: summary(rb), diffs, moduleCompare, debtCompare });
});

// §3.20 报告快照详情
reportSnapshots.get('/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const r = await c.env.DB.prepare('SELECT * FROM report_snapshots WHERE id = ?').bind(id).first<{
    id: number; report_type: string; start_month: string; end_month: string; generated_at: string;
    payload_json: string;
  }>();
  if (!r) throw notFound('报告快照不存在');
  const payload = JSON.parse(r.payload_json) as ReportPayload;

  // 关联 AI 记录：冻结内容存 id 列表，读取时解析现存记录；已删除记录不再展示正文（05 §3.31）
  const aiRecords: { id: number; analysisDate: string; assetMonth: string; payload: unknown }[] = [];
  for (const aiId of payload.aiRecordIds) {
    const row = await c.env.DB.prepare('SELECT * FROM ai_analyses WHERE id = ?').bind(aiId).first<{
      id: number; analysis_date: string; asset_month: string; payload_json: string;
    }>();
    if (row) {
      aiRecords.push({
        id: row.id,
        analysisDate: row.analysis_date,
        assetMonth: row.asset_month,
        payload: JSON.parse(row.payload_json),
      });
    }
  }

  return ok(c, {
    id: r.id,
    reportType: r.report_type,
    startMonth: r.start_month,
    endMonth: r.end_month,
    generatedAt: r.generated_at,
    frozen: true,
    kpis: payload.kpis,
    charts: payload.charts,
    statements: payload.statements,
    details: payload.details,
    aiRecords,
  });
});

export default reportSnapshots;
