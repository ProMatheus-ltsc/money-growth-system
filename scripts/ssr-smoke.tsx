/**
 * SSR 冒烟测试：无浏览器环境下用 renderToString 验证关键展示组件可渲染、
 * 数据映射（桑基流带/瀑布/树图/对比柱）不抛错。图表组件的 echarts 副作用在
 * SSR 下仅注册不初始化（useEffect 跳过），可安全执行。
 */
import { renderToString } from 'react-dom/server';
import { KpiCard } from '../src/components/common/KpiCard';
import { CollapseDetail } from '../src/components/common/CollapseDetail';
import { DrillPanel } from '../src/components/common/DrillPanel';
import { EmptyState } from '../src/components/common/EmptyState';
import { ChartCard } from '../src/components/charts/ChartCard';
import { buildSankeyPaletteMap, MODULE_PALETTE } from '../src/components/charts/financeChartAdapter';
import { PdfDocument } from '../src/components/pdf/PdfDocument';
import type { PdfPayload } from '../src/lib/types';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => string) {
  try {
    const html = fn();
    if (typeof html === 'string') {
      pass++;
      console.log(`  ✓ ${name}`);
    } else {
      fail++;
      console.log(`  ✗ ${name}: 非字符串输出`);
    }
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

console.log('SSR 冒烟：');

check('KpiCard', () => renderToString(<KpiCard label="总资产" value="459,400" direction="up" hint="环比" />));
check('KpiCard negative', () => renderToString(<KpiCard label="净资产" value="-345,600" negative />));
check('CollapseDetail', () => renderToString(<CollapseDetail title="明细"><p>row</p></CollapseDetail>));
check(
  'DrillPanel',
  () =>
    renderToString(
      <DrillPanel title="模块明细" columns={[{ key: 'name', title: '科目' }, { key: 'amount', title: '金额', align: 'right' }]} rows={[{ name: 'A', amount: '1' }]} onClose={() => {}} />
    )
);
check('EmptyState', () => renderToString(<EmptyState title="无数据" description="请先录入" />));
check('ChartCard loading', () => renderToString(<ChartCard title="t" loading>图表</ChartCard>));
check('ChartCard error+retry', () => renderToString(<ChartCard title="t" error="boom" onRetry={() => {}}>图表</ChartCard>));

check('sankey palette map', () => {
  const m = buildSankeyPaletteMap(['职业收入', '其他收入'], ['居家生活']);
  if (!m['总收入'] || !m['结余/净储蓄']) throw new Error('缺少总收入/结余额外色');
  if (m['居家生活'] !== '#94a3b8') throw new Error('支出类别未用流出灰');
  return 'ok';
});
check('module palette', () => {
  if (MODULE_PALETTE.length < 7) throw new Error('色板不足 7 色');
  return 'ok';
});

// PdfDocument：month scope 全量数据
const pdfPayload: PdfPayload = {
  scope: 'month',
  month: '2026-08',
  title: '家庭财务报告 2026-08',
  kpis: { totalAssets: 459400, netWorth: -345600, debtRatio: 1.7523, balance: 26130 },
  statements: {
    balanceSheet: {
      kpi: { totalAssets: 459400, totalDebt: 805000, shortTermDebt: 5000, longTermDebt: 800000, netWorth: -345600, debtRatio: 1.7523 },
      assetTreemap: [{ module: '现金', amount: 56000, children: [{ name: '银行A', amount: 56000 }] }],
      debtDonut: [{ term: 'short', amount: 5000 }, { term: 'long', amount: 800000 }],
      details: { assets: [{ name: '现金', amount: 56000 }], debts: [{ name: '首套房贷', term: 'long', balance: 800000 }] },
    },
    incomeStatement: {
      kpi: { totalIncome: 35130, totalExpense: 9000, balance: 26130 },
      sankey: { income: [{ cat: '职业收入', amount: 33000 }], totalIncome: 35130, expense: [{ cat: '居家生活', amount: 2600 }], balance: 26130, balanceRatio: 0.7438 },
      groupBar: { income: [], expense: [] },
      details: {
        income: [{ cat: '职业收入', amount: 33000, children: [{ cat: '工资', amount: 25000, largeItems: [] }] }],
        expense: [{ cat: '居家生活', amount: 2600, children: [{ cat: '房租物业', amount: 2600, largeItems: [{ name: '扫地机器人', amount: 1200 }] }] }],
      },
    },
    cashFlow: {
      kpi: { openingCash: 452000, netCashFlow: 7400, closingCash: 459400 },
      waterfall: [
        { name: '期初现金', amount: 452000, type: 'start' },
        { name: '当期结余', amount: 26130, type: 'delta' },
        { name: '期末现金', amount: 459400, type: 'end' },
      ],
      details: [{ name: '当期结余', formula: '总收入−总支出', amount: 26130 }],
    },
    notes: { debtRatioNote: '唯一住房未计入资产' },
  },
  charts: {
    treemap: [{ module: '现金', amount: 56000, children: [{ name: '银行A', amount: 56000 }] }],
    sankey: { income: [{ cat: '职业收入', amount: 33000 }], expense: [{ cat: '居家生活', amount: 2600 }], balance: 26130 },
  },
  aiRecords: [
    {
      id: 1,
      analysisDate: '2026-08-20',
      payload: { analysisDate: '2026-08-20', assetMonth: '2026-08', suggestions: [{ type: '配置优化', module: '消费基金', current: 'c', plan: 'p', reason: 'r', priority: '高' }] },
    },
  ],
  meta: { generatedAt: '2026-08-24T06:00:00Z', unit: '元', noPII: true },
};
check('PdfDocument month scope', () => renderToString(<PdfDocument payload={pdfPayload} />));

// 现金流量表为 null 的分支
check('PdfDocument cashFlow null', () => {
  const p = { ...pdfPayload, statements: { ...pdfPayload.statements, cashFlow: null } };
  return renderToString(<PdfDocument payload={p as PdfPayload} />);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
