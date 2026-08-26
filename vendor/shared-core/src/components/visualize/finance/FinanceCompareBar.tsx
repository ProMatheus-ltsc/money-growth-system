/**
 * 财务对比柱状图（@shared/core 可复用财务图表，内部 ECharts 按需引入）。
 * 提取自家庭资产增长记录工具项目（2026-08）：各模块目标收益率（月化，灰）
 * vs 实际收益率（模块色，环比）的并排对比。
 *
 * 视觉基线：目标柱固定灰色；实际柱按模块色板；缺值（留空/不可折算）显示占位符
 * （`blankLabel`，缺省「—」）；点击实际收益柱下钻模块明细（`onItemClick`）。
 * 收益率以小数传入（0.035 = 3.5%），展示层自动换算百分比。
 */
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, MarkLineComponent } from 'echarts/components';
import { use } from 'echarts/core';
import {
  DEFAULT_FINANCE_PALETTE,
  formatFinanceRate,
  useFinanceChart,
  type FinanceChartBaseProps,
} from './financeChartShared';

use([CanvasRenderer, BarChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent]);

export interface FinanceCompareBarGroup {
  /** 模块名 */
  module: string;
  /** 目标收益率（月化，小数；可空=未设目标） */
  targetRate: number | null;
  /** 实际收益率（小数；可空=留空/不可折算，显示占位符） */
  actualRate: number | null;
}

export interface FinanceCompareBarProps extends FinanceChartBaseProps {
  groups: FinanceCompareBarGroup[];
  /** 目标柱颜色（缺省灰） */
  targetColor?: string;
  /** 缺值占位符（缺省「—」） */
  blankLabel?: string;
  /** 点击实际收益柱（下钻模块明细由消费方接线） */
  onItemClick?: (payload: { module: string; actualRate: number | null; targetRate: number | null }) => void;
}

/**
 * 财务对比柱状图组件。纯展示：数据经 props 传入；外观经 `palette`/`targetColor` 注入。
 */
export function FinanceCompareBar({
  groups,
  targetColor = '#94a3b8',
  blankLabel = '—',
  palette,
  devicePixelRatio = 2,
  height = 320,
  className,
  onItemClick,
}: FinanceCompareBarProps) {
  const colors = palette ?? DEFAULT_FINANCE_PALETTE;

  const buildOption = (): Record<string, unknown> => {
    const modules = groups.map((g) => g.module);
    const targets = groups.map((g) => (g.targetRate === null ? null : g.targetRate));
    const actuals = groups.map((g, i) => ({
      value: g.actualRate,
      itemStyle: { color: colors[i % colors.length] },
      // 缺值占位符：无柱时在轴上标注
      label: {
        show: g.actualRate === null,
        position: 'top',
        formatter: blankLabel,
        color: '#94a3b8',
        fontSize: 12,
      },
    }));

    return {
      animationDuration: 600,
      animationEasing: 'cubicOut',
      grid: { left: 8, right: 16, top: 12, bottom: 48, containLabel: true },
      legend: {
        bottom: 0,
        left: 'center',
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 8,
        itemGap: 16,
        textStyle: { fontSize: 11, color: '#64748b' },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#334155', fontSize: 12 },
        formatter: (infos: unknown) => {
          const arr = infos as { dataIndex: number; seriesName: string }[];
          const idx = arr[0]?.dataIndex ?? 0;
          const g = groups[idx];
          if (!g) return '';
          return [
            `<b>${g.module}</b>`,
            `目标（月化）：${formatFinanceRate(g.targetRate)}`,
            `实际（环比）：${g.actualRate === null ? blankLabel : formatFinanceRate(g.actualRate)}`,
          ].join('<br/>');
        },
      },
      xAxis: {
        type: 'category',
        data: modules,
        axisLabel: { interval: 0, fontSize: 11, width: 72, overflow: 'truncate', color: '#64748b' },
        axisLine: { lineStyle: { color: '#e2e8f0' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(1)}%`, color: '#64748b', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [
        {
          name: '目标收益率（月化）',
          type: 'bar',
          barGap: '10%',
          barWidth: '28%',
          itemStyle: { color: targetColor },
          data: targets,
        },
        {
          name: '实际收益率（环比）',
          type: 'bar',
          barWidth: '28%',
          data: actuals,
          // 0 轴参考线（收益率可负）
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: '#cbd5e1', type: 'solid', width: 1 },
            label: { show: false },
            data: [{ yAxis: 0 }],
          },
        },
      ],
    };
  };

  const containerRef = useFinanceChart(
    buildOption,
    [groups, colors, targetColor, blankLabel],
    (params) => {
      const p = params as { seriesName?: string; dataIndex?: number };
      if (!onItemClick || p.dataIndex === undefined) return;
      // 仅「实际收益率」柱触发下钻
      if (p.seriesName && !p.seriesName.includes('实际')) return;
      const g = groups[p.dataIndex];
      if (g) onItemClick({ module: g.module, actualRate: g.actualRate, targetRate: g.targetRate });
    },
    devicePixelRatio
  );

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height, cursor: onItemClick ? 'pointer' : 'default' }}
    />
  );
}

export default FinanceCompareBar;
