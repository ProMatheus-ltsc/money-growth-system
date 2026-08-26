/**
 * PdfDocument — PDF 导出的离屏渲染文档（04 §3.5 前端 html2canvas + jsPDF 方案）。
 * 导出态自动展开全部明细（F-11 规则 1）；包含三张表 + 关键指标 + 图表 + AI 记录（F-11 验收 1）。
 * 纯展示：数据来自 /api/pdf/payload（05 §3.32）；不含用户身份信息（meta.noPII）。
 */
import type { PdfPayload, AiSuggestion } from '../../lib/types';
import { fmtMoney, fmtRate } from '../../lib/format';
import { FinanceTreemap } from '@shared/core/components/visualize/finance/FinanceTreemap';
import { FinanceSankey } from '@shared/core/components/visualize/finance/FinanceSankey';
import { FinanceWaterfall } from '@shared/core/components/visualize/finance/FinanceWaterfall';
import { buildSankeyPaletteMap, MODULE_PALETTE } from '../charts/financeChartAdapter';

const P = 720; // 文档宽度（px），与 html2canvas 采样配合保证清晰

function money(v: unknown): string {
  return typeof v === 'number' ? fmtMoney(v, 'yuan') : '—';
}

interface Row {
  label: string;
  value: string;
  strong?: boolean;
}

function Table({ title, rows, note }: { title: string; rows: Row[]; note?: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', margin: '14px 0 8px' }}>{title}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
              <td style={{ padding: '6px 8px', color: '#475569', fontWeight: r.strong ? 700 : 400 }}>{r.label}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.strong ? '#0f172a' : '#334155', fontWeight: r.strong ? 700 : 400 }}>
                {r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>{note}</div>}
    </div>
  );
}

function ChartBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', margin: '14px 0 8px' }}>{title}</div>
      {children}
    </div>
  );
}

/** 由 sankey 数据包构造流带（收入→总收入→支出+结余） */
function sankeyFlowsOf(sankey: PdfPayload['charts'] extends never ? never : { income?: { cat: string; amount: number }[]; expense?: { cat: string; amount: number }[]; balance?: number } | undefined) {
  if (!sankey) return { flows: [] as { source: string; target: string; value: number }[], palette: {} as Record<string, string> };
  const flows: { source: string; target: string; value: number }[] = [];
  for (const i of sankey.income ?? []) if (i.amount > 0) flows.push({ source: i.cat, target: '总收入', value: i.amount });
  for (const e of sankey.expense ?? []) if (e.amount > 0) flows.push({ source: '总收入', target: e.cat, value: e.amount });
  if ((sankey.balance ?? 0) > 0) flows.push({ source: '总收入', target: '结余/净储蓄', value: sankey.balance! });
  const palette = buildSankeyPaletteMap((sankey.income ?? []).map((i) => i.cat), (sankey.expense ?? []).map((e) => e.cat));
  return { flows, palette };
}

export function PdfDocument({ payload }: { payload: PdfPayload }) {
  const st = payload.statements as Record<string, never> & {
    balanceSheet?: { kpi?: Record<string, number>; details?: { assets?: { name: string; amount: number }[]; debts?: { name: string; term: string; balance: number }[] } };
    incomeStatement?: { kpi?: Record<string, number>; details?: { income?: { cat: string; amount: number; children?: { cat: string; amount: number }[] }[]; expense?: { cat: string; amount: number; children?: { cat: string; amount: number }[] }[] } };
    cashFlow?: { kpi?: Record<string, number>; waterfall?: { name: string; amount: number; type: string }[]; details?: { name: string; formula: string; amount: number }[] } | null;
    notes?: Record<string, string>;
  };
  const charts = payload.charts as { treemap?: { module: string; amount: number; children?: { name: string; amount: number }[] }[]; sankey?: Parameters<typeof sankeyFlowsOf>[0] };
  const kpis = payload.kpis ?? {};

  const bs = st.balanceSheet;
  const is = st.incomeStatement;
  const cf = st.cashFlow;
  const sankey = sankeyFlowsOf(charts.sankey);

  // 三张表行
  const bsRows: Row[] = [];
  if (bs) {
    for (const a of bs.details?.assets ?? []) bsRows.push({ label: a.name, value: money(a.amount) });
    bsRows.push({ label: '资产总计', value: money(bs.kpi?.totalAssets), strong: true });
    for (const d of bs.details?.debts ?? []) bsRows.push({ label: `${d.name}（${d.term === 'short' ? '短期' : '长期'}）`, value: money(d.balance) });
    bsRows.push({ label: '负债总计', value: money(bs.kpi?.totalDebt), strong: true });
    bsRows.push({ label: '净资产（资产−负债）', value: money(bs.kpi?.netWorth), strong: true });
    bsRows.push({ label: '负债率', value: bs.kpi?.debtRatio != null ? fmtRate(bs.kpi.debtRatio, 4) : '—' });
  }
  const isRows: Row[] = [];
  if (is) {
    const pushDir = (label: string, items?: { cat: string; amount: number; children?: { cat: string; amount: number }[] }[]) => {
      for (const top of items ?? []) {
        isRows.push({ label: top.cat, value: money(top.amount), strong: true });
        for (const c of top.children ?? []) isRows.push({ label: `　${c.cat}`, value: money(c.amount) });
      }
    };
    pushDir('收入', is.details?.income);
    isRows.push({ label: '收入合计', value: money(is.kpi?.totalIncome), strong: true });
    pushDir('支出', is.details?.expense);
    isRows.push({ label: '支出合计', value: money(is.kpi?.totalExpense), strong: true });
    isRows.push({ label: '结余（收入−支出）', value: money(is.kpi?.balance), strong: true });
  }
  const cfRows: Row[] = [];
  if (cf) {
    cfRows.push({ label: '期初现金', value: money(cf.kpi?.openingCash) });
    for (const d of cf.details ?? []) cfRows.push({ label: d.name, value: money(d.amount) });
    cfRows.push({ label: '净现金流', value: money(cf.kpi?.netCashFlow), strong: true });
    cfRows.push({ label: '期末现金', value: money(cf.kpi?.closingCash), strong: true });
  }

  const kpiEntries = Object.entries(kpis).filter(([, v]) => typeof v === 'number');

  return (
    <div style={{ width: P, padding: 32, background: '#ffffff', color: '#0f172a', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>
      {/* 标题与元信息 */}
      <div style={{ borderBottom: '3px solid #0f172a', paddingBottom: 12, marginBottom: 18 }}>
        <div style={{ fontSize: 24, fontWeight: 800 }}>{payload.title}</div>
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
          生成时间 {payload.meta.generatedAt} · 单位：{payload.meta.unit} · {payload.scope === 'month' ? `月份 ${payload.month}` : `报告 #${payload.reportId}`}
        </div>
      </div>

      {/* 关键指标 */}
      {kpiEntries.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
          {kpiEntries.map(([k, v]) => (
            <div key={k} style={{ flex: '1 1 140px', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: '#64748b' }}>{k}</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                {typeof v === 'number' && Math.abs(v) < 10 && !Number.isInteger(v) ? fmtRate(v, 4) : money(v)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 图表：资产配置 + 资金流向 */}
      {charts.treemap && charts.treemap.length > 0 && (
        <ChartBlock title="资产配置（树图）">
          <FinanceTreemap
            data={charts.treemap.map((t) => ({ name: t.module, amount: t.amount, children: (t.children ?? []).map((c) => ({ name: c.name, amount: c.amount })) }))}
            palette={MODULE_PALETTE}
            unit="yuan"
            height={280}
          />
        </ChartBlock>
      )}
      {sankey.flows.length > 0 && (
        <ChartBlock title="资金流向（桑基图，收入→支出+结余）">
          <FinanceSankey flows={sankey.flows} paletteMap={sankey.palette} linkColorMode="source" unit="yuan" height={280} />
        </ChartBlock>
      )}

      {/* 三张表 */}
      {bsRows.length > 0 && <Table title="资产负债表" rows={bsRows} note={st.notes?.debtRatioNote} />}
      {isRows.length > 0 && <Table title="收支表" rows={isRows} />}
      {cf && (
        <>
          {cf.waterfall && cf.waterfall.length > 0 && (
            <ChartBlock title="现金变动（瀑布图）">
              <FinanceWaterfall
                openingTotal={cf.kpi?.openingCash ?? 0}
                items={(cf.waterfall ?? []).filter((w) => w.type === 'delta').map((w) => ({ label: w.name, delta: w.amount }))}
                closingTotal={cf.kpi?.closingCash}
                unit="yuan"
                height={260}
              />
            </ChartBlock>
          )}
          {cfRows.length > 0 && <Table title="现金流量表" rows={cfRows} note="期初现金 + 净现金流 = 期末现金（含「估值与其他」平衡项，保证恒等）" />}
        </>
      )}

      {/* AI 分析记录 */}
      {payload.aiRecords && payload.aiRecords.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', margin: '14px 0 8px' }}>AI 分析记录（{payload.aiRecords.length}）</div>
          {payload.aiRecords.map((r) => {
            const suggestions = (r.payload?.suggestions ?? []) as AiSuggestion[];
            return (
              <div key={r.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#334155', marginBottom: 6 }}>
                  分析日期 {r.analysisDate} · 资产月份 {r.assetMonth ?? '—'}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9' }}>
                      {['建议类型', '目标模块', '当前配置', '建议方案', '理由', '优先级'].map((h) => (
                        <th key={h} style={{ padding: '5px 6px', textAlign: 'left', color: '#475569', fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.map((s, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '5px 6px' }}>{s.type}</td>
                        <td style={{ padding: '5px 6px' }}>{s.module}</td>
                        <td style={{ padding: '5px 6px' }}>{s.current}</td>
                        <td style={{ padding: '5px 6px' }}>{s.plan}</td>
                        <td style={{ padding: '5px 6px' }}>{s.reason}</td>
                        <td style={{ padding: '5px 6px' }}>{s.priority}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 16, borderTop: '1px solid #e2e8f0', paddingTop: 8 }}>
        本文件由系统自动生成，不含用户身份信息；金额单位为元，比率以小数/百分比表示。
      </div>
    </div>
  );
}
