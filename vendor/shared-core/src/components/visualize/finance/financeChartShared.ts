/**
 * finance 图表组件族共享基座（@shared/core 可复用财务图表，内部 ECharts 按需引入）。
 * 提取自家庭资产增长记录工具项目（2026-08）。
 *
 * 设计基线（纯展示 + 业务语义参数化）：
 * - 组件内无数据获取、无网络请求；数据为财务语义类型化 props；
 * - 外观可注入：`palette`（缺省中性色板，消费方注入主题）、`unit`（元/万元仅展示换算）、
 *   `devicePixelRatio`（默认 2，canvas 渲染器，保证 PDF 截图清晰度）；
 * - 交互外露：统一 `onItemClick?(payload)` 供消费方接线钻取。
 *
 * 注意：主入口（@shared/core）不导出本目录组件——`echarts` 为 optional peerDependency，
 * 仅经子路径 `@shared/core/components/visualize/finance/<Component>` 导入。
 */
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';

/** 缺省中性色板（消费方经 palette 注入各自视觉基线） */
export const DEFAULT_FINANCE_PALETTE = [
  '#6366f1',
  '#22c55e',
  '#f59e05',
  '#06b6d4',
  '#ec4899',
  '#8b5cf6',
  '#84cc16',
  '#f97316',
];

/** finance 图表通用外观/交互参数 */
export interface FinanceChartBaseProps {
  /** 分类色板（缺省中性；消费方注入主题色） */
  palette?: string[];
  /** 金额展示单位：'yuan' 元（缺省）/ 'wanyuan' 万元；仅展示层换算，数据一律按元传入 */
  unit?: 'yuan' | 'wanyuan';
  /** canvas 分辨率倍数（缺省 2，兼顾移动端清晰与 PDF 导出） */
  devicePixelRatio?: number;
  /** 图表高度（px，缺省 320） */
  height?: number;
  /** 附加容器 class */
  className?: string;
}

/** 金额展示格式化（千分位；万元保留 2 位小数） */
export function formatFinanceAmount(value: number, unit: 'yuan' | 'wanyuan' = 'yuan'): string {
  if (unit === 'wanyuan') {
    return `${(value / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}万`;
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/** 比率展示（小数 → 百分比） */
export function formatFinanceRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(2)}%`;
}

export type FinanceChartInstance = echarts.EChartsType;

/**
 * ECharts 生命周期封装：init（canvas 渲染器）→ setOption → resize（ResizeObserver）→ dispose。
 * 系列/组件的按需注册（use([...])）由各组件文件在模块顶层声明。
 * @param buildOption 依据最新 props 构造 option（notMerge 全量替换）
 * @param optionDeps buildOption 的依赖（数据/外观 props）
 * @param onClick 点击事件（参数为 echarts 回调参数，组件内映射为业务 payload）
 */
export function useFinanceChart(
  buildOption: () => Record<string, unknown>,
  optionDeps: unknown[],
  onClick?: (params: unknown) => void,
  devicePixelRatio = 2
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<FinanceChartInstance | null>(null);
  const clickRef = useRef<typeof onClick>(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas', devicePixelRatio });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => {
      if (!chart.isDisposed()) chart.resize();
    });
    observer.observe(el);
    chart.on('click', (params) => {
      clickRef.current?.(params);
    });
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [devicePixelRatio]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed()) return;
    chart.setOption(buildOption(), { notMerge: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...optionDeps, devicePixelRatio]);

  return containerRef;
}
