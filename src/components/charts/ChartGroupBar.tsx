/**
 * ChartGroupBar — 分组柱状图（06 T22/T23）：收支分类对比 / 跨期模块对比（A vs B 并排）。
 * 项目特有辅助图（02 §3 ⑦），ECharts 按需自封装。
 */
import { useEffect, useRef } from 'react';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { fmtMoney, type Unit } from '../../lib/format';

echarts.use([CanvasRenderer, BarChart, GridComponent, TooltipComponent, LegendComponent]);

interface ChartGroupBarProps {
  categories: string[];
  /** 两组数据（并排）：如 [收入, 支出] 或 [报告A, 报告B] */
  series: { name: string; values: (number | null)[]; color: string }[];
  unit?: Unit;
  height?: number;
}

export function ChartGroupBar({ categories, series, unit = 'yuan', height = 300 }: ChartGroupBarProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.EChartsType | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas', devicePixelRatio: 2 });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => {
      if (!chart.isDisposed()) chart.resize();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed()) return;
    chart.setOption(
      {
        animationDuration: 250,
        grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
        legend: { top: 0, icon: 'roundRect', itemWidth: 14 },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          valueFormatter: (v: unknown) => fmtMoney(Number(v ?? 0), unit),
        },
        xAxis: { type: 'category', data: categories, axisLabel: { interval: 0, fontSize: 11, width: 76, overflow: 'truncate' } },
        yAxis: {
          type: 'value',
          axisLabel: { formatter: (v: number) => fmtMoney(v, unit === 'yuan' ? 'wanyuan' : unit) },
          splitLine: { lineStyle: { color: '#e2e8f0' } },
        },
        series: series.map((s) => ({
          name: s.name,
          type: 'bar',
          barWidth: '30%',
          itemStyle: { color: s.color },
          data: s.values,
        })),
      },
      { notMerge: true }
    );
  }, [categories, series, unit]);

  return <div ref={ref} style={{ width: '100%', height }} />;
}
