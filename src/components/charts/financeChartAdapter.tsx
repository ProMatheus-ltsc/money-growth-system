/**
 * financeChartAdapter — shared-core finance 图表薄适配层（04 §6.2 / 06 T21）：
 * ① 主题/色板映射：02-demo-notes 的 7+1 色分类色板、流向色（流入彩色/绿、流出灰、减少红）
 *    经组件 `palette`/`paletteMap`/`colors` props 注入；
 * ② `onItemClick` 下钻事件由页面接至 DrillPanel + UiContext 月份联动；
 * ③ 单位换算：元/万元取 UiContext（仅展示层）。
 * ECharts 实例生命周期封装在 shared-core finance 组件内部，本层不直接触碰 echarts API。
 */
import React, { lazy, Suspense } from 'react';
import { useUi } from '../../context/UiContext';

// ---- ② 02-demo-notes 色板（CVD/对比度校验，固定顺序不循环） ----

/** 模块分类色板（CVD友好，相邻色ΔE≥15，冷暖交替） */
export const MODULE_PALETTE = [
  '#3182ce',
  '#e53e3e',
  '#38a169',
  '#d69e2e',
  '#805ad5',
  '#dd6b20',
  '#319795',
  '#e53e3e',
];

/** 收入类别色板（CVD友好，5色） */
export const INCOME_PALETTE = ['#3182ce', '#38a169', '#d69e2e', '#805ad5', '#dd6b20'];

/** 支出类别色板（暖色系，与收入色板区分） */
export const EXPENSE_PALETTE = ['#e53e3e', '#d69e2e', '#dd6b20', '#b83280', '#718096', '#975a16', '#2b6cb0'];

/** 流向色（02 视觉基线）：流入/结余 绿、流出 灰、减少 红 */
export const FLOW_COLORS = {
  in: '#10b981',
  out: '#94a3b8',
  dec: '#ef4444',
};

/** 负债期限色：短期琥珀 / 长期蓝（02-demo-notes ⑥） */
export const TERM_COLORS = { short: '#f59e0b', long: '#3b82f6' };

/**
 * 桑基流向配色映射：收入类别彩色（INCOME_PALETTE 顺序）、
 * 支出类别各自独立颜色（EXPENSE_PALETTE 顺序）、「总收入」深墨、「结余/净储蓄」绿。
 */
export function buildSankeyPaletteMap(incomeCats: string[], expenseCats: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  incomeCats.forEach((c, i) => {
    map[c] = INCOME_PALETTE[i % INCOME_PALETTE.length];
  });
  expenseCats.forEach((c, i) => {
    map[c] = EXPENSE_PALETTE[i % EXPENSE_PALETTE.length];
  });
  map['总收入'] = '#334155';
  map['结余/净储蓄'] = FLOW_COLORS.in;
  return map;
}

// ---- ① 懒加载六类财务图表（04 §8.1：报表页图表懒加载，控制首屏体积） ----

export const LazyStackedArea = lazy(() => import('@shared/core/components/visualize/finance/FinanceStackedArea'));
export const LazyTreemap = lazy(() => import('@shared/core/components/visualize/finance/FinanceTreemap'));
export const LazySankey = lazy(() => import('@shared/core/components/visualize/finance/FinanceSankey'));
export const LazyWaterfall = lazy(() => import('@shared/core/components/visualize/finance/FinanceWaterfall'));
export const LazyCompareBar = lazy(() => import('@shared/core/components/visualize/finance/FinanceCompareBar'));
export const LazyDonut = lazy(() => import('@shared/core/components/visualize/finance/FinanceDonut'));

export function ChartFallback() {
  return <div className="flex h-[320px] items-center justify-center text-sm text-slate-400">图表加载中…</div>;
}

/** 懒加载包装（图表加载失败时由 ChartCard 捕获并提供重试） */
export function LazyChart({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<ChartFallback />}>{children}</Suspense>;
}

// ---- ③ 图表通用外观（单位联动） ----

export function useChartUnit(): { unit: 'yuan' | 'wanyuan' } {
  const { unit } = useUi();
  return { unit };
}
