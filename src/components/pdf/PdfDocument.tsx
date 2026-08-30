/**
 * PdfDocument — PDF 导出文档（@react-pdf/renderer 原生排版，04 §3.5 迁移定论）。
 * 导出态自动展开全部明细（F-11 规则 1）；包含三张表 + 关键指标 + 图表 + AI 记录（F-11 验收 1）。
 * 文本/表格全部用 react-pdf 原生元素重排（A4 多页自动分页）；ECharts 图表无法直接进
 * react-pdf：由 lib/pdf.ts 离屏渲染三张图表并采集 PNG dataURL，经 chartImages props 以 <Image> 嵌入。
 * 纯展示：数据来自 /api/pdf/payload（05 §3.32）；不含用户身份信息（meta.noPII）。
 */
import { Font, Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { registerPdfChineseFont } from '@shared/core/utils/pdfFont';
import type { AiSuggestion, PdfPayload } from '../../lib/types';
import { fmtMoney, fmtRate } from '../../lib/format';

// 中文字体本地化：fonts.gstatic.com 在部分网络不可达，远程 fetch 会导致 toBlob() 抛 Failed to fetch；
// 字体文件随 public/fonts/ 分发，注册逻辑沉淀在 @shared/core/utils/pdfFont
registerPdfChineseFont(Font, import.meta.env.BASE_URL);

/** 图表 PNG dataURL（离屏采集）：按 treemap/sankey/waterfall 键取用，可能部分不存在 */
export interface PdfChartImages {
  treemap?: string;
  sankey?: string;
  waterfall?: string;
}

/** 离屏图表渲染宽度（px）：沿用旧版文档内容区宽度，作为 PDF 内等比换算基准 */
export const OFFSCREEN_CHART_WIDTH = 656;
/** 各图离屏渲染高度（px）：与页面展示基线一致（260~280） */
export const OFFSCREEN_CHART_HEIGHTS = { treemap: 280, sankey: 280, waterfall: 260 } as const;

const PAGE_MARGIN = 36; // pt
/** A4 宽 595.28pt − 两侧页边距 */
const CONTENT_WIDTH = 595.28 - PAGE_MARGIN * 2;

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Noto Sans SC',
    fontSize: 10,
    color: '#334155',
    lineHeight: 1.6,
    paddingTop: PAGE_MARGIN,
    paddingBottom: 40,
    paddingHorizontal: PAGE_MARGIN,
  },
  header: { borderBottomWidth: 2, borderBottomColor: '#0f172a', paddingBottom: 10, marginBottom: 14 },
  title: { fontSize: 20, fontWeight: 700, color: '#0f172a', lineHeight: 1.3 },
  meta: { fontSize: 9, color: '#64748b', marginTop: 4 },
  kpiRow: { flexDirection: 'row', marginBottom: 6 },
  kpiCard: { flex: 1, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10 },
  kpiCardGap: { marginLeft: 6 },
  kpiLabel: { fontSize: 8, color: '#64748b' },
  kpiValue: { fontSize: 13, fontWeight: 700, color: '#0f172a', marginTop: 2 },
  section: { marginBottom: 12 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: '#0f172a', marginTop: 10, marginBottom: 6 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', paddingVertical: 4 },
  cellLabel: { width: '62%', paddingRight: 8, color: '#475569' },
  cellLabelStrong: { fontWeight: 700, color: '#0f172a' },
  cellValue: { width: '38%', textAlign: 'right', color: '#334155' },
  cellValueStrong: { fontWeight: 700, color: '#0f172a' },
  note: { fontSize: 8, color: '#94a3b8', marginTop: 4 },
  chartBlock: { marginBottom: 10 },
  chartImage: { width: '100%' },
  aiCard: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 6, padding: 10, marginBottom: 8 },
  aiCardTitle: { fontSize: 9, fontWeight: 700, color: '#334155', marginBottom: 6 },
  aiHeaderRow: { flexDirection: 'row', backgroundColor: '#f1f5f9' },
  aiHeaderCell: { fontWeight: 700, color: '#475569' },
  aiRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  aiCell: { fontSize: 8, paddingVertical: 3, paddingRight: 4, lineHeight: 1.4, color: '#334155' },
  footer: { marginTop: 14, borderTopWidth: 1, borderTopColor: '#e2e8f0', paddingTop: 8, fontSize: 8, color: '#94a3b8' },
});

function money(v: unknown): string {
  return typeof v === 'number' ? fmtMoney(v, 'yuan') : '—';
}

interface Row {
  label: string;
  value: string;
  strong?: boolean;
}

/** 两列表格（科目 + 右对齐金额；strong 行加粗；note 脚注） */
function Table({ title, rows, note }: { title: string; rows: Row[]; note?: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} wrap={false}>
        {title}
      </Text>
      {rows.map((r, i) => (
        <View key={i} style={styles.row} wrap={false}>
          <Text style={r.strong ? [styles.cellLabel, styles.cellLabelStrong] : styles.cellLabel}>{r.label}</Text>
          <Text style={r.strong ? [styles.cellValue, styles.cellValueStrong] : styles.cellValue}>{r.value}</Text>
        </View>
      ))}
      {note ? (
        <Text style={styles.note} wrap={false}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** 图表区块：标题 + 等比换算后的 PNG（离屏宽度 → PDF 内容宽度，保持宽高比） */
function ChartBlock({ title, src, pxHeight }: { title: string; src: string; pxHeight: number }) {
  const height = (CONTENT_WIDTH * pxHeight) / OFFSCREEN_CHART_WIDTH;
  return (
    <View style={styles.chartBlock} wrap={false}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Image src={src} style={[styles.chartImage, { height }]} />
    </View>
  );
}

/** AI 建议表列（与旧版表头一致：建议类型/目标模块/当前配置/建议方案/理由/优先级） */
const SUGGESTION_COLS = [
  { key: 'type', title: '建议类型', width: '11%' },
  { key: 'module', title: '目标模块', width: '11%' },
  { key: 'current', title: '当前配置', width: '20%' },
  { key: 'plan', title: '建议方案', width: '22%' },
  { key: 'reason', title: '理由', width: '26%' },
  { key: 'priority', title: '优先级', width: '10%' },
] as const;

export function PdfDocument({ payload, chartImages = {} }: { payload: PdfPayload; chartImages?: PdfChartImages }) {
  const st = payload.statements as {
    balanceSheet?: {
      kpi?: Record<string, number>;
      details?: { assets?: { name: string; amount: number }[]; debts?: { name: string; term: string; balance: number }[] };
    };
    incomeStatement?: {
      kpi?: Record<string, number>;
      details?: {
        income?: { cat: string; amount: number; children?: { cat: string; amount: number }[] }[];
        expense?: { cat: string; amount: number; children?: { cat: string; amount: number }[] }[];
      };
    };
    cashFlow?: {
      kpi?: Record<string, number>;
      waterfall?: { name: string; amount: number; type: string }[];
      details?: { name: string; formula: string; amount: number }[];
    } | null;
    notes?: Record<string, string>;
  };
  const kpis = payload.kpis ?? {};

  const bs = st.balanceSheet;
  const is = st.incomeStatement;
  const cf = st.cashFlow;

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
    const pushDir = (items?: { cat: string; amount: number; children?: { cat: string; amount: number }[] }[]) => {
      for (const top of items ?? []) {
        isRows.push({ label: top.cat, value: money(top.amount), strong: true });
        for (const c of top.children ?? []) isRows.push({ label: `　${c.cat}`, value: money(c.amount) });
      }
    };
    pushDir(is.details?.income);
    isRows.push({ label: '收入合计', value: money(is.kpi?.totalIncome), strong: true });
    pushDir(is.details?.expense);
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

  const kpiEntries = (Object.entries(kpis) as [string, number][]).filter(([, v]) => typeof v === 'number');
  // KPI 卡片每行 4 张
  const kpiRows: [string, number][][] = [];
  for (let i = 0; i < kpiEntries.length; i += 4) kpiRows.push(kpiEntries.slice(i, i + 4));

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* 标题与元信息 */}
        <View style={styles.header} wrap={false}>
          <Text style={styles.title}>{payload.title}</Text>
          <Text style={styles.meta}>
            生成时间 {payload.meta.generatedAt} · 单位：{payload.meta.unit} ·{' '}
            {payload.scope === 'month' ? `月份 ${payload.month}` : `报告 #${payload.reportId}`}
          </Text>
        </View>

        {/* 关键指标 */}
        {kpiRows.map((row, ri) => (
          <View key={ri} style={styles.kpiRow}>
            {row.map(([k, v], ci) => (
              <View key={k} style={ci > 0 ? [styles.kpiCard, styles.kpiCardGap] : styles.kpiCard}>
                <Text style={styles.kpiLabel}>{k}</Text>
                <Text style={styles.kpiValue}>{Math.abs(v) < 10 && !Number.isInteger(v) ? fmtRate(v, 4) : money(v)}</Text>
              </View>
            ))}
          </View>
        ))}

        {/* 图表：资产配置 + 资金流向 */}
        {chartImages.treemap && (
          <ChartBlock title="资产配置（树图）" src={chartImages.treemap} pxHeight={OFFSCREEN_CHART_HEIGHTS.treemap} />
        )}
        {chartImages.sankey && (
          <ChartBlock title="资金流向（桑基图，收入→支出+结余）" src={chartImages.sankey} pxHeight={OFFSCREEN_CHART_HEIGHTS.sankey} />
        )}

        {/* 三张表 */}
        {bsRows.length > 0 && <Table title="资产负债表" rows={bsRows} note={st.notes?.debtRatioNote} />}
        {isRows.length > 0 && <Table title="收支表" rows={isRows} />}
        {cf && (
          <>
            {chartImages.waterfall && (
              <ChartBlock title="现金变动（瀑布图）" src={chartImages.waterfall} pxHeight={OFFSCREEN_CHART_HEIGHTS.waterfall} />
            )}
            {cfRows.length > 0 && (
              <Table title="现金流量表" rows={cfRows} note="期初现金 + 净现金流 = 期末现金（含「估值与其他」平衡项，保证恒等）" />
            )}
          </>
        )}

        {/* AI 分析记录 */}
        {payload.aiRecords && payload.aiRecords.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle} wrap={false}>
              AI 分析记录（{payload.aiRecords.length}）
            </Text>
            {payload.aiRecords.map((r) => {
              const suggestions = r.payload?.suggestions ?? ([] as AiSuggestion[]);
              return (
                <View key={r.id} style={styles.aiCard}>
                  <Text style={styles.aiCardTitle} wrap={false}>
                    分析日期 {r.analysisDate} · 资产月份 {r.assetMonth ?? '—'}
                  </Text>
                  <View style={styles.aiHeaderRow} wrap={false}>
                    {SUGGESTION_COLS.map((c) => (
                      <Text key={c.key} style={[styles.aiCell, styles.aiHeaderCell, { width: c.width }]}>
                        {c.title}
                      </Text>
                    ))}
                  </View>
                  {suggestions.map((s, i) => (
                    <View key={i} style={styles.aiRow} wrap={false}>
                      {SUGGESTION_COLS.map((c) => (
                        <Text key={c.key} style={[styles.aiCell, { width: c.width }]}>
                          {s[c.key]}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        )}

        {/* 页脚免责说明 */}
        <View style={styles.footer} wrap={false}>
          <Text>本文件由系统自动生成，不含用户身份信息；金额单位为元，比率以小数/百分比表示。</Text>
        </View>
      </Page>
    </Document>
  );
}
