/**
 * 资产树纯函数工具：邻接表节点集上的层级遍历、继承解析、模块求和。
 */
export interface TreeNodeRow {
  id: number;
  config_id: number;
  parent_id: number | null;
  name: string;
  node_type: 'module' | 'sub' | 'leaf';
  target_rate_annual: number | null;
  update_freq: 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'irregular' | null;
  enabled: number;
  sort_order: number;
  identity_info: string | null;
  is_placeholder: number;
  asset_category: 'financial' | 'physical';
  liquidity: 'high' | 'medium' | 'low';
}

export type AssetCategory = 'financial' | 'physical';

export type Freq = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'irregular';

export const FREQ_INTERVAL: Record<Freq, number | null> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
  irregular: null, // 不定期：不自动沿用，每月均可录入
};

export function nodesById(nodes: TreeNodeRow[]): Map<number, TreeNodeRow> {
  return new Map(nodes.map((n) => [n.id, n]));
}

export function childrenOf(nodes: TreeNodeRow[], parentId: number | null): TreeNodeRow[] {
  return nodes
    .filter((n) => n.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

export function topLevelModules(nodes: TreeNodeRow[]): TreeNodeRow[] {
  return childrenOf(nodes, null);
}

/** 节点的顶层模块祖先（自身为顶层时返回自身） */
export function topAncestor(nodes: TreeNodeRow[], nodeId: number): TreeNodeRow | null {
  const byId = nodesById(nodes);
  let cur = byId.get(nodeId);
  if (!cur) return null;
  while (cur.parent_id !== null) {
    const p = byId.get(cur.parent_id);
    if (!p) break;
    cur = p;
  }
  return cur;
}

/** 目标年化收益率：自身 → 向上继承；全无则 null */
export function effectiveRate(nodes: TreeNodeRow[], nodeId: number): number | null {
  const byId = nodesById(nodes);
  let cur = byId.get(nodeId);
  while (cur) {
    if (cur.target_rate_annual !== null) return cur.target_rate_annual;
    cur = cur.parent_id !== null ? byId.get(cur.parent_id) : undefined;
  }
  return null;
}

/** 更新频率：自身 → 向上继承；全无则默认 monthly（F-12 规则 1） */
export function effectiveFreq(nodes: TreeNodeRow[], nodeId: number): Freq {
  const byId = nodesById(nodes);
  let cur = byId.get(nodeId);
  while (cur) {
    if (cur.update_freq) return cur.update_freq;
    cur = cur.parent_id !== null ? byId.get(cur.parent_id) : undefined;
  }
  return 'monthly';
}

/** 节点是否为「启用的末级」：无子节点即末级（与 node_type='leaf' 一致） */
export function enabledLeaves(nodes: TreeNodeRow[]): TreeNodeRow[] {
  const parents = new Set(nodes.map((n) => n.parent_id).filter((p): p is number => p !== null));
  return nodes.filter((n) => n.enabled === 1 && !parents.has(n.id));
}

/** 某节点（含后代）下所有末级节点 */
export function descendantLeaves(nodes: TreeNodeRow[], rootId: number): TreeNodeRow[] {
  const byParent = new Map<number | null, TreeNodeRow[]>();
  for (const n of nodes) {
    const arr = byParent.get(n.parent_id) ?? [];
    arr.push(n);
    byParent.set(n.parent_id, arr);
  }
  const out: TreeNodeRow[] = [];
  const walk = (id: number) => {
    const kids = byParent.get(id) ?? [];
    if (kids.length === 0) {
      const self = nodes.find((n) => n.id === id);
      if (self) out.push(self);
      return;
    }
    for (const k of kids) walk(k.id);
  };
  walk(rootId);
  return out;
}

/**
 * 名称路径（F-07 备份用）："模块>子模块>末级"
 */
export function nodeKeyPath(nodes: TreeNodeRow[], nodeId: number): string {
  const byId = nodesById(nodes);
  const parts: string[] = [];
  let cur = byId.get(nodeId);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parent_id !== null ? byId.get(cur.parent_id) : undefined;
  }
  return parts.join('>');
}
