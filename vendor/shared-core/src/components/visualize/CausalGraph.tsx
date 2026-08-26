/**
 * 因果链图（CausalGraph）：把「因素 A → 因素 B」的因果条目画成"节点 + 带箭头连线"的有向图。
 * - 输入数据形态：causalChain 数组，每项为 CausalEntry（factorA / factorB / relationType，
 *   可选的 delayEffect 时延、evidence 证据说明）
 * - 视觉呈现逻辑：所有因素自动去重成节点，按 √N 网格排布（不依赖用户手动拖拽定位）；
 *   relationType 决定连线颜色与动画（默认：reinforcing 正反馈=绿色+流动动画，balancing 负反馈=橙色，
 *   causal 因果=靛蓝，none 无关=灰色且不画线）。
 * - 依赖 @xyflow/react（ReactFlow）负责交互画布渲染，本组件只负责计算 nodes / edges 数据。
 * - 提取自 root-cause-analysis 项目（公共图表组件）。业务语义已参数化：
 *   关系类型的中文连线标签可通过 relationshipLabels 覆盖，流动动画类型列表可通过 animatedTypes 自定义，
 *   便于不同项目复用各自的关系类型命名。
 */
import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  MarkerType,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

/**
 * 一条因果关系的输入数据：
 * - factorA / factorB：因果关系的两端因素名称（表示 factorA 影响 factorB）
 * - relationType：关系类型，取值见 RELATION_COLORS（默认 reinforcing / balancing / causal / none）
 * - delayEffect：可选的时延效应描述（如"延迟 3 天"）
 * - evidence：可选的证据说明
 */
interface CausalEntry {
  factorA: string;
  factorB: string;
  relationType: string;
  delayEffect?: string;
  evidence?: string;
}

/** 因果链图组件 props：causalChain 为待绘制的因果关系列表 */
interface CausalGraphProps {
  causalChain: CausalEntry[];
  /**
   * 关系类型 → 连线中文标签（显示在连线中间，如"正反馈"），覆盖内置默认值。
   * 内置默认：reinforcing=正反馈、balancing=负反馈、causal=因果、none=无关；
   * 未覆盖的类型保留默认，完全未知的类型回退为关系类型名本身。
   */
  relationshipLabels?: Record<string, string>;
  /**
   * 需要流动动画（animated）的关系类型列表，默认 ['reinforcing']。
   * 原项目用正反馈循环的流动箭头强调"不断增强"的循环感，其他项目可传自己的类型语义；
   * 传空数组则所有连线都不带流动动画。
   */
  animatedTypes?: string[];
}

// 关系类型 → 连线颜色：正反馈=绿色、负反馈=橙色、因果=靛蓝、无关=灰色。
// 这些颜色同时用于连线的 stroke（线条）和 markerEnd（末端箭头），保证箭头与线条同色。
const RELATION_COLORS: Record<string, string> = {
  reinforcing: '#10b981',
  balancing: '#f59e0b',
  causal: '#6366f1',
  none: '#94a3b8',
};

// 关系类型 → 中文标签默认值，会显示在连线中间（如"正反馈"），可用 relationshipLabels prop 覆盖
const RELATION_LABELS: Record<string, string> = {
  reinforcing: '正反馈',
  balancing: '负反馈',
  causal: '因果',
  none: '无关',
};

/**
 * 因果链图组件：把因果条目转化为 ReactFlow 的节点与边数据后交给画布渲染。
 * 内部用 useMemo 缓存计算结果，仅当 causalChain 或标签/动画配置变化时才重新排布，避免每次渲染都重算。
 */
export function CausalGraph({ causalChain, relationshipLabels, animatedTypes }: CausalGraphProps) {
  const { nodes, edges } = useMemo(() => {
    // 合并业务语义参数：关系类型中文标签可被 props 覆盖；流动动画类型列表可自定义
    const labels = { ...RELATION_LABELS, ...relationshipLabels };
    const animatedSet = new Set(animatedTypes ?? ['reinforcing']);

    // 第一步：收集所有出现过的因素名称（去重）。
    // factorA 和 factorB 都可能出现在多条因果里，用 Set 天然去重，保证每个因素只画一个节点。
    const factorSet = new Set<string>();
    for (const entry of causalChain) {
      if (entry.factorA) factorSet.add(entry.factorA);
      if (entry.factorB) factorSet.add(entry.factorB);
    }

    // 第二步：决定网格列数。用 sqrt 开根号让节点尽量排成正方形，
    // 例如 9 个因素 → ceil(√9)=3 列 3 行，4 个 → 2 列 2 行，比排成一长条更省空间。
    const factors = Array.from(factorSet);
    const cols = Math.ceil(Math.sqrt(factors.length));

    // 第三步：为每个因素生成一个 ReactFlow 节点。
    // 网格定位公式（初学者注意坐标来源）：
    //   x = (idx % cols) * 220 + 50 —— idx%cols 是"列号"（0..cols-1），决定横向偏移，
    //       每列间距 220px，+50 是左侧留白；
    //   y = Math.floor(idx / cols) * 120 + 50 —— idx/cols 向下取整是"行号"，决定纵向偏移，
    //       每行间距 120px，+50 是顶部留白。
    // sourcePosition=Right / targetPosition=Left：连线从节点右侧出去、从目标节点左侧进来，
    // 配合"左进右出"的网格阅读顺序，连线方向更整齐直观。
    const nodeList: Node[] = factors.map((factor, idx) => ({
      id: factor,
      data: { label: factor },
      position: {
        x: (idx % cols) * 220 + 50,
        y: Math.floor(idx / cols) * 120 + 50,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        background: '#f8fafc',
        border: '2px solid #6366f1',
        borderRadius: '12px',
        padding: '8px 16px',
        fontSize: '13px',
        fontWeight: 500,
        color: '#1e293b',
        minWidth: '100px',
        textAlign: 'center' as const,
      },
    }));

    // 第四步：生成连线（边）。先 filter 过滤掉关系为空或"none（无关）"的条目——无关关系没必要画出来；
    // 每条边 id 用索引 e-${idx} 保证唯一；颜色与中文标签按 relationType 映射，查不到时回退灰色；
    // animated 只有落在 animatedSet 中的类型（默认 reinforcing 正反馈）为 true，让箭头持续流动，强调"不断增强"的循环感；
    // markerEnd 用 ArrowClosed（实心箭头）指向目标节点，表示因果方向。
    const edgeList: Edge[] = causalChain
      .filter((entry) => entry.relationType && entry.relationType !== 'none' && entry.factorA && entry.factorB)
      .map((entry, idx) => ({
        id: `e-${idx}`,
        source: entry.factorA,
        target: entry.factorB,
        label: labels[entry.relationType] || entry.relationType,
        animated: animatedSet.has(entry.relationType),
        style: { stroke: RELATION_COLORS[entry.relationType] || '#94a3b8', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: RELATION_COLORS[entry.relationType] || '#94a3b8' },
        labelStyle: { fontSize: 11, fill: '#64748b' },
      }));

    return { nodes: nodeList, edges: edgeList };
  }, [causalChain, relationshipLabels, animatedTypes]);

  // 空数据兜底：没有任何因素时展示占位文案，而不是渲染一片空白画布
  if (nodes.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-8 text-center text-sm text-gray-400">
        完成因果链分析后，此处将显示因果关系图
      </div>
    );
  }

  return (
    // ReactFlow 画布：nodes/edges 传入上一步算好的数据；fitView 自动缩放平移，让全部节点适配可视区域；
    // Background 画点阵背景便于观察坐标位置，Controls 提供画布缩放/平移按钮。
    <div className="rounded-xl border border-gray-200 overflow-hidden" style={{ height: 400 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#e2e8f0" gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
