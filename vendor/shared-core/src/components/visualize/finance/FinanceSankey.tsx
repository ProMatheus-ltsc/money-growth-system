/**
 * 财务桑基图（@shared/core 可复用财务图表，内部 ECharts 按需引入）。
 * 提取自家庭资产增长记录工具项目（2026-08）：资金流向（NVIDIA FY22 Income Statement 式）——
 * 收入类别 →「总收入」节点 → 支出类别 + 结余，流带宽度与金额成正比。
 *
 * 视觉基线（消费方经 `paletteMap` 注入）：流入彩色/绿、流出灰、结余绿；节点标注金额
 * （`showNodeAmount`）；点击流带/节点下钻该类别明细（`onItemClick`）。
 * 组件自身保持中性缺省，保证上游复用性。
 */
import { CanvasRenderer } from 'echarts/renderers';
import { SankeyChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { use } from 'echarts/core';
import {
  DEFAULT_FINANCE_PALETTE,
  formatFinanceAmount,
  useFinanceChart,
  type FinanceChartBaseProps,
} from './financeChartShared';

use([CanvasRenderer, SankeyChart, TooltipComponent]);

export interface FinanceSankeyFlow {
  source: string;
  target: string;
  /** 金额（元） */
  value: number;
}

export interface FinanceSankeyProps extends FinanceChartBaseProps {
  /** 流带集（节点由 source/target 自动推导，或经 `nodes` 显式声明顺序） */
  flows: FinanceSankeyFlow[];
  /** 显式节点顺序（缺省按 flows 出现顺序推导） */
  nodes?: { name: string }[];
  /** 节点金额标注开关（缺省开启：节点右侧标注金额） */
  showNodeAmount?: boolean;
  /** 节点配色（名称 → 颜色；未覆盖的节点按缺省色板顺序取色） */
  paletteMap?: Record<string, string>;
  /** 流带上色方式：渐变（缺省）/ 跟随源节点 / 跟随目标节点 */
  linkColorMode?: 'gradient' | 'source' | 'target';
  /** 点击流带或节点（下钻由消费方接线） */
  onItemClick?: (payload: { type: 'node' | 'link'; name: string; source?: string; target?: string; value: number }) => void;
}

/**
 * 财务桑基图组件。纯展示：数据经 props 传入；外观经 `palette`/`paletteMap`/`unit` 注入。
 */
export function FinanceSankey({
  flows,
  nodes,
  showNodeAmount = true,
  palette,
  paletteMap,
  linkColorMode = 'gradient',
  unit = 'yuan',
  devicePixelRatio = 2,
  height = 320,
  className,
  onItemClick,
}: FinanceSankeyProps) {
  const colors = palette ?? DEFAULT_FINANCE_PALETTE;
  const map = paletteMap ?? {};

  const buildOption = (): Record<string, unknown> => {
    // 节点推导（保持出现顺序）
    const order: string[] = nodes ? nodes.map((n) => n.name) : [];
    const seen = new Set(order);
    for (const f of flows) {
      for (const name of [f.source, f.target]) {
        if (!seen.has(name)) {
          seen.add(name);
          order.push(name);
        }
      }
    }
    // 节点金额 = max(流入, 流出)
    const inSum = new Map<string, number>();
    const outSum = new Map<string, number>();
    for (const f of flows) {
      outSum.set(f.source, (outSum.get(f.source) ?? 0) + f.value);
      inSum.set(f.target, (inSum.get(f.target) ?? 0) + f.value);
    }
    const nodeAmount = (name: string) => Math.max(inSum.get(name) ?? 0, outSum.get(name) ?? 0);

    const seriesNodes = order.map((name, i) => ({
      name,
      itemStyle: {
        color: map[name] ?? colors[i % colors.length],
        borderWidth: 0,
      },
      label: {
        show: true,
        formatter: showNodeAmount ? `${name}\n${formatFinanceAmount(nodeAmount(name), unit)}` : name,
        fontSize: 12,
        color: '#334155',
        lineHeight: 16,
      },
    }));

    const seriesLinks = flows
      .filter((f) => f.value > 0)
      .map((f) => ({ source: f.source, target: f.target, value: f.value }));

    return {
      animationDuration: 600,
      animationEasing: 'cubicOut',
      tooltip: {
        trigger: 'item',
        backgroundColor: '#fff',
        borderColor: '#e2e8f0',
        borderWidth: 1,
        textStyle: { color: '#1e293b', fontSize: 13 },
        formatter: (p: unknown) => {
          const info = p as { dataType: string; name: string; data: { source?: string; target?: string; value?: number } };
          if (info.dataType === 'edge') {
            return `${info.data.source} → ${info.data.target}<br/>${formatFinanceAmount(Number(info.data.value ?? 0), unit)}`;
          }
          return `${info.name}<br/>${formatFinanceAmount(nodeAmount(info.name), unit)}`;
        },
      },
      series: [
        {
          type: 'sankey',
          orient: 'horizontal',
          draggable: false,
          emphasis: { focus: 'adjacency' },
          nodeAlign: 'justify',
          nodeGap: 12,
          nodeWidth: 14,
          left: 8,
          right: 120,
          top: 8,
          bottom: 8,
          lineStyle: {
            color: linkColorMode,
            opacity: 0.45,
            curveness: 0.5,
          },
          data: seriesNodes,
          links: seriesLinks,
        },
      ],
    };
  };

  const containerRef = useFinanceChart(
    buildOption,
    [flows, nodes, showNodeAmount, colors, map, linkColorMode, unit],
    (params) => {
      const p = params as {
        dataType?: string;
        name?: string;
        data?: { source?: string; target?: string; value?: number };
        value?: number;
      };
      if (!onItemClick) return;
      if (p.dataType === 'edge' && p.data) {
        onItemClick({
          type: 'link',
          name: `${p.data.source} → ${p.data.target}`,
          source: p.data.source,
          target: p.data.target,
          value: Number(p.data.value ?? 0),
        });
      } else if (p.name) {
        onItemClick({ type: 'node', name: p.name, value: Number(p.value ?? 0) });
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

export default FinanceSankey;
