/**
 * 财务瀑布图（@shared/core 可复用财务图表，内部 ECharts 按需引入）。
 * 提取自家庭资产增长记录工具项目（2026-08）：期初 → ±构成项 → 期末 的资金/净资产变动。
 *
 * 视觉基线：增量绿 / 减项红 / 首末项墨色；虚线连接器；支持负值基线（净资产为负场景）；
 * 逐项 hover 说明；点击柱段下钻构成说明（`onItemClick`）。
 */
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { use } from 'echarts/core';
import {
  formatFinanceAmount,
  useFinanceChart,
  type FinanceChartBaseProps,
} from './financeChartShared';

use([CanvasRenderer, BarChart, GridComponent, TooltipComponent]);

export interface FinanceWaterfallItem {
  /** 构成项名称（如「当期结余」「负债净变动」） */
  label: string;
  /** 变动金额（元，可正可负） */
  delta: number;
}

export interface FinanceWaterfallProps extends FinanceChartBaseProps {
  /** 期初合计（元） */
  openingTotal: number;
  /** 构成项序列（按期初 → 期末顺序） */
  items: FinanceWaterfallItem[];
  /** 期末合计（元）；缺省按期初 + Σdelta 计算 */
  closingTotal?: number;
  /** 配色：增量/减项/首末项（缺省 绿/红/墨） */
  colors?: { increase?: string; decrease?: string; total?: string };
  /** 点击柱段下钻（构成说明由消费方提供） */
  onItemClick?: (payload: { label: string; delta: number; kind: 'start' | 'delta' | 'end' }) => void;
}

const DEFAULT_COLORS = { increase: '#10b981', decrease: '#ef4444', total: '#334155' };

/**
 * 财务瀑布图组件。纯展示：数据经 props 传入；外观经 `colors`/`unit` 注入。
 */
export function FinanceWaterfall({
  openingTotal,
  items,
  closingTotal,
  colors,
  unit = 'yuan',
  devicePixelRatio = 2,
  height = 320,
  className,
  onItemClick,
}: FinanceWaterfallProps) {
  const c = { ...DEFAULT_COLORS, ...(colors ?? {}) };

  const buildOption = (): Record<string, unknown> => {
    const labels = ['期初', ...items.map((i) => i.label), '期末'];
    const closing = closingTotal ?? openingTotal + items.reduce((s, i) => s + i.delta, 0);

    // 透明占位：把增量柱抬到正确的基线（支持负值基线）
    const placeholders: number[] = [0];
    const visible: number[] = [openingTotal];
    const visibleColors: string[] = [c.total];
    let running = openingTotal;
    for (const item of items) {
      const next = running + item.delta;
      placeholders.push(Math.min(running, next));
      visible.push(Math.abs(item.delta));
      visibleColors.push(item.delta >= 0 ? c.increase : c.decrease);
      running = next;
    }
    placeholders.push(0);
    visible.push(closing);
    visibleColors.push(c.total);

    // 虚线连接器：每段增量结束后的高度延伸到下一柱
    const connectorLevels: number[] = [];
    let level = openingTotal;
    for (const item of items) {
      level += item.delta;
      connectorLevels.push(level);
    }
    const markLineData = connectorLevels.map((lv, i) => [
      { xAxis: i + 1, yAxis: lv },
      { xAxis: i + 2, yAxis: lv },
    ]);

    return {
      animationDuration: 600,
      animationEasing: 'cubicOut',
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: '#fff',
        borderColor: '#e2e8f0',
        borderWidth: 1,
        textStyle: { color: '#1e293b', fontSize: 13 },
        formatter: (infos: unknown) => {
          const arr = infos as { dataIndex: number }[];
          const idx = arr[0]?.dataIndex ?? 0;
          if (idx === 0) return `期初：${formatFinanceAmount(openingTotal, unit)}`;
          if (idx === labels.length - 1) return `期末：${formatFinanceAmount(closing, unit)}`;
          const item = items[idx - 1];
          const sign = item.delta >= 0 ? '+' : '';
          return `${item.label}：${sign}${formatFinanceAmount(item.delta, unit)}`;
        },
      },
      xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, fontSize: 11, color: '#64748b' } },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: (v: number) => formatFinanceAmount(v, unit), color: '#64748b' },
        splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' } },
      },
      series: [
        {
          name: '占位',
          type: 'bar',
          stack: 'waterfall',
          itemStyle: { borderColor: 'transparent', color: 'transparent' },
          emphasis: { itemStyle: { borderColor: 'transparent', color: 'transparent' } },
          tooltip: { show: false },
          data: placeholders,
        },
        {
          name: '变动',
          type: 'bar',
          stack: 'waterfall',
          barWidth: '45%',
          data: visible.map((v, i) => ({ value: v, itemStyle: { color: visibleColors[i] } })),
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { type: 'dashed', color: '#94a3b8', width: 1 },
            label: { show: false },
            data: markLineData,
          },
        },
      ],
    };
  };

  const containerRef = useFinanceChart(
    buildOption,
    [openingTotal, items, closingTotal, c.increase, c.decrease, c.total, unit],
    (params) => {
      const p = params as { dataIndex?: number };
      if (!onItemClick || p.dataIndex === undefined) return;
      const idx = p.dataIndex;
      if (idx === 0) onItemClick({ label: '期初', delta: openingTotal, kind: 'start' });
      else if (idx === items.length + 1) {
        const closing = closingTotal ?? openingTotal + items.reduce((s, i) => s + i.delta, 0);
        onItemClick({ label: '期末', delta: closing, kind: 'end' });
      } else {
        const item = items[idx - 1];
        if (item) onItemClick({ label: item.label, delta: item.delta, kind: 'delta' });
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

export default FinanceWaterfall;
