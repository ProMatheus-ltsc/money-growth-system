/**
 * 回路检测算法：从因果链数据构建有向图，通过 DFS 找出所有环路。
 *
 * 提取来源：root-cause-analysis/src/utils/loopDetection.ts
 * 适配说明：剥离业务耦合——原入口 detectLoops(values) 需从表单值里取
 * values['causalChain']，现改为直接接收 causalChain: CausalChainItem[] 数组参数；
 * 算法本体、判型规则与返回结构（loops/leveragePoints）保持不变。
 *
 * 核心概念（初学者先看这里）：
 * - 把每个因素当成"节点"，把每条"A 影响 B"当成一条"从 A 指向 B 的有向边"，
 *   这些边组成一张有向图。
 * - 回路（loop）= 从某个节点出发，沿有向边走一圈又能回到自己的路径，如 A→B→C→A。
 *   有回路的系统才会"自我强化/自我抑制"，这是系统思考分析的对象。
 *
 * 回路类型判定：奇偶法则
 * - 回路里若只有"增强型"边（正反馈）或有偶数条"抑制型"边（负反馈）→ 增强回路：
 *   偏差被放大（如越吵越凶），判断标准：抑制边数量为偶数（0、2、4…）
 * - 若"抑制型"边数量为奇数（1、3、5…）→ 调节回路：偏差被抑制，系统趋于稳定。
 *   直觉解释：奇数个负号相乘还是负号——整条回路表现为"负"（抑制）；
 *   偶数个负号相乘为正——表现为"正"（放大）。
 *
 * 杠杆点识别：出现在最多回路中的节点 = 牵一发而动全身的位置，干预它收益最大。
 * 这是启发式近似（真实系统动力学还有更精细的判定），对用户引导足够直观。
 */
import type { CausalChainItem } from '../types';

interface CausalEdge {
  from: string;
  to: string;
  relationType: 'reinforcing' | 'balancing' | 'causal' | 'none' | '';
}

export interface DetectedLoop {
  type: 'reinforcing' | 'balancing';
  typeLabel: string;
  nodes: string[];
  edges: CausalEdge[];
}

export interface LoopDetectionResult {
  loops: DetectedLoop[];
  leveragePoints: { factor: string; loopCount: number }[];
}

/** 邻接表：from → 从 from 出发的所有边。用 Map 而非数组是因为节点是字符串（因素名）。 */
function buildGraph(edges: CausalEdge[]): Map<string, CausalEdge[]> {
  const graph = new Map<string, CausalEdge[]>();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    graph.get(edge.from)!.push(edge);
  }
  return graph;
}

/**
 * 深度优先搜索（DFS）找出所有环。
 *
 * 为什么用 DFS + 两个集合：
 * - `stack`（当前路径）：记录"从起点走到现在"的节点序列；
 * - `stackSet`：stack 里节点的快速查找集（Set.has 是 O(1)，避免 indexOf 线性扫描）；
 * - `visited`：记录"这个节点已经被完整探索过"。
 *
 * 关键点（初学者最容易困惑的地方）：
 * 1. 找到环的条件：`stackSet.has(edge.to)` —— 目标节点已经在当前路径上，
 *    说明从它出发绕了一圈又回来了，形成闭环。
 * 2. 为什么递归返回时要从 `visited` 里删除节点（`visited.delete(node)`）？
 *    因为 `visited` 表示"以本节点为起点的所有路径都已探索完"。
 *    若保留在 visited 里，后面从其他起点经过该节点时会误判为"已探索"而跳过，
 *    导致漏掉跨起点的环。DFS 找环是"路径相关"的，不能用普通遍历的 visited 语义。
 * 3. 为什么限制最多 20 个环？完整枚举所有环在最坏情况下是指数级复杂度
 *    （完全图中环的数量为 n! 级别），加硬上限防止页面卡死，20 个对用户引导已足够。
 */
function findAllCycles(graph: Map<string, CausalEdge[]>, nodes: string[]): CausalEdge[][] {
  const cycles: CausalEdge[][] = [];
  const visited = new Set<string>();
  const stack: string[] = [];
  const stackSet = new Set<string>();

  function dfs(node: string, path: CausalEdge[]) {
    if (cycles.length >= 20) return; // 上限保护
    visited.add(node);
    stack.push(node);
    stackSet.add(node);

    const neighbors = graph.get(node) ?? [];
    for (const edge of neighbors) {
      if (cycles.length >= 20) return;
      if (stackSet.has(edge.to)) {
        // 发现环：目标在路径中。path.slice(cycleStartIdx) 截取"环的起点开始"的边，
        // 再补上当前这条回到起点的边，就得到完整一圈。
        const cycleStartIdx = stack.indexOf(edge.to);
        const cyclePath = [...path.slice(cycleStartIdx), edge];
        if (cyclePath.length >= 2) {
          cycles.push(cyclePath);
        }
      } else if (!visited.has(edge.to)) {
        // 目标不在路径上且未探索过 → 递归深入；否则跳过（避免回头走老路）
        dfs(edge.to, [...path, edge]);
      }
    }

    // 回溯：把当前节点从路径中移除，回到上一层继续尝试其他分支
    stack.pop();
    stackSet.delete(node);
    visited.delete(node); // 关键：见函数顶部注释第 2 点
  }

  // 从每个节点依次作为起点搜索，保证不遗漏任何起点形成的环
  for (const node of nodes) {
    if (cycles.length >= 20) break;
    dfs(node, []);
  }

  return cycles;
}

/**
 * 奇偶法则判型：统计回路里"抑制型（balancing）"边的数量。
 * 偶数（含 0）→ 增强回路；奇数 → 调节回路。
 */
function classifyLoop(edges: CausalEdge[]): 'reinforcing' | 'balancing' {
  let balancingCount = 0;
  for (const edge of edges) {
    if (edge.relationType === 'balancing') balancingCount++;
  }
  return balancingCount % 2 === 0 ? 'reinforcing' : 'balancing';
}

/**
 * 去重：同一个环会被 DFS 从不同起点重复找到多次（A→B→C→A、B→C→A→B、C→A→B→C）。
 * 去重思路：取环上所有节点名排序后拼接成 key —— 同一组节点无论从哪个起点开始、
 * 按什么顺序遍历，排序后都得到同一个 key，天然只保留一份。
 * 代价：会丢失环的"方向感"，但环的成员本身已足以向用户展示。
 */
function deduplicateLoops(cycles: CausalEdge[][]): CausalEdge[][] {
  const seen = new Set<string>();
  const unique: CausalEdge[][] = [];
  for (const cycle of cycles) {
    const nodeNames = cycle.map((e) => e.from);
    const sorted = [...nodeNames].sort();
    const key = sorted.join('|||');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(cycle);
    }
  }
  return unique;
}

/**
 * 因果回路检测入口：从因果链条目构建有向图并检测环路。
 * 无有效边（少于 2 条）时直接返回空结果。
 *
 * @param causalChain 因果链条目数组（CausalChainItem：factorA / factorB / relationType 等）
 * @returns loops 检测到的回路列表 + leveragePoints 杠杆点（参与回路最多的因素，最多 5 个）
 */
export function detectLoops(causalChain: CausalChainItem[]): LoopDetectionResult {
  // 过滤掉无效条目：关系类型为 none/空、或缺少任一端因素
  const edges: CausalEdge[] = causalChain
    .filter((entry) => {
      const rel = entry.relationType;
      return rel && rel !== 'none' && entry.factorA && entry.factorB;
    })
    .map((entry) => ({
      from: entry.factorA.trim(),
      to: entry.factorB.trim(),
      relationType: entry.relationType as CausalEdge['relationType'],
    }));

  if (edges.length < 2) {
    return { loops: [], leveragePoints: [] };
  }

  const nodeSet = new Set<string>();
  for (const e of edges) {
    nodeSet.add(e.from);
    nodeSet.add(e.to);
  }
  const nodes = Array.from(nodeSet);

  const graph = buildGraph(edges);
  const rawCycles = findAllCycles(graph, nodes);
  const uniqueCycles = deduplicateLoops(rawCycles);

  const loops: DetectedLoop[] = uniqueCycles.map((cycle) => {
    const type = classifyLoop(cycle);
    return {
      type,
      typeLabel: type === 'reinforcing' ? '增强回路' : '调节回路',
      nodes: cycle.map((e) => e.from),
      edges: cycle,
    };
  });

  const factorLoopCount = new Map<string, number>();
  for (const loop of loops) {
    for (const node of loop.nodes) {
      factorLoopCount.set(node, (factorLoopCount.get(node) ?? 0) + 1);
    }
  }

  const leveragePoints = Array.from(factorLoopCount.entries())
    .map(([factor, loopCount]) => ({ factor, loopCount }))
    .sort((a, b) => b.loopCount - a.loopCount)
    .slice(0, 5);

  return { loops, leveragePoints };
}

/**
 * 把回路检测结果渲染为中文可读文本，供页面直接展示。
 * @param causalChain 因果链条目数组
 */
export function detectLoopsText(causalChain: CausalChainItem[]): string {
  const result = detectLoops(causalChain);

  if (result.loops.length === 0) {
    return '（尚未检测到回路——请在因果链中建立至少一条环形因果关系，如 A→B→C→A）';
  }

  const lines: string[] = [];

  const reinforcing = result.loops.filter((l) => l.type === 'reinforcing');
  const balancing = result.loops.filter((l) => l.type === 'balancing');

  if (reinforcing.length > 0) {
    lines.push(`🔴 增强回路（${reinforcing.length} 条）—— 偏差会自我放大，形成恶性/良性循环：`);
    for (const loop of reinforcing) {
      const chain = [...loop.nodes, loop.nodes[0]].join(' → ');
      lines.push(`  · ${chain}`);
    }
  }

  if (balancing.length > 0) {
    lines.push(`🔵 调节回路（${balancing.length} 条）—— 偏差会被抑制，系统趋于稳定：`);
    for (const loop of balancing) {
      const chain = [...loop.nodes, loop.nodes[0]].join(' → ');
      lines.push(`  · ${chain}`);
    }
  }

  if (result.leveragePoints.length > 0) {
    lines.push('');
    lines.push('🎯 建议杠杆点（出现在最多回路中的因素，干预此处影响最大）：');
    for (const lp of result.leveragePoints) {
      lines.push(`  · ${lp.factor}（参与 ${lp.loopCount} 条回路）`);
    }
  }

  if (reinforcing.length > 0 && balancing.length === 0) {
    lines.push('');
    lines.push('⚠️ 仅检测到增强回路、无调节回路：系统处于失控放大状态，建议在杠杆点引入负反馈机制进行抑制。');
  } else if (balancing.length > 0 && reinforcing.length === 0) {
    lines.push('');
    lines.push('💡 仅检测到调节回路：系统有自我稳定倾向，如需改变现状需打破调节机制或引入增强回路驱动变化。');
  }

  return lines.join('\n');
}
