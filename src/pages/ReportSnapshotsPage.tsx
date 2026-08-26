/**
 * 报告快照页（UI-12 / F-13 + F-11 导出入口，06 T23）：
 * - 列表：类型/期间/生成时间/总资产/净资产/负债率/期间结余/冻结状态（F-13 规则 1）
 * - 生成（仅 admin，写操作，决策 D6）：类型 + 期间；重复期间拒绝（409）；缺月逐月列出（400）；
 *   年报须完整自然年 12 个月（D4：未满时选项不可选）；进度反馈
 * - 详情：KPI + 2×2 四图（期末树图 / 净资产变动瀑布·精简 / 期间收支流向桑基·累计 / 期末负债结构环）
 *   + 期间三张表 + 全量明细折叠 + 关联 AI 记录（冻结内容，规则 5）
 * - 跨期对比：勾选 A/B → 并排指标（绝对差 + 百分比 + 方向）+ 模块对比图 + 逐模块差异表（高亮变动行）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../adapters/shared/useAuth';
import { useToast } from '@shared/core/hooks/useToast';
import { ArrowLeft, Download, Lock } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { addMonths, fmtDateTime, fmtMoney, fmtRate, periodLabel, reportTypeLabel } from '../lib/format';
import type { ReportCompareData, ReportSnapshotDetail, ReportSnapshotListItem, SnapshotsListData } from '../lib/types';
import { CollapseDetail } from '../components/common/CollapseDetail';
import { EmptyState } from '../components/common/EmptyState';
import { KpiCard } from '../components/common/KpiCard';
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

type View = { name: 'list' } | { name: 'detail'; id: number } | { name: 'compare'; a: number; b: number };

export default function ReportSnapshotsPage() {
  const { role } = useAuth();
  const { showToast } = useToast();
  const { unit } = useUi();
  const [list, setList] = useState<ReportSnapshotListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>({ name: 'list' });
  const [selected, setSelected] = useState<number[]>([]);
  const [genOpen, setGenOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ list: ReportSnapshotListItem[] }>('/api/report-snapshots');
      setList(res.list);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleSelect = (id: number) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));
  };

  const startCompare = () => {
    if (selected.length !== 2) {
      showToast('请勾选两份报告快照后再对比', 'warning');
      return;
    }
    setView({ name: 'compare', a: selected[0], b: selected[1] });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">定期报告快照</h2>
          <p className="mt-0.5 text-xs text-slate-400">季报/半年报/年报 · 生成即冻结 · 任选两份跨期对比</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view.name === 'list' ? (
            <>
              <UnitSwitch />
              <button
                onClick={startCompare}
                disabled={selected.length !== 2}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                对比所选（{selected.length}/2）
              </button>
              {role === 'admin' && (
                <button onClick={() => setGenOpen(true)} className="btn-primary py-1.5">
                  ＋ 生成新快照
                </button>
              )}
            </>
          ) : (
            <button onClick={() => { setView({ name: 'list' }); setSelected([]); }} className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              <ArrowLeft size={14} /> 返回列表
            </button>
          )}
        </div>
      </div>

      {view.name === 'list' && (
        <ListView list={list} loading={loading} selected={selected} toggleSelect={toggleSelect} onOpen={(id) => setView({ name: 'detail', id })} unit={unit} />
      )}
      {view.name === 'detail' && <DetailView id={view.id} unit={unit} />}
      {view.name === 'compare' && <CompareView a={view.a} b={view.b} unit={unit} />}

      {genOpen && (
        <GenerateDialog
          onClose={() => setGenOpen(false)}
          onDone={() => {
            setGenOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// 列表
// ============================================================
function ListView({ list, loading, selected, toggleSelect, onOpen, unit }: {
  list: ReportSnapshotListItem[];
  loading: boolean;
  selected: number[];
  toggleSelect: (id: number) => void;
  onOpen: (id: number) => void;
  unit: 'yuan' | 'wanyuan';
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    );
  }
  if (list.length === 0) {
    return <EmptyState title="尚无定期报告快照" description="选择报告类型与期间生成第一份冻结快照（季报/半年报/年报）。" />;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs text-slate-500">
            <th className="px-3 py-2.5 font-medium">选择</th>
            <th className="px-3 py-2.5 font-medium">类型</th>
            <th className="px-3 py-2.5 font-medium">报告期间</th>
            <th className="px-3 py-2.5 font-medium">生成时间</th>
            <th className="px-3 py-2.5 text-right font-medium">期末总资产</th>
            <th className="px-3 py-2.5 text-right font-medium">净资产</th>
            <th className="px-3 py-2.5 text-right font-medium">负债率</th>
            <th className="px-3 py-2.5 text-right font-medium">期间结余</th>
            <th className="px-3 py-2.5 font-medium">状态</th>
            <th className="px-3 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id} className="border-b border-slate-50 last:border-0">
              <td className="px-3 py-2">
                <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggleSelect(r.id)} className="accent-blue-600" aria-label={`选择 ${reportTypeLabel(r.reportType)} ${periodLabel(r.startMonth, r.endMonth)}`} />
              </td>
              <td className="px-3 py-2">{reportTypeLabel(r.reportType)}</td>
              <td className="px-3 py-2 tabular-nums">{periodLabel(r.startMonth, r.endMonth)}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{fmtDateTime(r.generatedAt)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.totalAssets, unit)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${r.netWorth < 0 ? 'text-red-600' : ''}`}>{fmtMoney(r.netWorth, unit)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtRate(r.debtRatio, 4)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.periodBalance, unit)}</td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                  <Lock size={10} /> 已冻结
                </span>
              </td>
              <td className="px-3 py-2 text-right">
                <button onClick={() => onOpen(r.id)} className="rounded-lg bg-blue-50 px-3 py-1 text-xs font-medium text-blue-600 hover:bg-blue-100">
                  查看详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// 详情
// ============================================================
function DetailView({ id, unit }: { id: number; unit: 'yuan' | 'wanyuan' }) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<ReportSnapshotDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await api<ReportSnapshotDetail>(`/api/report-snapshots/${id}`);
        if (alive) setDetail(res);
      } catch (e) {
        if (alive) showToast(e instanceof Error ? e.message : '加载失败', 'error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, showToast]);

  if (loading) return <div className="h-64 animate-pulse rounded-lg bg-slate-100" />;
  if (!detail) return <EmptyState title="报告快照不存在" />;

  const sankey = detail.charts.sankey;
  const flows: { source: string; target: string; value: number }[] = [];
  for (const i of sankey.income) if (i.amount > 0) flows.push({ source: i.cat, target: '总收入', value: i.amount });
  for (const e of sankey.expense) if (e.amount > 0) flows.push({ source: '总收入', target: e.cat, value: e.amount });
  if (sankey.balance > 0) flows.push({ source: '总收入', target: '结余/净储蓄', value: sankey.balance });
  const palette = buildSankeyPaletteMap(sankey.income.map((i) => i.cat), sankey.expense.map((e) => e.cat));

  const wfStart = detail.charts.waterfall.find((w) => w.type === 'start');
  const wfEnd = detail.charts.waterfall.find((w) => w.type === 'end');
  const wfDeltas = detail.charts.waterfall.filter((w) => w.type === 'delta');

  const details = detail.details as {
    incomeByCat?: { cat: string; amount: number }[];
    expenseByCat?: { cat: string; amount: number }[];
    debts?: { name: string; term: string; balance: number; repayment: number }[];
    monthlyBalances?: { month: string; balance: number }[];
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-800">
          {reportTypeLabel(detail.reportType)} · {periodLabel(detail.startMonth, detail.endMonth)}
          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-normal text-slate-500">
            <Lock size={10} /> 冻结于 {fmtDateTime(detail.generatedAt)}
          </span>
        </h3>
        <button
          onClick={() => {
            setExporting(true);
            exportPdf('report', { id })
              .then((f) => showToast(`PDF 已生成：${f}`, 'success', 5000))
              .catch((e) => showToast(`PDF 生成失败：${e instanceof Error ? e.message : '未知原因'}`, 'error', 6000))
              .finally(() => setExporting(false));
          }}
          disabled={exporting}
          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <Download size={14} /> {exporting ? '生成中…' : '导出 PDF'}
        </button>
      </div>

      {/* KPI（期末口径） */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="期末总资产" value={fmtMoney(detail.kpis.totalAssets, unit)} />
        <KpiCard label="期末净资产" value={fmtMoney(detail.kpis.netWorth, unit)} negative={detail.kpis.netWorth < 0} />
        <KpiCard label="期末负债率" value={fmtRate(detail.kpis.debtRatio, 4)} />
        <KpiCard label="期间结余" value={fmtMoney(detail.kpis.periodBalance, unit)} emphasized />
      </div>

      {/* 2×2 四图 */}
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="期末资产配置（树图）" subtitle="期末月份口径">
          <LazyChart>
            <LazyTreemap
              data={detail.charts.treemap.map((t) => ({ name: t.module, amount: t.amount, children: t.children.map((c) => ({ name: c.name, amount: c.amount })) }))}
              palette={MODULE_PALETTE}
              unit={unit}
              height={280}
            />
          </LazyChart>
        </ChartCard>
        <ChartCard title="净资产变动（瀑布图 · 精简）" subtitle="期初净资产 → +期间结余 ±估值与其他 → 期末净资产">
          <LazyChart>
            <LazyWaterfall
              openingTotal={wfStart?.amount ?? 0}
              items={wfDeltas.map((w) => ({ label: w.name, delta: w.amount }))}
              closingTotal={wfEnd?.amount}
              unit={unit}
              height={280}
            />
          </LazyChart>
        </ChartCard>
        <ChartCard title="期间收支流向（桑基图 · 期间累计）" subtitle={`数据 = 报告期间各月各类别累加 · 结余率 ${fmtRate(sankey.balanceRatio)}`}>
          <LazyChart>
            <LazySankey flows={flows} paletteMap={palette} linkColorMode="source" unit={unit} height={280} />
          </LazyChart>
        </ChartCard>
        <ChartCard title="期末负债结构（环形图 · 短期/长期）" loading={false}>
          <LazyChart>
            <LazyDonut
              slices={detail.charts.debtDonut.map((d) => ({ name: d.term === 'short' ? '短期（<1年）' : '长期（≥1年）', value: d.amount, color: d.term === 'short' ? TERM_COLORS.short : TERM_COLORS.long }))}
              centerValue={fmtMoney(detail.charts.debtDonut.reduce((s, d) => s + d.amount, 0), unit)}
              centerLabel="期末总负债"
              unit={unit}
              height={280}
            />
          </LazyChart>
        </ChartCard>
      </div>

      {/* 期间三张表（折叠） */}
      <CollapseDetail title="期间聚合三张表（资产负债=期末口径；收支/现金流=期间累加口径）">
        <StatementsBlock statements={detail.statements} unit={unit} />
      </CollapseDetail>

      {/* 全量明细（折叠） */}
      <CollapseDetail title="全量汇总明细（期间收入/支出/结余/负债构成）">
        <div className="grid gap-4 sm:grid-cols-2">
          <MiniTable title="期间收入（按类别）" rows={(details.incomeByCat ?? []).map((x) => ({ name: x.cat, amount: x.amount }))} unit={unit} />
          <MiniTable title="期间支出（按类别）" rows={(details.expenseByCat ?? []).map((x) => ({ name: x.cat, amount: x.amount }))} unit={unit} />
          <MiniTable title="期末负债构成" rows={(details.debts ?? []).map((d) => ({ name: `${d.name}（${d.term === 'short' ? '短期' : '长期'}）· 期间还款 ${fmtMoney(d.repayment, unit)}`, amount: d.balance }))} unit={unit} />
          <MiniTable title="逐月结余" rows={(details.monthlyBalances ?? []).map((m) => ({ name: m.month, amount: m.balance }))} unit={unit} />
        </div>
      </CollapseDetail>

      {/* 关联 AI 记录 */}
      <CollapseDetail title={`关联 AI 分析记录（${detail.aiRecords.length}）`} defaultOpen={false}>
        {detail.aiRecords.length === 0 ? (
          <p className="text-xs text-slate-400">期间内无 AI 分析记录。</p>
        ) : (
          detail.aiRecords.map((r) => (
            <div key={r.id} className="mb-2 rounded-lg border border-slate-100 p-3">
              <p className="mb-1 text-xs font-medium text-slate-600">分析日期 {r.analysisDate} · 资产月份 {r.assetMonth}</p>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-slate-500">
                {(r.payload.suggestions ?? []).map((s, i) => (
                  <li key={i}>
                    [{s.priority}] {s.type} · {s.module}：{s.plan}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </CollapseDetail>
    </div>
  );
}

function StatementsBlock({ statements, unit }: { statements: ReportSnapshotDetail['statements']; unit: 'yuan' | 'wanyuan' }) {
  const bs = statements.balanceSheet;
  const is = statements.incomeStatement;
  const cf = statements.cashFlow as { kpi?: { openingCash: number; netCashFlow: number; closingCash: number }; waterfall?: { name: string; amount: number; type: string }[] } | null | undefined;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div>
        <p className="mb-1 text-xs font-semibold text-slate-500">资产负债表（期末）</p>
        {bs ? (
          <div className="space-y-1 text-xs text-slate-600">
            <div className="flex justify-between"><span>资产总计</span><span className="tabular-nums">{fmtMoney(bs.kpi.totalAssets, unit)}</span></div>
            <div className="flex justify-between"><span>负债总计（短 {fmtMoney(bs.kpi.shortTermDebt, unit)} / 长 {fmtMoney(bs.kpi.longTermDebt, unit)}）</span><span className="tabular-nums">{fmtMoney(bs.kpi.totalDebt, unit)}</span></div>
            <div className="flex justify-between font-medium"><span>净资产</span><span className="tabular-nums">{fmtMoney(bs.kpi.netWorth, unit)}</span></div>
            <div className="flex justify-between"><span>负债率</span><span className="tabular-nums">{fmtRate(bs.kpi.debtRatio, 4)}</span></div>
          </div>
        ) : (
          <p className="text-xs text-slate-400">—</p>
        )}
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold text-slate-500">收支表（期间累加）</p>
        {is ? (
          <div className="space-y-1 text-xs text-slate-600">
            <div className="flex justify-between"><span>总收入</span><span className="tabular-nums">{fmtMoney(is.kpi.totalIncome, unit)}</span></div>
            <div className="flex justify-between"><span>总支出</span><span className="tabular-nums">{fmtMoney(is.kpi.totalExpense, unit)}</span></div>
            <div className="flex justify-between font-medium"><span>期间结余</span><span className="tabular-nums">{fmtMoney(is.kpi.balance, unit)}</span></div>
          </div>
        ) : (
          <p className="text-xs text-slate-400">—</p>
        )}
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold text-slate-500">现金流量表（期间）</p>
        {cf ? (
          <div className="space-y-1 text-xs text-slate-600">
            <div className="flex justify-between"><span>期初现金</span><span className="tabular-nums">{fmtMoney(cf.kpi?.openingCash ?? 0, unit)}</span></div>
            <div className="flex justify-between font-medium"><span>净现金流</span><span className="tabular-nums">{fmtMoney(cf.kpi?.netCashFlow ?? 0, unit)}</span></div>
            <div className="flex justify-between"><span>期末现金</span><span className="tabular-nums">{fmtMoney(cf.kpi?.closingCash ?? 0, unit)}</span></div>
          </div>
        ) : (
          <p className="text-xs text-slate-400">期初之前无快照，期间现金流不可用。</p>
        )}
      </div>
    </div>
  );
}

function MiniTable({ title, rows, unit }: { title: string; rows: { name: string; amount: number }[]; unit: 'yuan' | 'wanyuan' }) {
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

// ============================================================
// 对比视图
// ============================================================
function CompareView({ a, b, unit }: { a: number; b: number; unit: 'yuan' | 'wanyuan' }) {
  const { showToast } = useToast();
  const [data, setData] = useState<ReportCompareData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await api<ReportCompareData>('/api/report-snapshots/compare', { query: { a, b } });
        if (alive) setData(res);
      } catch (e) {
        if (alive) showToast(e instanceof Error ? e.message : '加载失败', 'error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [a, b, showToast]);

  const modules = useMemo(() => (data ? data.moduleCompare.map((m) => m.module) : []), [data]);

  if (loading) return <div className="h-64 animate-pulse rounded-lg bg-slate-100" />;
  if (!data) return <EmptyState title="对比数据加载失败" />;

  const METRIC_LABEL: Record<string, string> = { totalAssets: '期末总资产', netWorth: '期末净资产', debtRatio: '负债率（百分点）', periodBalance: '期间结余' };

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold text-slate-800">
        跨期对比：{data.a.label} <span className="text-slate-400">vs</span> {data.b.label}
      </h3>

      {/* 并排指标差异 */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {data.diffs.map((d) => (
          <div key={d.metric} className="card">
            <p className="text-xs text-slate-500">{METRIC_LABEL[d.metric] ?? d.metric}</p>
            <p className="mt-1 flex items-baseline gap-1 text-lg font-semibold tabular-nums">
              <span className={d.direction === 'up' ? 'text-emerald-600' : d.direction === 'down' ? 'text-red-600' : 'text-slate-700'}>
                {d.direction === 'up' ? '▲' : d.direction === 'down' ? '▼' : '—'}
              </span>
              {fmtMoney(d.bValue, unit)}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              A {fmtMoney(d.aValue, unit)} → B {fmtMoney(d.bValue, unit)}；差 {fmtMoney(d.absDiff, unit)}
              {d.pctDiff !== null ? `（${(d.pctDiff * 100).toFixed(2)}%）` : ''}
            </p>
          </div>
        ))}
      </div>

      {/* 模块余额对比图 */}
      <ChartCard title="各模块期末余额对比（A vs B）" subtitle={`A = ${data.a.label}；B = ${data.b.label}`}>
        <ChartGroupBar
          categories={modules}
          series={[
            { name: data.a.label, values: data.moduleCompare.map((m) => m.aAmount), color: '#2a78d6' },
            { name: data.b.label, values: data.moduleCompare.map((m) => m.bAmount), color: '#eb6834' },
          ]}
          unit={unit}
          height={320}
        />
      </ChartCard>

      {/* 逐模块差异表（折叠 + 高亮变动行） */}
      <CollapseDetail title="逐模块差异明细表">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-left text-slate-400">
              <th className="py-1.5 font-medium">模块</th>
              <th className="py-1.5 text-right font-medium">A</th>
              <th className="py-1.5 text-right font-medium">B</th>
              <th className="py-1.5 text-right font-medium">差异</th>
              <th className="py-1.5 text-right font-medium">差异%</th>
            </tr>
          </thead>
          <tbody>
            {data.moduleCompare.map((m) => (
              <tr key={m.module} className={`border-b border-slate-50 last:border-0 ${m.absDiff !== 0 ? 'bg-amber-50/60' : ''}`}>
                <td className="py-1.5 text-slate-600">{m.module}</td>
                <td className="py-1.5 text-right tabular-nums">{m.aAmount === null ? '—' : fmtMoney(m.aAmount, unit)}</td>
                <td className="py-1.5 text-right tabular-nums">{m.bAmount === null ? '—' : fmtMoney(m.bAmount, unit)}</td>
                <td className={`py-1.5 text-right tabular-nums ${m.absDiff > 0 ? 'text-emerald-600' : m.absDiff < 0 ? 'text-red-600' : ''}`}>{fmtMoney(m.absDiff, unit)}</td>
                <td className="py-1.5 text-right tabular-nums">{m.pctDiff === null ? '—' : `${(m.pctDiff * 100).toFixed(2)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CollapseDetail>

      {/* 负债对比 */}
      <CollapseDetail title="负债对比">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-left text-slate-400">
              <th className="py-1.5 font-medium">负债</th>
              <th className="py-1.5 text-right font-medium">A 余额</th>
              <th className="py-1.5 text-right font-medium">B 余额</th>
              <th className="py-1.5 text-right font-medium">差异</th>
            </tr>
          </thead>
          <tbody>
            {data.debtCompare.map((d) => (
              <tr key={d.name} className={`border-b border-slate-50 last:border-0 ${d.absDiff !== 0 ? 'bg-amber-50/60' : ''}`}>
                <td className="py-1.5 text-slate-600">{d.name}</td>
                <td className="py-1.5 text-right tabular-nums">{d.aBalance === null ? '—' : fmtMoney(d.aBalance, unit)}</td>
                <td className="py-1.5 text-right tabular-nums">{d.bBalance === null ? '—' : fmtMoney(d.bBalance, unit)}</td>
                <td className={`py-1.5 text-right tabular-nums ${d.absDiff > 0 ? 'text-emerald-600' : d.absDiff < 0 ? 'text-red-600' : ''}`}>{fmtMoney(d.absDiff, unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CollapseDetail>
    </div>
  );
}

// ============================================================
// 生成弹窗
// ============================================================
function GenerateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { showToast } = useToast();
  const [reportType, setReportType] = useState<'quarter' | 'half' | 'year'>('quarter');
  const [availMonths, setAvailMonths] = useState<string[]>([]);
  const [startMonth, setStartMonth] = useState('');
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState('');

  const span = reportType === 'quarter' ? 3 : reportType === 'half' ? 6 : 12;

  useEffect(() => {
    (async () => {
      try {
        const res = await api<SnapshotsListData>('/api/snapshots', { query: { range: 'all' } });
        const months = res.months.map((m) => m.month);
        setAvailMonths(months);
        // 合法起始月：对齐自然期间且期间月份齐全
        const starts = months.filter((m) => {
          const mm = Number(m.slice(5));
          const aligned = reportType === 'quarter' ? [1, 4, 7, 10].includes(mm) : reportType === 'half' ? [1, 7].includes(mm) : mm === 1;
          if (!aligned) return false;
          for (let i = 0; i < span; i++) {
            if (!months.includes(addMonths(m, i))) return false;
          }
          return true;
        });
        if (starts.length > 0) setStartMonth(starts[starts.length - 1]);
      } catch {
        // 无快照时保持空
      }
    })();
  }, [reportType, span]);

  const eligibleStarts = useMemo(
    () =>
      availMonths.filter((m) => {
        const mm = Number(m.slice(5));
        const aligned = reportType === 'quarter' ? [1, 4, 7, 10].includes(mm) : reportType === 'half' ? [1, 7].includes(mm) : mm === 1;
        if (!aligned) return false;
        for (let i = 0; i < span; i++) {
          if (!availMonths.includes(addMonths(m, i))) return false;
        }
        return true;
      }),
    [availMonths, reportType, span]
  );

  // 年报可用性：需完整自然年 12 个月数据（决策 D4）
  const yearAvailable = useMemo(
    () =>
      availMonths.some((m) => m.endsWith('-01') && Array.from({ length: 12 }, (_, i) => addMonths(m, i)).every((mm) => availMonths.includes(mm))),
    [availMonths]
  );

  const generate = async () => {
    if (!startMonth) {
      showToast('请选择报告期间起始月', 'warning');
      return;
    }
    setGenerating(true);
    setProgress('正在聚合期间数据并生成冻结快照…');
    try {
      const res = await api<ReportSnapshotListItem>('/api/report-snapshots', {
        method: 'POST',
        body: { reportType, startMonth, endMonth: addMonths(startMonth, span - 1) },
      });
      setProgress('生成完成。');
      showToast(`已生成 ${reportTypeLabel(res.reportType)}（${periodLabel(res.startMonth, res.endMonth)}），冻结保存`, 'success', 5000);
      onDone();
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.details?.map((d) => d.message).join('；') ?? ae.message ?? '生成失败', 'error', 6000);
      setProgress('');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !generating && onClose()} />
      <div className="animate-in zoom-in-95 relative w-full max-w-md rounded-xl bg-white p-6 shadow-2xl duration-200">
        <h3 className="mb-4 font-semibold text-slate-900">生成定期报告快照</h3>
        <div className="mb-3">
          <label className="mb-1 block text-xs text-slate-500">报告类型</label>
          <div className="flex gap-2">
            {(['quarter', 'half', 'year'] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setReportType(t);
                  setStartMonth('');
                }}
                disabled={t === 'year' && !yearAvailable}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  reportType === t ? 'border-blue-500 bg-blue-50 font-medium text-blue-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
                title={t === 'year' && !yearAvailable ? '年报需完整自然年 12 个月数据（决策 D4）' : ''}
              >
                {reportTypeLabel(t)}
              </button>
            ))}
          </div>
        </div>
        <div className="mb-3">
          <label className="mb-1 block text-xs text-slate-500">起始月（自动对齐自然期间，期间 = {span} 个月）</label>
          <select value={startMonth} onChange={(e) => setStartMonth(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
            <option value="">请选择</option>
            {eligibleStarts.map((m) => (
              <option key={m} value={m}>
                {m} ~ {addMonths(m, span - 1)}
              </option>
            ))}
          </select>
          {eligibleStarts.length === 0 && <p className="mt-1 text-xs text-amber-600">当前数据中无满足条件的完整期间（期间内每月均须有快照）。</p>}
        </div>
        {progress && <p className="mb-3 text-xs text-blue-600">{progress}</p>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} disabled={generating} className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 hover:bg-slate-200">
            取消
          </button>
          <button onClick={() => void generate()} disabled={generating || !startMonth} className="btn-primary">
            {generating ? '生成中…' : '生成并冻结'}
          </button>
        </div>
      </div>
    </div>
  );
}
