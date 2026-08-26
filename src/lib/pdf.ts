/**
 * PDF 导出（F-11 / 04 §3.5 定论 A：前端 html2canvas + jsPDF）。
 * - 数据来自 /api/pdf/payload（05 §3.32，只读账号可用，决策 D6）；
 * - 离屏渲染 PdfDocument（导出态全量展开明细，F-11 规则 1）→ html2canvas 截图 → jsPDF 分页；
 * - 文件名含月份/期间（F-11 规则 2）：财务报告-{YYYY-MM}.pdf / 定期报告-{标题}.pdf；
 * - html2canvas/jspdf 按需动态导入（不进首屏）；失败抛出原因由调用方展示并可重试（03 §5.2 UI-11）。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import type { PdfPayload } from './types';

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

  const [{ default: html2canvas }, { jsPDF }, { PdfDocument }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
    import('../components/pdf/PdfDocument'),
  ]);

  // 离屏容器（固定宽度，保证图表布局与清晰度）
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.zIndex = '-1';
  host.style.background = '#fff';
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    root.render(React.createElement(PdfDocument, { payload }));
    // 等待 React 渲染 + ECharts 初始化与动画收敛（组件 animationDuration 250ms）
    await new Promise((r) => setTimeout(r, 1200));

    const target = host.firstElementChild as HTMLElement | null;
    if (!target) throw new Error('PDF 渲染失败：文档为空');

    const canvas = await html2canvas(target, {
      scale: 2, // devicePixelRatio 采样，保证清晰（04 §3.5 配套决策）
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
    });

    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth(); // 210mm
    const pageHeight = pdf.internal.pageSize.getHeight(); // 297mm
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    const imgData = canvas.toDataURL('image/jpeg', 0.92);

    let heightLeft = imgHeight;
    let position = 0;
    pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while (heightLeft > 0) {
      position -= pageHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }

    const filename = pdfFilename(payload);
    pdf.save(filename);
    return filename;
  } finally {
    // 清理离屏渲染
    setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  }
}
