/**
 * 资产报表页（UI-03 / F-04 + F-03 四态 + F-12 更新状态，06 T21）：
 * KPI（▲▼）+ 四图（堆叠面积·预期虚线实际实线 / 树图 / 桑基·趋势图下方 / 目标-实际对比柱），
 * 范围切换（近12月/年度/全部）+ 月份联动 + 元/万元切换 + 渐进披露（明细折叠）+ 点击下钻。
 * 图表经 financeChartAdapter 薄适配层（色板注入/单位换算/下钻接线），懒加载。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@shared/core/hooks/useAuth';
import { useToast } from '@shared/core/hooks/useToast';
import { api, ApiError } from '../lib/api';
import { fmtMoney, fmtRate, fmtSignedRate } from '../lib/format';
import type { AssetReportData, FinanceReportData, TreeConfig } from '../lib/types';
import { CollapseDetail } from '../components/common/CollapseDetail';
import { DrillPanel } from '../components/common/DrillPanel';
import { EmptyState } from '../components/common/EmptyState';
import { KpiCard } from '../components/common/KpiCard';
import { MonthPicker } from '../components/common/MonthPicker';
import { UnitSwitch } from '../components/common/UnitSwitch';
import { ChartCard } from '../components/charts/ChartCard';
import {
  buildSankeyPaletteMap,
  LazyChart,
  LazyCompareBar,
  LazySankey,
  LazyStackedArea,
  LazyTreemap,
  MODULE_PALETTE,
} from '../components/charts/financeChartAdapter';
import { useUi, type TrendRange } from '../context/UiContext';

type Drill =
  | { kind: 'module'; module: string; rows: { name: string; amount: number }[] }
  | { kind: 'category'; title: string; rows: { name: string; amount: number }[] }
  | { kind: 'gain'; module: string; rows: { name: string; amount: number }[] }
  | null;

export default function AssetReportPage() {
  const { role } = useAuth();
  const { showToast } = useToast();
  const { month, setMonth, unit, range, setRange, year, setYear } = useUi();

  const [data, setData] = useState<AssetReportData | null>(null);
  const [treeConfig, setTreeConfig] = useState<TreeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [drill, setDrill] = useState<Drill>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 趋势图点击月份 → 联动切换后自动下钻该月模块构成（F-04 规则 1）
  const pendingDrillMonth = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDrill(null); // 月份/报表重绘时旧下钻面板自动清除（02 §3.2）
    try {
      const [res, tree] = await Promise.all([
        api<AssetReportData>('/api/reports/assets', {
          query: { month, range, ...(range === 'year' ? { year } : {}) },
        }),
        api<TreeConfig>('/api/tree').catch(() => null),
      ]);
      setTreeConfig(tree);
      setData(res);
      // 若当前选中月不在趋势序列中（如切换范围后），对齐到序列末月
      if (res.trend.months.length > 0 && !res.trend.months.includes(month)) {
        setMonth(res.trend.months[res.trend.months.length - 1]);
      } else if (pendingDrillMonth.current === month) {
        setDrill({ kind: 'module', module: `${month} 模块构成`, rows: res.treemap.map((t) => ({ name: t.module, amount: t.amount })) });
      }
      pendingDrillMonth.current = null;
    } catch (e) {
      const ae = e as ApiError;
      setError(ae);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [month, range, year, setMonth]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // ---------- 下钻 ----------
  const drillTreemapModule = (name: string) => {
    if (!data) return;
    const mod = data.treemap.find((t) => t.module === name);
    const rows = mod ? mod.children.map((c) => ({ name: c.name, amount: c.amount })) : [];
    setDrill({ kind: 'module', module: name, rows });
  };

  const drillSankey = async (payload: { type: 'node' | 'link'; name: string; source?: string; target?: string; value: number }) => {
    if (!data) return;
    const cat: string = (payload.type === 'link' ? (payload.source === '总收入' ? payload.target : payload.source) : payload.name) ?? payload.name;
    if (cat === '总收入') {
      setDrill({
        kind: 'category',
        title: '总收入构成',
        rows: data.sankey.income.map((i) => ({ name: i.cat, amount: i.amount })),
      });
      return;
    }
    if (cat === '结余/净储蓄') {
      setDrill({
        kind: 'category',
        title: '结余构成（总收入 − 总支出）',
        rows: [
          { name: '总收入', amount: data.sankey.totalIncome },
          { name: '总支出', amount: -data.sankey.expense.reduce((s, x) => s + x.amount, 0) },
          { name: '结余', amount: data.sankey.balance },
        ],
      });
      return;
    }
    // 分类下钻：取财务报表逐类别明细（懒请求）
    try {
      const fin = await api<FinanceReportData>('/api/reports/finance', { query: { month } });
      const findIn = (dir: 'income' | 'expense') =>
        fin.incomeStatement.details[dir].find((d) => d.cat === cat);
      const hit = findIn('income') ?? findIn('expense');
      const rows = hit
        ? (hit.children ?? []).map((c) => ({ name: c.cat, amount: c.amount }))
        : [{ name: cat, amount: payload.value }];
      setDrill({ kind: 'category', title: `${cat} · 二级构成（${month}）`, rows });
    } catch {
      setDrill({ kind: 'category', title: cat, rows: [{ name: cat, amount: payload.value }] });
    }
  };

  const drillGainCompare = (payload: { module: string; actualRate: number | null; targetRate: number | null }) => {
    if (!data) return;
    const g = data.gainCompare.find((x) => x.module === payload.module);
    if (!g) return;
    const modeText = { auto: '自动计算（无新增·环比）', converted: '收益金额折算', blank: '有新增·留空', na: '不可折算（上月余额为 0）' }[g.mode];
    setDrill({
      kind: 'gain',
      module: g.module,
      rows: [
        { name: '收益率口径', amount: Number.NaN },
        { name: modeText, amount: Number.NaN },
        { name: `目标（月化=年化/12）：${fmtRate(g.targetMonthlyRate)}`, amount: Number.NaN },
        { name: `实际：${g.actualRate === null ? '—' : fmtRate(g.actualRate)}`, amount: Number.NaN },
        ...(g.gain !== null ? [{ name: `收益金额：${fmtMoney(g.gain)}`, amount: Number.NaN }] : []),
      ],
    });
  };

  /** 堆叠面积点击月份：联动切换全部图表并下钻该月模块构成（F-04 规则 1） */
  const drillMonth = (payload: { month: string }) => {
    if (payload.month === month) {
      // 同月：直接展开该月模块构成
      if (data) setDrill({ kind: 'module', module: `${payload.month} 模块构成`, rows: data.treemap.map((t) => ({ name: t.module, amount: t.amount })) });
      return;
    }
    pendingDrillMonth.current = payload.month; // 重新加载完成后自动展开该月模块构成
    setMonth(payload.month);
  };

  // 资金/实物资产分类汇总（基于 treemap 模块名与树配置 assetCategory 匹配）
  const categoryTotals = useMemo(() => {
    if (!data || !treeConfig) return null;
    const topModules = treeConfig.nodes.filter((n) => n.parentId === null && n.enabled);
    let financial = 0;
    let physical = 0;
    for (const tm of data.treemap) {
      const matched = topModules.find((n) => n.name === tm.module);
      if (matched?.assetCategory === 'physical') physical += tm.amount;
      else financial += tm.amount;
    }
    if (physical === 0) return null;
    return { financial, physical };
  }, [data, treeConfig]);

  // 桑基流带构造
  const sankeyFlows = useMemo(() => {
    if (!data) return [];
    const flows: { source: string; target: string; value: number }[] = [];
    for (const i of data.sankey.income) {
      if (i.amount > 0) flows.push({ source: i.cat, target: '总收入', value: i.amount });
    }
    for (const e of data.sankey.expense) {
      if (e.amount > 0) flows.push({ source: '总收入', target: e.cat, value: e.amount });
    }
    if (data.sankey.balance > 0) flows.push({ source: '总收入', target: '结余/净储蓄', value: data.sankey.balance });
    return flows;
  }, [data]);

  const sankeyPalette = useMemo(() => {
    if (!data) return {};
    return buildSankeyPaletteMap(data.sankey.income.map((i) => i.cat), data.sankey.expense.map((e) => e.cat));
  }, [data]);

  // 无快照空态
  if (!loading && error?.status === 404) {
    return (
      <div className="space-y-4">
        <Header />
        <EmptyState
          title={`${month} 尚无资产快照`}
          description={role === 'viewer' ? '等待管理员录入本月数据后即可查看报表。' : '请先在「月末录入」页完成本月录入，再回来查看报表。'}
          action={
            role === 'admin' ? (
              <Link to="/entry" className="btn-primary">
                去录入
              </Link>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Header>
        <RangeSwitch range={range} setRange={setRange} year={year} setYear={setYear} />
        {data && <MonthPicker months={data.trend.months} value={month} onChange={setMonth} />}
        <UnitSwitch />
      </Header>

      {error && error.status !== 404 && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          加载失败：{error.message}
          <button onClick={() => setReloadKey((k) => k + 1)} className="ml-3 rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700">
            重试
          </button>
        </div>
      )}

      {data && (
        <>
          {/* KPI（▲▼ 方向标记，色彩不单独承载语义） */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiCard label="总资产" value={fmtMoney(data.kpi.totalAssets, unit)} direction={data.kpi.momGrowth === null ? 'flat' : data.kpi.momGrowth >= 0 ? 'up' : 'down'} hint={`环比 ${fmtSignedRate(data.kpi.momGrowth)}`} />
            <KpiCard label="净资产（总资产−总负债）" value={fmtMoney(data.kpi.netWorth, unit)} negative={data.kpi.netWorth < 0} hint={data.kpi.netWorth < 0 ? '负债大于资产，净资产为负值' : undefined} />
            <KpiCard label="环比增长" value={data.kpi.momGrowth === null ? '—' : fmtSignedRate(data.kpi.momGrowth)} direction={data.kpi.momGrowth === null ? 'flat' : data.kpi.momGrowth >= 0 ? 'up' : 'down'} hint="上月无快照时不可计算" />
            <KpiCard label="负债率（总负债/总资产）" value={fmtRate(data.kpi.debtRatio, 4)} hint="唯一住房资产价值未计入资产，房贷负债计入" negative={data.kpi.debtRatio > 1} />
          </div>

          {/* 资金/实物资产分类汇总（仅有实物资产时展示） */}
          {categoryTotals && (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-3 rounded-xl border border-blue-100 bg-blue-50/50 px-4 py-3">
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">💰 资金资产</span>
                <span className="text-lg font-bold tabular-nums text-blue-800">{fmtMoney(categoryTotals.financial, unit)}</span>
                <span className="ml-auto text-xs text-blue-500">{data.kpi.totalAssets > 0 ? `${((categoryTotals.financial / data.kpi.totalAssets) * 100).toFixed(1)}%` : ''}</span>
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-amber-100 bg-amber-50/50 px-4 py-3">
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">📱 实物资产</span>
                <span className="text-lg font-bold tabular-nums text-amber-800">{fmtMoney(categoryTotals.physical, unit)}</span>
                <span className="ml-auto text-xs text-amber-500">{data.kpi.totalAssets > 0 ? `${((categoryTotals.physical / data.kpi.totalAssets) * 100).toFixed(1)}%` : ''}</span>
              </div>
            </div>
          )}

          {/* ① 堆叠面积：总资产趋势（预期虚线/实际实线） */}
          <ChartCard title="总资产趋势（堆叠面积）" subtitle="各模块堆积 · 预期收益虚线 / 实际收益实线 · 点击月份联动切换全部图表" loading={loading} error={error ? error.message : null} onRetry={() => setReloadKey((k) => k + 1)}>
            <LazyChart>
              <LazyStackedArea
                months={data.trend.months}
                series={data.trend.byModule.map((m) => ({
                  module: m.module,
                  points: data.trend.months.map((mm, i) => ({ month: mm, amount: m.amounts[i] ?? 0 })),
                }))}
                actual={data.trend.total}
                expected={data.trend.expected}
                palette={MODULE_PALETTE}
                unit={unit}
                height={340}
                onItemClick={drillMonth}
              />
            </LazyChart>
          </ChartCard>

          {/* ③ 桑基：资金流向（趋势图下方，提升可发现性） */}
          <ChartCard title="资金流向（桑基图）" subtitle={`收入类别 →「总收入」→ 支出类别（灰）+ 结余（绿）· 结余率 ${fmtRate(data.sankey.balanceRatio)}`} loading={loading}>
            <LazyChart>
              <LazySankey flows={sankeyFlows} paletteMap={sankeyPalette} linkColorMode="source" unit={unit} height={300} onItemClick={(p) => void drillSankey(p)} />
            </LazyChart>
          </ChartCard>

          <div className="grid gap-4 xl:grid-cols-2">
            {/* ② 树图：资产配置 */}
            <ChartCard title="资产配置（树图）" subtitle="矩形面积 = 金额 · 模块内二级细分 · 点击下钻" loading={loading}>
              <LazyChart>
                <LazyTreemap
                  data={data.treemap.map((t) => ({ name: t.module, amount: t.amount, children: t.children.map((c) => ({ name: c.name, amount: c.amount })) }))}
                  palette={MODULE_PALETTE}
                  unit={unit}
                  height={320}
                  onItemClick={(p) => drillTreemapModule(p.name)}
                />
              </LazyChart>
            </ChartCard>

            {/* ⑤ 对比柱：目标 vs 实际收益率（月化口径，决策 D3） */}
            <ChartCard title="目标 vs 实际收益率（对比柱）" subtitle="目标=年化/12 月化（灰）；实际=环比/折算（模块色）；留空显示「—」" loading={loading}>
              <LazyChart>
                <LazyCompareBar
                  groups={data.gainCompare.map((g) => ({ module: g.module, targetRate: g.targetMonthlyRate, actualRate: g.actualRate }))}
                  palette={MODULE_PALETTE}
                  height={320}
                  blankLabel="—"
                  onItemClick={drillGainCompare}
                />
              </LazyChart>
            </ChartCard>
          </div>

          {/* 下钻面板 */}
          {drill && (
            <DrillPanel
              title={drill.kind === 'module' ? `${drill.module} · 明细` : drill.kind === 'gain' ? `${drill.module} · 收益率明细` : drill.title}
              columns={
                drill.kind === 'gain'
                  ? [{ key: 'name', title: '项目' }]
                  : [
                      { key: 'name', title: drill.kind === 'module' ? '科目' : '类别' },
                      { key: 'amount', title: '金额', align: 'right' },
                    ]
              }
              rows={drill.rows.map((r) => ({ name: r.name, amount: Number.isNaN(r.amount) ? '' : fmtMoney(r.amount, unit) }))}
              onClose={() => setDrill(null)}
              footer="点击图表同一元素或「收起 ✕」关闭面板"
            />
          )}

          {/* 折叠明细：收益率四态明细表 + 模块更新状态表（F-12） */}
          <CollapseDetail title={`模块收益率明细（四态：自动/折算/留空/不可折算，${data.gainCompare.length} 个模块）`}>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-slate-400">
                  <th className="py-1.5 font-medium">模块</th>
                  <th className="py-1.5 font-medium">状态</th>
                  <th className="py-1.5 text-right font-medium">目标（月化）</th>
                  <th className="py-1.5 text-right font-medium">实际</th>
                  <th className="py-1.5 text-right font-medium">收益金额</th>
                </tr>
              </thead>
              <tbody>
                {data.gainCompare.map((g) => (
                  <tr key={g.module} className="border-b border-slate-50 last:border-0">
                    <td className="py-1.5 text-slate-600">{g.module}</td>
                    <td className="py-1.5">
                      <ModeBadge mode={g.mode} />
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmtRate(g.targetMonthlyRate)}</td>
                    <td className="py-1.5 text-right tabular-nums">{g.actualRate === null ? '—' : fmtRate(g.actualRate)}</td>
                    <td className="py-1.5 text-right tabular-nums">{g.gain === null ? '—' : fmtMoney(g.gain, unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CollapseDetail>

          <CollapseDetail title={`模块更新状态明细表（F-12，${data.updateStatus.length} 项）`}>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-slate-400">
                  <th className="py-1.5 font-medium">资产</th>
                  <th className="py-1.5 font-medium">更新频率</th>
                  <th className="py-1.5 font-medium">本月状态</th>
                  <th className="py-1.5 text-right font-medium">上次更新月</th>
                </tr>
              </thead>
              <tbody>
                {data.updateStatus.map((u) => (
                  <tr key={u.nodeId} className="border-b border-slate-50 last:border-0">
                    <td className="py-1.5 text-slate-600">{u.name}</td>
                    <td className="py-1.5 text-slate-500">{FREQ_LABEL[u.freq] ?? u.freq}</td>
                    <td className="py-1.5">
                      {u.status === 'updated' ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600">● 本期已更新</span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">◌ 沿用上期</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{u.lastUpdatedMonth ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CollapseDetail>
        </>
      )}
    </div>
  );
}

const FREQ_LABEL: Record<string, string> = { monthly: '月度', quarterly: '季度', semiannual: '半年', annual: '年度', irregular: '不定期' };

function ModeBadge({ mode }: { mode: 'auto' | 'converted' | 'blank' | 'na' }) {
  const map = {
    auto: ['自动计算', 'bg-emerald-50 text-emerald-600'],
    converted: ['收益折算', 'bg-blue-50 text-blue-600'],
    blank: ['新增资金·留空', 'bg-slate-100 text-slate-500'],
    na: ['不可折算', 'bg-amber-50 text-amber-600'],
  } as const;
  const [label, cls] = map[mode];
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>;
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">资产报表</h2>
        <p className="mt-0.5 text-xs text-slate-400">投资表现视角 · 四图联动（趋势/配置/流向/收益率）</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function RangeSwitch({ range, setRange, year, setYear }: { range: TrendRange; setRange: (r: TrendRange) => void; year: number; setYear: (y: number) => void }) {
  const years = useMemo(() => {
    const cur = new Date().getFullYear();
    return [cur - 2, cur - 1, cur];
  }, []);
  return (
    <div className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-0.5">
      {(['12m', 'year', 'all'] as const).map((r) => (
        <button
          key={r}
          onClick={() => setRange(r)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${range === r ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-800'}`}
        >
          {r === '12m' ? '近12月' : r === 'year' ? '年度' : '全部'}
        </button>
      ))}
      {range === 'year' && (
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="ml-1 rounded-md border-slate-200 text-xs outline-none" aria-label="选择年度">
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
