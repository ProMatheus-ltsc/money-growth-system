/**
 * 财务树图（@shared/core 可复用财务图表，内部 ECharts 按需引入）。
 * 提取自家庭资产增长记录工具项目（2026-08）：资产配置结构（模块 → 二级细分），
 * 矩形面积与金额成正比（squarified 布局）。
 *
 * 视觉基线：标签按亮度自动选白/墨色（label.color: 'auto'）；面积不足时信息进入 hover 详情；
 * 点击矩形下钻该模块明细（`onItemClick`）。
 */
import { CanvasRenderer } from 'echarts/renderers';
import { TreemapChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { use } from 'echarts/core';
import {
  DEFAULT_FINANCE_PALETTE,
  formatFinanceAmount,
  useFinanceChart,
  type FinanceChartBaseProps,
} from './financeChartShared';

use([CanvasRenderer, TreemapChart, TooltipComponent]);

export interface FinanceTreemapNode {
  name: string;
  /** 金额（元） */
  amount: number;
  children?: FinanceTreemapNode[];
}

export interface FinanceTreemapProps extends FinanceChartBaseProps {
  /** 树结构（一级=模块，二级=细分科目/账户） */
  data: FinanceTreemapNode[];
  /** 点击矩形下钻（消费方展开模块明细） */
  onItemClick?: (payload: { name: string; amount: number }) => void;
}

function toEchartsTree(nodes: FinanceTreemapNode[]): Record<string, unknown>[] {
  return nodes.map((n) => ({
    name: n.name,
    value: n.amount,
    ...(n.children && n.children.length > 0 ? { children: toEchartsTree(n.children) } : {}),
  }));
}

/**
 * 财务树图组件。纯展示：数据经 props 传入；外观经 `palette`/`unit` 注入。
 */
export function FinanceTreemap({
  data,
  palette,
  unit = 'yuan',
  devicePixelRatio = 2,
  height = 320,
  className,
  onItemClick,
}: FinanceTreemapProps) {
  const colors = palette ?? DEFAULT_FINANCE_PALETTE;

  const buildOption = (): Record<string, unknown> => ({
    color: colors,
    animationDuration: 600,
    animationEasing: 'cubicOut',
    tooltip: {
      backgroundColor: '#fff',
      borderColor: '#e2e8f0',
      borderWidth: 1,
      textStyle: { color: '#1e293b', fontSize: 13 },
      formatter: (info: unknown) => {
        const p = info as { name: string; value: number };
        return `${p.name}<br/>${formatFinanceAmount(p.value, unit)}`;
      },
    },
    series: [
      {
        type: 'treemap',
        // squarified：矩形面积 = 金额
        roam: false,
        nodeClick: false, // 下钻由消费方经 onItemClick 接管，组件内不做面包屑跳转
        breadcrumb: { show: false },
        width: '100%',
        height: '100%',
        squareRatio: 0.7,
        label: {
          show: true,
          formatter: '{b}',
          color: 'auto', // 标签按背景亮度自动选白/墨色
          fontSize: 12,
        },
        upperLabel: { show: false },
        itemStyle: { borderColor: '#fff', borderWidth: 1.5, gapWidth: 1.5 },
        emphasis: { itemStyle: { borderColor: '#334155', borderWidth: 2 } },
        levels: [
          { itemStyle: { borderWidth: 2, gapWidth: 2 } },
          {
            colorSaturation: [0.35, 0.65],
            itemStyle: { borderColorSaturation: 0.5, gapWidth: 1 },
            label: { fontSize: 11 },
          },
        ],
        data: toEchartsTree(data),
      },
    ],
  });

  const containerRef = useFinanceChart(
    buildOption,
    [data, colors, unit],
    (params) => {
      const p = params as { name?: string; value?: number };
      if (p.name && onItemClick) onItemClick({ name: p.name, amount: Number(p.value ?? 0) });
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

export default FinanceTreemap;
