/**
 * 财务环形图（@shared/core 可复用财务图表，内部 ECharts 按需引入）。
 * 提取自家庭资产增长记录工具项目（2026-08）：构成占比（如负债结构：短期/长期）。
 *
 * 视觉基线：环心显示总量与标签（`centerValue`/`centerLabel`）；hover 金额+占比；
 * 扇区配色经 `palette` 或逐片 `color` 注入（如 短期=琥珀 / 长期=蓝）；
 * 点击扇区下钻条目明细（`onItemClick`）。
 */
import { CanvasRenderer } from 'echarts/renderers';
import { PieChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent } from 'echarts/components';
import { use } from 'echarts/core';
import {
  DEFAULT_FINANCE_PALETTE,
  formatFinanceAmount,
  useFinanceChart,
  type FinanceChartBaseProps,
} from './financeChartShared';

use([CanvasRenderer, PieChart, TooltipComponent, LegendComponent]);

export interface FinanceDonutSlice {
  name: string;
  /** 金额（元） */
  value: number;
  /** 逐片配色（优先于色板） */
  color?: string;
}

export interface FinanceDonutProps extends FinanceChartBaseProps {
  slices: FinanceDonutSlice[];
  /** 环心主数值（如总负债；缺省显示总和） */
  centerValue?: string;
  /** 环心标签（如「期末总负债」） */
  centerLabel?: string;
  /** 点击扇区下钻（条目明细由消费方提供） */
  onItemClick?: (payload: { name: string; value: number; percent: number }) => void;
}

/**
 * 财务环形图组件。纯展示：数据经 props 传入；外观经 `palette`/`unit` 注入。
 */
export function FinanceDonut({
  slices,
  centerValue,
  centerLabel,
  palette,
  unit = 'yuan',
  devicePixelRatio = 2,
  height = 320,
  className,
  onItemClick,
}: FinanceDonutProps) {
  const colors = palette ?? DEFAULT_FINANCE_PALETTE;
  const total = slices.reduce((s, x) => s + x.value, 0);

  const buildOption = (): Record<string, unknown> => ({
    color: colors,
    animationDuration: 600,
    animationEasing: 'cubicOut',
    tooltip: {
      backgroundColor: '#fff',
      borderColor: '#e2e8f0',
      borderWidth: 1,
      textStyle: { color: '#1e293b', fontSize: 13 },
      formatter: (p: unknown) => {
        const info = p as { name: string; value: number; percent: number };
        return `${info.name}<br/>${formatFinanceAmount(info.value, unit)}（${info.percent.toFixed(1)}%）`;
      },
    },
    legend: { bottom: 0, icon: 'circle', itemWidth: 10, textStyle: { color: '#64748b' } },
    title: {
      text: centerValue ?? formatFinanceAmount(total, unit),
      subtext: centerLabel ?? '',
      left: 'center',
      top: '38%',
      textStyle: { fontSize: 20, fontWeight: 600, color: '#0f172a' },
      subtextStyle: { fontSize: 12, color: '#64748b' },
    },
    series: [
      {
        type: 'pie',
        radius: ['52%', '72%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { show: false },
        emphasis: {
          label: { show: true, fontSize: 13, fontWeight: 'bold', formatter: '{b}' },
          scaleSize: 4,
        },
        data: slices.map((s, i) => ({
          name: s.name,
          value: s.value,
          itemStyle: { color: s.color ?? colors[i % colors.length] },
        })),
      },
    ],
  });

  const containerRef = useFinanceChart(
    buildOption,
    [slices, centerValue, centerLabel, colors, unit],
    (params) => {
      const p = params as { name?: string; value?: number; percent?: number };
      if (p.name && onItemClick) {
        onItemClick({ name: p.name, value: Number(p.value ?? 0), percent: Number(p.percent ?? 0) });
      }
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

export default FinanceDonut;
