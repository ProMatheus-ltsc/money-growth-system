/**
 * PDF 导出（F-11 / 04 §3.5 定论：@react-pdf/renderer 原生排版）。
 * - 数据来自 /api/pdf/payload（05 §3.32，只读账号可用，决策 D6）；
 * - ECharts 图表无法直接进 react-pdf：先离屏渲染三张图表（createRoot + 等待动画收敛），
 *   再经 echarts.getInstanceByDom().getDataURL() 采集 PNG dataURL，以 <Image> 嵌入文档；
 * - pdf(<PdfDocument/>).toBlob() → 临时 <a download> 下载；
 * - 文件名含月份/期间（F-11 规则 2）：财务报告-{YYYY-MM}.pdf / 定期报告-{标题}.pdf；
 * - react-pdf / 图表组件按需动态导入（不进首屏）；失败抛出原因由调用方展示并可重试（03 §5.2 UI-11）。
 */
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import type { PdfPayload } from './types';
import type { PdfChartImages } from '../components/pdf/PdfDocument';

export function pdfFilename(payload: PdfPayload): string {
  if (payload.scope === 'month') return `财务报告-${payload.month}.pdf`;
  // 定期报告：标题形如「2026Q2 季报」，含类型与期间，满足归档要求
  const safe = payload.title.replace(/[\\/:*?"<>|\s]+/g, '-');
  return `定期报告-${safe}.pdf`;
}

/** 生成并下载 PDF；返回文件名。失败抛出 Error（含原因）。 */
export async function exportPdf(scope: 'month' | 'report', params: { month?: string; id?: number }): Promise<string> {
  const payload = await api<PdfPayload>('/api/pdf/payload', {
    query: { scope, month: params.month, id: params.id },
  });

  const [{ pdf }, { PdfDocument }, chartImages] = await Promise.all([
    import('@react-pdf/renderer'),
    import('../components/pdf/PdfDocument'),
    captureChartImages(payload),
  ]);

  // react-pdf 的 pdf() 形参按 DocumentProps 声明（全可选属性），与业务 props 无公共字段，
  // 故按文档根元素的实际类型断言后传入
  const documentElement = createElement(PdfDocument, { payload, chartImages }) as ReactElement<
    import('@react-pdf/renderer').DocumentProps
  >;
  const blob = await pdf(documentElement).toBlob();
  const filename = pdfFilename(payload);
  downloadPdfBlob(blob, filename);
  return filename;
}

/** 触发浏览器下载：临时 <a download>，发起后回收 blob URL */
function downloadPdfBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 离屏渲染三张 ECharts 图表并采集 PNG dataURL（treemap/sankey/waterfall，可能部分不存在）。
 * ECharts 初始化过的元素带 _echarts_instance_ 属性：按渲染顺序遍历这些容器，
 * getDataURL({ pixelRatio: 2 }) 导出 PNG，采集完成后卸载并移除离屏 host。
 */
async function captureChartImages(payload: PdfPayload): Promise<PdfChartImages> {
  const st = payload.statements as {
    cashFlow?: { kpi?: Record<string, number>; waterfall?: { name: string; amount: number; type: string }[] } | null;
  };
  const charts = payload.charts as {
    treemap?: { module: string; amount: number; children?: { name: string; amount: number }[] }[];
    sankey?: { income?: { cat: string; amount: number }[]; expense?: { cat: string; amount: number }[]; balance?: number };
  };

  // 与页面展示一致的图表参数（02 视觉基线）
  const treemapData = charts.treemap?.length
    ? charts.treemap.map((t) => ({ name: t.module, amount: t.amount, children: (t.children ?? []).map((c) => ({ name: c.name, amount: c.amount })) }))
    : undefined;
  const sankeyFlows: { source: string; target: string; value: number }[] = [];
  if (charts.sankey) {
    for (const i of charts.sankey.income ?? []) if (i.amount > 0) sankeyFlows.push({ source: i.cat, target: '总收入', value: i.amount });
    for (const e of charts.sankey.expense ?? []) if (e.amount > 0) sankeyFlows.push({ source: '总收入', target: e.cat, value: e.amount });
    if ((charts.sankey.balance ?? 0) > 0) sankeyFlows.push({ source: '总收入', target: '结余/净储蓄', value: charts.sankey.balance! });
  }
  const waterfallItems = (st.cashFlow?.waterfall ?? []).filter((w) => w.type === 'delta').map((w) => ({ label: w.name, delta: w.amount }));

  if (!treemapData && sankeyFlows.length === 0 && waterfallItems.length === 0) return {};

  const [{ FinanceTreemap }, { FinanceSankey }, { FinanceWaterfall }, { buildSankeyPaletteMap, MODULE_PALETTE }, { getInstanceByDom }, { OFFSCREEN_CHART_WIDTH, OFFSCREEN_CHART_HEIGHTS }] =
    await Promise.all([
      import('@shared/core/components/visualize/finance/FinanceTreemap'),
      import('@shared/core/components/visualize/finance/FinanceSankey'),
      import('@shared/core/components/visualize/finance/FinanceWaterfall'),
      import('../components/charts/financeChartAdapter'),
      import('echarts/core'),
      import('../components/pdf/PdfDocument'),
    ]);

  // 离屏容器（固定宽度，保证图表布局与清晰度）
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.zIndex = '-1';
  host.style.background = '#fff';
  host.style.width = `${OFFSCREEN_CHART_WIDTH}px`;
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    // 渲染顺序 = 采集顺序：treemap → sankey → waterfall（缺失的图不渲染、不占位）
    const rendered: ('treemap' | 'sankey' | 'waterfall')[] = [];
    const children: ReactElement[] = [];
    if (treemapData) {
      rendered.push('treemap');
      children.push(
        createElement(FinanceTreemap, { data: treemapData, palette: MODULE_PALETTE, unit: 'yuan', height: OFFSCREEN_CHART_HEIGHTS.treemap })
      );
    }
    if (sankeyFlows.length > 0) {
      rendered.push('sankey');
      children.push(
        createElement(FinanceSankey, {
          flows: sankeyFlows,
          paletteMap: buildSankeyPaletteMap((charts.sankey?.income ?? []).map((i) => i.cat), (charts.sankey?.expense ?? []).map((e) => e.cat)),
          linkColorMode: 'source',
          unit: 'yuan',
          height: OFFSCREEN_CHART_HEIGHTS.sankey,
        })
      );
    }
    if (waterfallItems.length > 0) {
      rendered.push('waterfall');
      children.push(
        createElement(FinanceWaterfall, {
          openingTotal: st.cashFlow?.kpi?.openingCash ?? 0,
          items: waterfallItems,
          closingTotal: st.cashFlow?.kpi?.closingCash,
          unit: 'yuan',
          height: OFFSCREEN_CHART_HEIGHTS.waterfall,
        })
      );
    }
    root.render(createElement('div', null, ...children));

    // 等待 React 渲染 + ECharts 初始化与动画收敛（组件 animationDuration 600ms）
    await new Promise((r) => setTimeout(r, 1200));

    // 遍历离屏容器内 ECharts 初始化过的 DOM（带 _echarts_instance_ 属性），按序导出 PNG dataURL
    const images: PdfChartImages = {};
    Array.from(host.querySelectorAll('[_echarts_instance_]')).forEach((el, i) => {
      const key = rendered[i];
      if (!key) return;
      const dataUrl = getInstanceByDom(el as HTMLElement)?.getDataURL({ pixelRatio: 2, backgroundColor: '#fff' });
      if (dataUrl) images[key] = dataUrl;
    });
    return images;
  } finally {
    // 清理离屏渲染
    setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  }
}
