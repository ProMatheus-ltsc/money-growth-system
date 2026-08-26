/**
 * ChartMiniLine — 小倍数折线图（06 T20）：负债趋势「总负债」与「负债率」两个独立小图，
 * 规避双轴（02-demo-notes §7.9 / 03-prd F-02c 规则 6）。项目特有辅助图，ECharts 按需自封装。
 */
import { useEffect, useRef } from 'react';
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { fmtMoney, fmtRate, type Unit } from '../../lib/format';

echarts.use([CanvasRenderer, LineChart, GridComponent, TooltipComponent]);

interface ChartMiniLineProps {
  title: string;
  months: string[];
  values: number[];
  kind: 'money' | 'rate';
  unit?: Unit;
  color?: string;
  height?: number;
}

export function ChartMiniLine({ title, months, values, kind, unit = 'yuan', color = '#2a78d6', height = 140 }: ChartMiniLineProps) {
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
        grid: { left: 8, right: 8, top: 20, bottom: 4, containLabel: true },
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: unknown) => (kind === 'rate' ? fmtRate(Number(v ?? 0)) : fmtMoney(Number(v ?? 0), unit)),
        },
        xAxis: { type: 'category', data: months, axisLabel: { fontSize: 10 }, boundaryGap: false },
        yAxis: {
          type: 'value',
          axisLabel: { fontSize: 10, formatter: (v: number) => (kind === 'rate' ? `${(v * 100).toFixed(0)}%` : fmtMoney(v, unit === 'yuan' ? 'wanyuan' : unit)) },
          splitLine: { lineStyle: { color: '#e2e8f0' } },
        },
        series: [
          {
            type: 'line',
            data: values,
            symbol: 'circle',
            symbolSize: 4,
            lineStyle: { width: 2, color },
            itemStyle: { color },
            areaStyle: { opacity: 0.08 },
          },
        ],
      },
      { notMerge: true }
    );
  }, [months, values, kind, unit, color]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <p className="mb-1 text-xs font-medium text-slate-600">{title}</p>
      <div ref={ref} style={{ width: '100%', height }} />
    </div>
  );
}
