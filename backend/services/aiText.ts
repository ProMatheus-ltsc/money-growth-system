/**
 * 四分区财务数据包文本构造（05 §3.28，F-09，CHG-02 改动三）：
 * ## 数据 / ## 提示词 / ## 结果格式 / ## 示例
 * 服务端拼接，不含用户身份信息（F-09 验收 3）。
 * CR-013：按四分区拆独立 builder（单一职责），parents Set 仅构建一次。
 */
import type { Env } from '../env';
import { addMonths } from '../lib/month';
import { buildCashFlow, buildGainCompare, buildSankey, totalsOf } from './reportCore';
import type { SnapshotBundle } from './snapshotRepo';
import { catAmountByCat, catKeyPath, loadBundle, topCats } from './snapshotRepo';
import { effectiveFreq, effectiveRate, nodeKeyPath, topAncestor } from './treeUtil';

function yuan(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function pct(r: number | null): string {
  return r === null ? '—' : `${(r * 100).toFixed(2)}%`;
}

/** (a) 资产树完整层级 + 模块收益率四态口径 */
function buildAssetTreeLines(b: SnapshotBundle, gainCompare: { module: string; mode: string; actualRate: number | null; gain: number | null }[]): string[] {
  const month = b.snapshot.month;
  const lines: string[] = [`（a）资产树（${month} 当月，单位：元）：`];
  const rateByModule = new Map(gainCompare.map((g) => [g.module, g]));
  const sums = catAmountByCat(b);
  const balanceOfNode = (nodeId: number) => b.assets.find((a) => a.node_id === nodeId)?.balance_cents ?? 0;
  const byParent = new Map<number | null, typeof b.treeNodes>();
  for (const n of b.treeNodes) {
    const arr = byParent.get(n.parent_id) ?? [];
    arr.push(n);
    byParent.set(n.parent_id, arr);
  }
  // CR-013：parents Set 提到递归外构建一次（原实现每次递归重建，O(depth×n)）
  const parents = new Set(b.treeNodes.map((x) => x.parent_id));
  const walkNode = (n: (typeof b.treeNodes)[number], depth: number) => {
    const indent = '　'.repeat(depth);
    const isLeaf = !parents.has(n.id);
    const balanceTxt = isLeaf ? `，余额 ${yuan(balanceOfNode(n.id) / 100)} 元` : '';
    const rate = effectiveRate(b.treeNodes, n.id);
    const rateTxt = rate !== null ? `，目标年化 ${(rate * 100).toFixed(1)}%（月化 ${pct(rate / 12)}）` : '，目标收益率继承上级';
    const freq = effectiveFreq(b.treeNodes, n.id);
    const row = b.assets.find((a) => a.node_id === n.id);
    const statusTxt = !isLeaf ? '' : row?.update_source === 'carried' ? '，沿用上期' : '，本期已更新';
    const newFundsTxt = row?.has_new_funds === 1 ? '，本月有新增资金' : '';
    lines.push(`${indent}- ${n.name}${balanceTxt}${rateTxt}，更新频率 ${freq}${statusTxt}${newFundsTxt}`);
    for (const kid of byParent.get(n.id) ?? []) walkNode(kid, depth + 1);
  };
  for (const m of byParent.get(null) ?? []) {
    walkNode(m, 0);
    const g = rateByModule.get(m.name);
    if (g) {
      const modeTxt =
        g.mode === 'auto' ? `实际收益率 ${pct(g.actualRate)}（自动计算）`
        : g.mode === 'converted' ? `实际收益率 ${pct(g.actualRate)}（收益金额 ${yuan(g.gain ?? 0)} 元折算）`
        : g.mode === 'blank' ? '实际收益率：新增资金·留空'
        : '实际收益率：上月余额为 0，不折算';
      lines.push(`　↳ 模块口径：${modeTxt}`);
    }
  }
  return lines;
}

/** (b) 负债清单 */
function buildDebtLines(b: SnapshotBundle): string[] {
  const lines: string[] = ['（b）负债清单：'];
  if (b.debtsSnap.length === 0) lines.push('　- 无负债');
  for (const sd of b.debtsSnap) {
    const master = b.debtsMaster.find((d) => d.id === sd.debt_id);
    if (!master) continue;
    const typeTxt = { mortgage: '房贷', auto_loan: '车贷', credit_card: '信用卡', other: '其他' }[master.debt_type];
    lines.push(
      `　- ${master.name}/${typeTxt}/${master.term === 'short' ? '短期(<1年)' : '长期(≥1年)'}/余额 ${yuan(sd.balance_cents / 100)} 元/年利率 ${(master.annual_rate * 100).toFixed(2)}%/${master.fixed_repayment === 1 ? `固定还款（月还 ${yuan(master.monthly_payment_cents / 100)} 元）` : '非固定还款'}/当月还款 ${yuan(sd.repayment_cents / 100)} 元`
    );
  }
  return lines;
}

/** (c) 三张财务报表当期数据 */
function buildStatementsLines(b: SnapshotBundle, prevBundle: SnapshotBundle | null): string[] {
  const totals = totalsOf(b);
  const cashFlow = buildCashFlow(b, prevBundle);
  const lines: string[] = ['（c）三张财务报表（当期）：'];
  const shortCents = b.debtsSnap.filter((sd) => b.debtsMaster.find((d) => d.id === sd.debt_id)?.term === 'short').reduce((s, sd) => s + sd.balance_cents, 0);
  const longCents = b.debtsSnap.filter((sd) => b.debtsMaster.find((d) => d.id === sd.debt_id)?.term === 'long').reduce((s, sd) => s + sd.balance_cents, 0);
  lines.push(`　资产负债表：资产总计 ${yuan(totals.totalAssets)}，负债总计 ${yuan(totals.totalDebt)}（短期 ${yuan(shortCents / 100)}，长期 ${yuan(longCents / 100)}），净资产 ${yuan(totals.netWorth)}，负债率 ${totals.debtRatio === null ? '—' : (totals.debtRatio * 100).toFixed(2) + '%'}`);
  lines.push(`　收支表：总收入 ${yuan(totals.totalIncome)}，总支出 ${yuan(totals.totalExpense)}，结余 ${yuan(totals.balance)}（结余 = 总收入 − 总支出；负债还款不计入支出）`);
  if (cashFlow) {
    lines.push(`　现金流量表：期初现金 ${yuan(cashFlow.kpi.openingCash)} + 净现金流 ${yuan(cashFlow.kpi.netCashFlow)} = 期末现金 ${yuan(cashFlow.kpi.closingCash)}`);
  } else {
    lines.push('　现金流量表：上月无快照，暂不可用');
  }
  return lines;
}

/** (d) 近 12 个月趋势 */
async function buildTrendLines(db: Env['DB'], month: string): Promise<string[]> {
  const lines: string[] = ['（d）近 12 个月趋势：'];
  const cutoff = addMonths(month, -11);
  const { results: trendRows } = await db
    .prepare('SELECT month, total_assets_cents, total_debt_cents, total_income_cents, total_expense_cents FROM monthly_snapshots WHERE month >= ? AND month <= ? ORDER BY month ASC')
    .bind(cutoff, month)
    .all<{ month: string; total_assets_cents: number; total_debt_cents: number; total_income_cents: number; total_expense_cents: number }>();
  if (trendRows.length === 0) lines.push('　- 无历史快照');
  const first = trendRows[0];
  const last = trendRows[trendRows.length - 1];
  if (first && last) {
    const fmt = (c: number) => yuan(c / 100);
    lines.push(`　总资产：${fmt(first.total_assets_cents)} → ${fmt(last.total_assets_cents)}`);
    lines.push(`　净资产：${fmt(first.total_assets_cents - first.total_debt_cents)} → ${fmt(last.total_assets_cents - last.total_debt_cents)}`);
    const ratioOf = (r: typeof first) => (r.total_assets_cents > 0 ? (r.total_debt_cents / r.total_assets_cents).toFixed(3) : '—');
    lines.push(`　负债率：${ratioOf(first)} → ${ratioOf(last)}`);
    const sumBalance = trendRows.reduce((s, r) => s + (r.total_income_cents - r.total_expense_cents), 0);
    lines.push(`　结余合计：${fmt(sumBalance)}`);
    lines.push(`　逐月：${trendRows.map((r) => `${r.month} 总资产${fmt(r.total_assets_cents)}/结余${fmt(r.total_income_cents - r.total_expense_cents)}`).join('；')}`);
  }
  return lines;
}

/** (e) 月度收支二级分类明细（含大额单笔） */
function buildCategoryDetailLines(b: SnapshotBundle): string[] {
  const lines: string[] = ['（e）收支二级分类明细（含≥阈值大额单笔）：'];
  const sums = catAmountByCat(b);
  for (const dir of ['income', 'expense'] as const) {
    const dirTxt = dir === 'income' ? '收入' : '支出';
    for (const top of topCats(b.catItems, dir)) {
      const kids = b.catItems.filter((i) => i.parent_id === top.id);
      const items = kids.map((leaf) => {
        const amt = b.catAmounts.find((ca) => ca.cat_item_id === leaf.id)?.amount_cents ?? 0;
        const large = b.largeItems
          .filter((li) => li.cat_item_id === leaf.id)
          .map((li) => `大额单笔「${li.name}」${yuan(li.amount_cents / 100)} 元`);
        return `${leaf.name} ${yuan(amt / 100)}${large.length > 0 ? `（${large.join('、')}）` : ''}`;
      });
      lines.push(`　${dirTxt}·${top.name}（合计 ${yuan((sums.get(top.id) ?? 0) / 100)}）：${items.join('；') || '无'}`);
    }
  }
  return lines;
}

/** ## 数据（a~e 全量） */
async function buildDataSection(db: Env['DB'], b: SnapshotBundle): Promise<string[]> {
  const month = b.snapshot.month;
  const gainCompare = buildGainCompare(b, await loadBundle(db, addMonths(month, -1)));
  const prevBundle = await loadBundle(db, addMonths(month, -1));
  return [
    '## 数据',
    ...buildAssetTreeLines(b, gainCompare),
    ...buildDebtLines(b),
    ...buildStatementsLines(b, prevBundle),
    ...(await buildTrendLines(db, month)),
    ...buildCategoryDetailLines(b),
  ];
}

/** ## 提示词（含业务模块语义说明，按当月资产树顶层模块名动态匹配） */
function buildPromptSection(b: SnapshotBundle): string[] {
  const lines: string[] = [
    '',
    '## 提示词',
    '你是一名家庭财务顾问，请基于以上数据，从资产配置、负债结构、收支结余三方面给出优化建议。',
    '要求：1）每条建议对应一个资产模块或负债/收支项；2）建议需可执行（含具体动作与理由）；3）优先级分为 高/中/低；4）考虑该家庭的风险偏好与目标收益率口径（目标月收益率 = 年化/12）；5）输出严格遵循「## 结果格式」的 JSON 结构，不要输出其他内容。',
  ];
  // 模块语义（CR-…：按顶层模块名匹配，树中不存在则不输出，避免硬编码失效）
  const topNames = new Set(b.treeNodes.filter((n) => n.parent_id === null).map((n) => n.name));
  const semantics: string[] = [];
  if (topNames.has('消费基金')) {
    semantics.push('- 「消费基金」为改善型消费基金：资金用于提升生活品质的改善型消费，与基本衣食住行、旅游、数码产品等支出无关，分析时勿将其与日常消费类支出混淆。');
  }
  if (topNames.has('创业基金')) {
    semantics.push('- 「创业基金」为锁定资金：资金锁定、不会有新增流入，分析时勿建议追加投入，收益仅取决于存量表现。');
  }
  if (semantics.length > 0) {
    lines.push('模块语义（务必遵循）：');
    lines.push(...semantics);
  }
  return lines;
}

/** ## 结果格式 */
function buildResultSchemaSection(): string[] {
  return [
    '',
    '## 结果格式',
    JSON.stringify(
      {
        analysisDate: 'YYYY-MM-DD',
        assetMonth: 'YYYY-MM',
        suggestions: [{ type: '建议类型', module: '目标模块', current: '当前配置', plan: '建议方案', reason: '理由', priority: '高|中|低' }],
      },
      null,
      2
    ),
  ];
}

/** ## 示例 */
function buildExampleSection(month: string): string[] {
  return [
    '',
    '## 示例',
    `请求：请对 ${month} 的家庭财务数据给出优化建议（数据见「## 数据」分区）。`,
    '期望返回：',
    JSON.stringify(
      {
        analysisDate: new Date().toISOString().slice(0, 10),
        assetMonth: month,
        suggestions: [
          {
            type: '配置优化',
            module: '消费基金',
            current: '目标年化50%以上，海外/国内两个子分类',
            plan: '高波动仓位下调20%，转入中长期资金',
            reason: '降低整体波动率并保持收益预期',
            priority: '高',
          },
        ],
      },
      null,
      2
    ),
  ];
}

/** 四分区数据包文本（## 数据 / ## 提示词 / ## 结果格式 / ## 示例） */
export async function buildAiExportText(db: Env['DB'], b: SnapshotBundle): Promise<string> {
  const lines = [
    ...(await buildDataSection(db, b)),
    ...buildPromptSection(b),
    ...buildResultSchemaSection(),
    ...buildExampleSection(b.snapshot.month),
  ];
  return lines.join('\n');
}
