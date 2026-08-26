/**
 * 财务堆叠面积图（@shared/core 可复用财务图表，内部 ECharts 按需引入）。
 * 提取自家庭资产增长记录工具项目（2026-08）：各资产模块随时间堆积的总资产趋势。
 *
 * 视觉基线（消费方经参数注入）：
 * - 预期收益虚线 / 实际收益实线（`showTotalLines`，与预期线数据 `expected` 配套）；
 * - 终点标注（各模块序列末端显示模块名）；
 * - 十字线 hover 展示当月全部模块值（axisPointer: cross）；
 * - 点击任意月份联动：`onItemClick({ month })`。
 */
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { use } from 'echarts/core';
import {
  DEFAULT_FINANCE_PALETTE,
  formatFinanceAmount,
  useFinanceChart,
  type FinanceChartBaseProps,
} from './financeChartShared';

use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, LegendComponent]);

export interface FinanceStackedAreaSeriesPoint {
  month: string;
  /** 金额（元） */
  amount: number;
}

export interface FinanceStackedAreaSeries {
  /** 顶层模块名 */
  module: string;
  points: FinanceStackedAreaSeriesPoint[];
}

export interface FinanceStackedAreaProps extends FinanceChartBaseProps {
  /** 横轴月份（YYYY-MM，升序） */
  months: string[];
  /** 各模块金额序列（按出现顺序堆积） */
  series: FinanceStackedAreaSeries[];
  /** 各月实际总值（实线；缺省不绘制） */
  actual?: number[];
  /** 各月预期总值（虚线；与预期/实际开关配套，缺省不绘制） */
  expected?: number[];
  /** 预期虚线/实际实线开关（缺省开启；关闭则仅堆叠面积） */
  showTotalLines?: boolean;
  /** 点击月份联动（下钻/切换由消费方接线） */
  onItemClick?: (payload: { month: string }) => void;
}

/**
 * 财务堆叠面积图组件。
 * 纯展示：数据经 props 传入，组件内无数据获取；外观经 `palette`/`unit` 注入。
 */
export function FinanceStackedArea({
  months,
  series,
  actual,
  expected,
  showTotalLines = true,
  palette,
  unit = 'yuan',
  devicePixelRatio = 2,
  height = 320,
  className,
  onItemClick,
}: FinanceStackedAreaProps) {
  const colors = palette ?? DEFAULT_FINANCE_PALETTE;

  const buildOption = (): Record<string, unknown> => {
    const stackSeries = series.map((s, i) => {
      const byMonth = new Map(s.points.map((p) => [p.month, p.amount]));
      const values = months.map((m) => byMonth.get(m) ?? 0);
      return {
        name: s.module,
        type: 'line',
        stack: 'finance-total',
        symbol: 'none',
        lineStyle: { width: 1.5 },
        areaStyle: { opacity: 0.85 },
        emphasis: { focus: 'series' },
        data: values,
        // 终点标注：序列末端显示模块名（重叠自动隐藏）
        endLabel: {
          show: true,
          formatter: s.module,
          fontSize: 11,
          color: colors[i % colors.length],
          offset: [4, 0],
        },
        labelLayout: { hideOverlap: true },
      };
    });

    const totalSeries: Record<string, unknown>[] = [];
    if (showTotalLines && actual) {
      totalSeries.push({
        name: '实际总值',
        type: 'line',
        symbol: 'none',
        lineStyle: { width: 2.5, type: 'solid' },
        data: actual,
        z: 10,
      });
    }
    if (showTotalLines && expected) {
      totalSeries.push({
        name: '预期总值',
        type: 'line',
        symbol: 'none',
        lineStyle: { width: 2, type: 'dashed' },
        data: expected,
        z: 9,
      });
    }

    return {
      color: colors,
      animationDuration: 600,
      animationEasing: 'cubicOut',
      grid: { left: 8, right: 60, top: 12, bottom: 48, containLabel: true },
      legend: {
        show: true,
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
        axisPointer: { type: 'cross', label: { backgroundColor: '#475569' } },
        valueFormatter: (v: unknown) => formatFinanceAmount(Number(v ?? 0), unit),
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#334155', fontSize: 12 },
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: months,
        axisLine: { lineStyle: { color: '#e2e8f0' } },
        axisLabel: { color: '#64748b', fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: (v: number) => formatFinanceAmount(v, unit), color: '#64748b', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [...stackSeries, ...totalSeries],
    };
  };

  const containerRef = useFinanceChart(
    buildOption,
    [months, series, actual, expected, showTotalLines, colors, unit],
    (params) => {
      const p = params as { name?: string };
      if (p.name && onItemClick) onItemClick({ month: p.name });
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

export default FinanceStackedArea;
