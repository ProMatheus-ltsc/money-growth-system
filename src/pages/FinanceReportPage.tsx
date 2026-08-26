/**
 * 财务报表页（UI-10 / F-04b + F-11 导出入口，06 T22）：
 * 三页签（资产负债表 / 收支表 / 现金流量表），每页签「汇总 KPI + 核心图表 + 折叠明细」三段式；
 * 表与图互相勾稽（净资产=资产−负债；结余=收入−支出；期初现金+净现金流=期末现金，F-04b 验收 1）；
 * 月份选择器驱动联动；「导出 PDF」（html2canvas + jsPDF，viewer 可用，决策 D6）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@shared/core/hooks/useAuth';
import { useToast } from '@shared/core/hooks/useToast';
import { Download } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { fmtMoney, fmtRate } from '../lib/format';
import type { FinanceReportData } from '../lib/types';
import { CollapseDetail } from '../components/common/CollapseDetail';
import { DrillPanel } from '../components/common/DrillPanel';
import { EmptyState } from '../components/common/EmptyState';
import { KpiCard } from '../components/common/KpiCard';
import { MonthPicker } from '../components/common/MonthPicker';
import { UnitSwitch } from '../components/common/UnitSwitch';
import { ChartCard } from '../components/charts/ChartCard';
import { ChartGroupBar } from '../components/charts/ChartGroupBar';
import {
  buildSankeyPaletteMap,
  LazyChart,
  LazyDonut,
  LazySankey,
  LazyTreemap,
  LazyWaterfall,
  MODULE_PALETTE,
  TERM_COLORS,
} from '../components/charts/financeChartAdapter';
import { useUi } from '../context/UiContext';
import { exportPdf } from '../lib/pdf';

type Tab = 'balance' | 'income' | 'cashflow';

const TABS: { id: Tab; label: string }[] = [
  { id: 'balance', label: '资产负债表' },
  { id: 'income', label: '收支表' },
  { id: 'cashflow', label: '现金流量表' },
];

export default function FinanceReportPage() {
  const { role } = useAuth();
  const { showToast } = useToast();
  const { month, setMonth, unit } = useUi();
  const [tab, setTab] = useState<Tab>('balance');
  const [data, setData] = useState<FinanceReportData | null>(null);
  const [months, setMonths] = useState<string[]>([month]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [exporting, setExporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [drill, setDrill] = useState<{ title: string; rows: { name: string; amount: number }[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDrill(null);
    try {
      const [fin, list] = await Promise.all([
        api<FinanceReportData>('/api/reports/finance', { query: { month } }),
        api<{ months: { month: string }[] }>('/api/snapshots', { query: { range: 'all' } }).catch(() => ({ months: [] })),
      ]);
      setData(fin);
      const ms = list.months.map((m) => m.month);
      if (ms.length > 0) setMonths(ms);
    } catch (e) {
      setData(null);
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const filename = await exportPdf('month', { month });
      showToast(`PDF 已生成：${filename}`, 'success', 5000);
    } catch (e) {
      showToast(`PDF 生成失败：${e instanceof Error ? e.message : '未知原因'}（可重试）`, 'error', 6000);
    } finally {
      setExporting(false);
    }
  };

  if (!loading && error?.status === 404) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <EmptyState
          title={`${month} 尚无资产快照`}
          description={role === 'viewer' ? '等待管理员录入本月数据后即可查看财务报表。' : '请先在「月末录入」页完成本月录入。'}
          action={role === 'admin' ? <Link to="/entry" className="btn-primary">去录入</Link> : undefined}
        />
      </div>
    );
  }

  const bs = data?.balanceSheet;
  const is = data?.incomeStatement;
  const cf = data?.cashFlow;

  // 桑基流带（收支表）
  const sankeyFlows = (() => {
    if (!is) return [];
    const flows: { source: string; target: string; value: number }[] = [];
    for (const i of is.sankey.income) if (i.amount > 0) flows.push({ source: i.cat, target: '总收入', value: i.amount });
    for (const e of is.sankey.expense) if (e.amount > 0) flows.push({ source: '总收入', target: e.cat, value: e.amount });
    if (is.sankey.balance > 0) flows.push({ source: '总收入', target: '结余/净储蓄', value: is.sankey.balance });
    return flows;
  })();
  const sankeyPalette = is ? buildSankeyPaletteMap(is.sankey.income.map((i) => i.cat), is.sankey.expense.map((e) => e.cat)) : {};

  return (
    <div className="space-y-4">
      <PageHeader>
        <MonthPicker months={months} value={month} onChange={setMonth} />
        <UnitSwitch />
        <button
          onClick={() => void handleExport()}
          disabled={exporting || !data}
          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
          title={data ? '导出本月财务报告（含三张表 + 图表 + AI 记录）' : '无数据时不可导出'}
        >
          <Download size={14} /> {exporting ? '生成中…' : '导出 PDF'}
        </button>
      </PageHeader>

      {/* 页签（250ms） */}
      <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              setDrill(null);
            }}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors duration-250 ${tab === t.id ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && error.status !== 404 && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          加载失败：{error.message}
          <button onClick={() => setReloadKey((k) => k + 1)} className="ml-3 rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700">重试</button>
        </div>
      )}

      {/* ============ 资产负债表 ============ */}
      {tab === 'balance' && bs && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiCard label="资产总计" value={fmtMoney(bs.kpi.totalAssets, unit)} />
            <KpiCard label="负债总计" value={fmtMoney(bs.kpi.totalDebt, unit)} hint={`短期 ${fmtMoney(bs.kpi.shortTermDebt, unit)} / 长期 ${fmtMoney(bs.kpi.longTermDebt, unit)}`} />
            <KpiCard label="净资产（资产−负债）" value={fmtMoney(bs.kpi.netWorth, unit)} negative={bs.kpi.netWorth < 0} emphasized />
            <KpiCard label="负债率" value={fmtRate(bs.kpi.debtRatio, 4)} hint={data?.notes?.debtRatioNote} negative={bs.kpi.debtRatio > 1} />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title="资产结构（树图）" subtitle="点击矩形下钻模块明细" loading={loading} error={error?.message} onRetry={() => setReloadKey((k) => k + 1)}>
              <LazyChart>
                <LazyTreemap
                  data={bs.assetTreemap.map((t) => ({ name: t.module, amount: t.amount, children: t.children.map((c) => ({ name: c.name, amount: c.amount })) }))}
                  palette={MODULE_PALETTE}
                  unit={unit}
                  height={300}
                  onItemClick={(p) => {
                    const mod = bs.assetTreemap.find((t) => t.module === p.name);
                    setDrill({ title: `${p.name} · 明细`, rows: mod ? mod.children.map((c) => ({ name: c.name, amount: c.amount })) : [{ name: p.name, amount: p.amount }] });
                  }}
                />
              </LazyChart>
            </ChartCard>
            <ChartCard title="负债结构（环形图 · 短期/长期）" subtitle="点击扇区下钻负债条目" loading={loading}>
              <LazyChart>
                <LazyDonut
                  slices={bs.debtDonut.map((d) => ({ name: d.term === 'short' ? '短期（<1年）' : '长期（≥1年）', value: d.amount, color: d.term === 'short' ? TERM_COLORS.short : TERM_COLORS.long }))}
                  centerValue={fmtMoney(bs.kpi.totalDebt, unit)}
                  centerLabel="期末总负债"
                  unit={unit}
                  height={300}
                  onItemClick={(p) => {
                    const term = p.name.startsWith('短期') ? 'short' : 'long';
                    setDrill({ title: `${p.name} 负债明细`, rows: bs.details.debts.filter((d) => d.term === term).map((d) => ({ name: d.name, amount: d.balance })) });
                  }}
                />
              </LazyChart>
            </ChartCard>
          </div>
          <CollapseDetail title={`科目明细（资产 ${bs.details.assets.length} 项 / 负债 ${bs.details.debts.length} 项）`}>
            <div className="grid gap-4 sm:grid-cols-2">
              <DetailTable title="资产（按模块）" rows={bs.details.assets.map((a) => ({ name: a.name, amount: a.amount }))} unit={unit} />
              <DetailTable title="负债（逐科目）" rows={bs.details.debts.map((d) => ({ name: `${d.name}（${d.term === 'short' ? '短期' : '长期'}）`, amount: d.balance }))} unit={unit} />
            </div>
            <p className="mt-2 text-xs text-slate-400">勾稽：净资产 = 资产总计 − 负债总计 = {fmtMoney(bs.kpi.netWorth, unit)}</p>
          </CollapseDetail>
        </div>
      )}

      {/* ============ 收支表 ============ */}
      {tab === 'income' && is && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            <KpiCard label="总收入" value={fmtMoney(is.kpi.totalIncome, unit)} />
            <KpiCard label="总支出" value={fmtMoney(is.kpi.totalExpense, unit)} />
            <KpiCard label="当月结余（收入−支出）" value={fmtMoney(is.kpi.balance, unit)} emphasized negative={is.kpi.balance < 0} direction={is.kpi.balance >= 0 ? 'up' : 'down'} />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title="收支流向（桑基图）" subtitle={`收入→「总收入」→支出+结余 · 结余率 ${fmtRate(is.sankey.balanceRatio)} · 点击流带下钻`} loading={loading} error={error?.message} onRetry={() => setReloadKey((k) => k + 1)}>
              <LazyChart>
                <LazySankey
                  flows={sankeyFlows}
                  paletteMap={sankeyPalette}
                  linkColorMode="source"
                  unit={unit}
                  height={300}
                  onItemClick={(p) => {
                    const cat = (p.type === 'link' ? (p.source === '总收入' ? p.target : p.source) : p.name) ?? p.name;
                    const hit = [...is.details.income, ...is.details.expense].find((d) => d.cat === cat);
                    setDrill({ title: `${cat} · 二级构成`, rows: hit ? (hit.children ?? []).map((c) => ({ name: c.cat, amount: c.amount })) : [{ name: cat, amount: p.value }] });
                  }}
                />
              </LazyChart>
            </ChartCard>
            <ChartCard title="收支分类对比（分组柱状图）" subtitle="一级分类 · 收入 vs 支出" loading={loading}>
              <ChartGroupBar
                categories={[...new Set([...is.groupBar.income.map((i) => i.cat), ...is.groupBar.expense.map((e) => e.cat)])]}
                series={[
                  { name: '收入', values: categoriesOf(is.groupBar.income, [...new Set([...is.groupBar.income.map((i) => i.cat), ...is.groupBar.expense.map((e) => e.cat)])]), color: '#1baf7a' },
                  { name: '支出', values: categoriesOf(is.groupBar.expense, [...new Set([...is.groupBar.income.map((i) => i.cat), ...is.groupBar.expense.map((e) => e.cat)])]), color: '#eb6834' },
                ]}
                unit={unit}
                height={300}
              />
            </ChartCard>
          </div>
          <CollapseDetail title="逐类别收支明细（一级 → 二级 → 大额单笔）">
            <div className="grid gap-4 sm:grid-cols-2">
              <CategoryDetail direction="收入" items={is.details.income} unit={unit} />
              <CategoryDetail direction="支出" items={is.details.expense} unit={unit} />
            </div>
            <p className="mt-2 text-xs text-slate-400">勾稽：结余 = 总收入 − 总支出 = {fmtMoney(is.kpi.balance, unit)}</p>
          </CollapseDetail>
        </div>
      )}

      {/* ============ 现金流量表 ============ */}
      {tab === 'cashflow' && (
        <div className="space-y-4">
          {!cf ? (
            <EmptyState title="上月无快照，现金流量表暂不可用" description="现金流量表需以上月末总资产为期初（上月无快照时返回 null，见 05 §3.11）。" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                <KpiCard label="期初现金（上月末总资产）" value={fmtMoney(cf.kpi.openingCash, unit)} />
                <KpiCard label="净现金流" value={fmtMoney(cf.kpi.netCashFlow, unit)} emphasized negative={cf.kpi.netCashFlow < 0} direction={cf.kpi.netCashFlow >= 0 ? 'up' : 'down'} />
                <KpiCard label="期末现金（当月末总资产）" value={fmtMoney(cf.kpi.closingCash, unit)} />
              </div>
              <ChartCard title="现金变动（瀑布图）" subtitle="期初 → ±构成项 → 期末 · 增绿减红 · 点击柱段查看构成说明" loading={loading} error={error?.message} onRetry={() => setReloadKey((k) => k + 1)}>
                <LazyChart>
                  <LazyWaterfall
                    openingTotal={cf.kpi.openingCash}
                    items={cf.waterfall.filter((w) => w.type === 'delta').map((w) => ({ label: w.name, delta: w.amount }))}
                    closingTotal={cf.kpi.closingCash}
                    unit={unit}
                    height={300}
                    onItemClick={(p) => {
                      const d = cf.details.find((x) => x.name === p.label);
                      setDrill({ title: `${p.label} · 构成说明`, rows: d ? [{ name: d.formula, amount: d.amount }] : [] });
                    }}
                  />
                </LazyChart>
              </ChartCard>
              <CollapseDetail title="现金流量构成明细">
                <DetailTable title="构成项" rows={cf.details.map((d) => ({ name: `${d.name}（${d.formula}）`, amount: d.amount }))} unit={unit} />
                <p className="mt-2 text-xs text-slate-400">
                  恒等式：期初现金 {fmtMoney(cf.kpi.openingCash, unit)} + 净现金流 {fmtMoney(cf.kpi.netCashFlow, unit)} = 期末现金 {fmtMoney(cf.kpi.closingCash, unit)}
                </p>
              </CollapseDetail>
            </>
          )}
        </div>
      )}

      {/* 下钻面板 */}
      {drill && (
        <DrillPanel
          title={drill.title}
          columns={[{ key: 'name', title: '项目' }, { key: 'amount', title: '金额', align: 'right' }]}
          rows={drill.rows.map((r) => ({ name: r.name, amount: fmtMoney(r.amount, unit) }))}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

function categoriesOf(list: { cat: string; amount: number }[], cats: string[]): (number | null)[] {
  return cats.map((c) => list.find((x) => x.cat === c)?.amount ?? null);
}

function PageHeader({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">财务报表（三张表）</h2>
        <p className="mt-0.5 text-xs text-slate-400">会计健康视角 · 表与图互相勾稽 · 只读账号可查看与导出</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function DetailTable({ title, rows, unit }: { title: string; rows: { name: string; amount: number }[]; unit: 'yuan' | 'wanyuan' }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-slate-500">{title}</p>
      <table className="w-full text-xs">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-50 last:border-0">
              <td className="py-1 text-slate-600">{r.name}</td>
              <td className="py-1 text-right tabular-nums">{fmtMoney(r.amount, unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryDetail({ direction, items, unit }: { direction: string; items: { cat: string; amount: number; children?: { cat: string; amount: number; largeItems?: { name: string; amount: number }[] }[] }[]; unit: 'yuan' | 'wanyuan' }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-slate-500">{direction}</p>
      {items.map((top) => (
        <div key={top.cat} className="mb-1">
          <div className="flex justify-between py-0.5 text-xs font-medium text-slate-600">
            <span>{top.cat}</span>
            <span className="tabular-nums">{fmtMoney(top.amount, unit)}</span>
          </div>
          {(top.children ?? []).map((c) => (
            <div key={c.cat}>
              <div className="flex justify-between py-0.5 pl-4 text-xs text-slate-500">
                <span>{c.cat}</span>
                <span className="tabular-nums">{fmtMoney(c.amount, unit)}</span>
              </div>
              {(c.largeItems ?? []).map((li, i) => (
                <div key={i} className="flex justify-between py-0.5 pl-8 text-[11px] text-slate-400">
                  <span>└ {li.name}</span>
                  <span className="tabular-nums">{fmtMoney(li.amount, unit)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
