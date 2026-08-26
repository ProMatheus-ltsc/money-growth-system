/**
 * 资产树配置（05 §3.5/§3.6，F-05/F-12/F-08）：
 * - GET  当前/指定版本配置（平铺邻接表）
 * - POST 整树提交生成新版本 v(n+1)（结构校验失败整体不写入）
 * 权限：仅 admin（viewer 报表数据走 reports 端点）。
 */
import { Hono } from 'hono';
import type { ErrorDetail } from '../lib/errors';
import { invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { isValidMonth } from '../lib/month';
import { intField, strField } from '../lib/validate';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { getTreeNodes } from '../services/snapshotRepo';
import type { TreeNodeRow } from '../services/treeUtil';

const tree = new Hono<AppEnv>();

const FREQS = ['monthly', 'quarterly', 'semiannual', 'annual', 'irregular'] as const;
const ASSET_CATEGORIES = ['financial', 'physical'] as const;
const LIQUIDITIES = ['high', 'medium', 'low'] as const;

function nodeOut(n: TreeNodeRow) {
  return {
    id: n.id,
    parentId: n.parent_id,
    name: n.name,
    nodeType: n.node_type,
    targetRateAnnual: n.target_rate_annual,
    updateFreq: n.update_freq,
    enabled: n.enabled === 1,
    sortOrder: n.sort_order,
    identityInfo: n.identity_info,
    isPlaceholder: n.is_placeholder === 1,
    assetCategory: n.asset_category ?? 'financial',
    liquidity: n.liquidity ?? 'medium',
  };
}

// §3.5 查询资产树配置
tree.get('/', requireAuth, requireAdmin, async (c) => {
  const versionQ = c.req.query('version');
  let config: { id: number; version: number; effective_from_month: string; note: string | null } | null;
  if (versionQ !== undefined) {
    const errors: ErrorDetail[] = [];
    const version = intField(Number(versionQ), 'version', errors, { min: 1, label: 'version' });
    if (errors.length > 0 || Number.isNaN(Number(versionQ))) throw invalidParam('version 必须为正整数');
    config = await c.env.DB.prepare('SELECT * FROM tree_configs WHERE version = ?').bind(version).first();
    if (!config) throw notFound('资产树配置版本不存在');
  } else {
    config = await c.env.DB.prepare('SELECT * FROM tree_configs ORDER BY version DESC LIMIT 1').first();
    if (!config) throw notFound('资产树配置版本不存在');
  }
  const nodes = await getTreeNodes(c.env.DB, config.id);
  return ok(c, {
    configId: config.id,
    version: config.version,
    effectiveFromMonth: config.effective_from_month,
    nodes: nodes.map(nodeOut),
  });
});

interface NodeInput {
  tempId?: unknown;
  parentId?: unknown;
  name?: unknown;
  nodeType?: unknown;
  targetRateAnnual?: unknown;
  updateFreq?: unknown;
  enabled?: unknown;
  sortOrder?: unknown;
  identityInfo?: unknown;
  isPlaceholder?: unknown;
  assetCategory?: unknown;
  liquidity?: unknown;
}

// §3.6 保存新版本资产树配置
tree.post('/', requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw invalidParam('请求体必须为 JSON 对象');
  const errors: ErrorDetail[] = [];

  const effectiveFromMonth = strField(body.effectiveFromMonth, 'effectiveFromMonth', errors, {
    label: '生效起始月份',
  });
  if (effectiveFromMonth && !isValidMonth(effectiveFromMonth)) {
    errors.push({ field: 'effectiveFromMonth', message: '生效起始月份格式应为 YYYY-MM' });
  }
  const note = body.note === undefined || body.note === null
    ? null
    : strField(body.note, 'note', errors, { max: 100, label: '版本备注' });

  // 生效月必须晚于最近一次已保存快照月（保护历史口径，F-05）
  if (effectiveFromMonth && isValidMonth(effectiveFromMonth)) {
    const lastSnap = await c.env.DB.prepare('SELECT MAX(month) AS m FROM monthly_snapshots').first<{ m: string | null }>();
    if (lastSnap?.m && effectiveFromMonth <= lastSnap.m) {
      errors.push({ field: 'effectiveFromMonth', message: `生效起始月份必须晚于最近一次已保存快照的月份（${lastSnap.m}）` });
    }
  }

  const rawNodes = body.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    errors.push({ field: 'nodes', message: 'nodes 为必填数组且至少 1 个节点' });
    throw invalidParam('资产树结构校验失败', errors);
  }

  // ---- 逐节点字段校验 ----
  const nodes = rawNodes as NodeInput[];
  const tempIds = new Map<string, number>(); // tempId → 数组下标
  nodes.forEach((n, i) => {
    const f = `nodes[${i}]`;
    const tempId = strField(n.tempId, `${f}.tempId`, errors, { max: 64, label: 'tempId' });
    if (tempId) {
      if (tempIds.has(tempId)) errors.push({ field: `${f}.tempId`, message: `tempId 重复：${tempId}` });
      tempIds.set(tempId, i);
    }
    const name = strField(n.name, `${f}.name`, errors, { max: 30, label: '节点名称' });
    const nodeType = n.nodeType;
    if (nodeType !== 'module' && nodeType !== 'sub' && nodeType !== 'leaf') {
      errors.push({ field: `${f}.nodeType`, message: "nodeType 必须为 'module'/'sub'/'leaf'" });
    }
    if (n.targetRateAnnual !== undefined && n.targetRateAnnual !== null) {
      const r = n.targetRateAnnual;
      if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 10) {
        errors.push({ field: `${f}.targetRateAnnual`, message: '目标年化收益率须为 0~10 的小数或 null（继承）' });
      }
    }
    if (n.updateFreq !== undefined && n.updateFreq !== null && !(FREQS as readonly string[]).includes(String(n.updateFreq))) {
      errors.push({ field: `${f}.updateFreq`, message: '更新频率须为 monthly/quarterly/semiannual/annual/irregular 或 null（继承）' });
    }
    if (n.enabled !== undefined && typeof n.enabled !== 'boolean') {
      errors.push({ field: `${f}.enabled`, message: 'enabled 必须为布尔值' });
    }
    if (n.sortOrder !== undefined && (typeof n.sortOrder !== 'number' || !Number.isInteger(n.sortOrder))) {
      errors.push({ field: `${f}.sortOrder`, message: 'sortOrder 必须为整数' });
    }
    if (n.identityInfo !== undefined && n.identityInfo !== null) {
      strField(n.identityInfo, `${f}.identityInfo`, errors, { max: 50, label: '识别信息' });
    }
    if (n.isPlaceholder !== undefined && typeof n.isPlaceholder !== 'boolean') {
      errors.push({ field: `${f}.isPlaceholder`, message: 'isPlaceholder 必须为布尔值' });
    }
    if (n.assetCategory !== undefined && n.assetCategory !== null && !(ASSET_CATEGORIES as readonly string[]).includes(String(n.assetCategory))) {
      errors.push({ field: `${f}.assetCategory`, message: "assetCategory 须为 'financial'/'physical' 或不传（默认 financial）" });
    }
    if (n.liquidity !== undefined && n.liquidity !== null && !(LIQUIDITIES as readonly string[]).includes(String(n.liquidity))) {
      errors.push({ field: `${f}.liquidity`, message: "liquidity 须为 'high'/'medium'/'low' 或不传（默认 medium）" });
    }
    void name;
  });

  // ---- 父引用校验：顶层必须 module；不得悬空；不得循环 ----
  const existingNodeIds = new Set(
    ((await c.env.DB.prepare('SELECT id FROM tree_nodes').all<{ id: number }>()).results).map((r) => r.id)
  );
  const parentIdx = new Map<number, number | null>(); // 下标 → 父下标（批内）；-1 表示引用数据库既有节点
  nodes.forEach((n, i) => {
    const f = `nodes[${i}]`;
    const p = n.parentId;
    if (p === null || p === undefined) {
      if (n.nodeType !== 'module') {
        errors.push({ field: `${f}.nodeType`, message: '顶层节点必须为 module（资产模块）' });
      }
      parentIdx.set(i, null);
      return;
    }
    if (typeof p === 'string') {
      const pi = tempIds.get(p);
      if (pi === undefined) errors.push({ field: `${f}.parentId`, message: `悬空引用：tempId "${p}" 不在提交集中` });
      else parentIdx.set(i, pi);
      return;
    }
    if (typeof p === 'number') {
      if (!existingNodeIds.has(p)) {
        errors.push({ field: `${f}.parentId`, message: `悬空引用：节点 ${p} 不存在` });
        return;
      }
      parentIdx.set(i, -1); // 数据库既有节点，父链已在库内闭合
      return;
    }
    errors.push({ field: `${f}.parentId`, message: 'parentId 须为 null、数字（既有节点）或字符串（同批 tempId）' });
  });

  // 循环检测：沿批内父链走，必须到达 null 或库内节点
  if (errors.length === 0) {
    for (let i = 0; i < nodes.length; i++) {
      const visited = new Set<number>();
      let cur: number | null | undefined = i;
      const chain: string[] = [];
      while (cur !== null && cur !== -1 && cur !== undefined) {
        if (visited.has(cur)) {
          chain.push(String((nodes[cur] as NodeInput).name ?? ''));
          errors.push({
            field: `nodes[${cur}].parentId`,
            message: `检测到循环嵌套：${chain.reverse().join(' → ')}`,
          });
          break;
        }
        visited.add(cur);
        chain.push(String((nodes[cur] as NodeInput).name ?? ''));
        cur = parentIdx.get(cur);
      }
    }
  }

  if (errors.length > 0) throw invalidParam('资产树结构校验失败', errors);

  // ---- 写入新版本（校验失败整体不写入，到这里才开始写） ----
  const now = new Date().toISOString();
  const latest = await c.env.DB.prepare('SELECT MAX(version) AS v FROM tree_configs').first<{ v: number | null }>();
  const version = (latest?.v ?? 0) + 1;
  const cfgRes = await c.env.DB.prepare(
    'INSERT INTO tree_configs (version, effective_from_month, note, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(version, effectiveFromMonth, note, now)
    .run();
  const configId = Number(cfgRes.meta.last_row_id);

  // 两遍插入：先插全部节点（parent_id=NULL），再回填批内父引用
  const insertStmts = nodes.map((n) =>
    c.env.DB.prepare(
      `INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq,
       enabled, sort_order, identity_info, is_placeholder, asset_category, liquidity, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      configId,
      String(n.name).trim(),
      n.nodeType as string,
      n.targetRateAnnual ?? null,
      n.updateFreq ?? null,
      n.enabled === false ? 0 : 1,
      typeof n.sortOrder === 'number' ? n.sortOrder : 0,
      n.identityInfo ?? null,
      n.isPlaceholder === true ? 1 : 0,
      (ASSET_CATEGORIES as readonly string[]).includes(String(n.assetCategory)) ? String(n.assetCategory) : 'financial',
      (LIQUIDITIES as readonly string[]).includes(String(n.liquidity)) ? String(n.liquidity) : 'medium',
      now
    )
  );
  await c.env.DB.batch(insertStmts);
  const inserted = await c.env.DB.prepare('SELECT id FROM tree_nodes WHERE config_id = ? ORDER BY id').bind(configId).all<{ id: number }>();
  const tempIdToDbId = new Map<string, number>();
  nodes.forEach((n, i) => {
    const tid = typeof n.tempId === 'string' ? n.tempId : null;
    if (tid) tempIdToDbId.set(tid, inserted.results[i].id);
  });
  const updateStmts: ReturnType<AppEnv['Bindings']['DB']['prepare']>[] = [];
  nodes.forEach((n, i) => {
    const p = n.parentId;
    if (typeof p === 'string') {
      updateStmts.push(
        c.env.DB.prepare('UPDATE tree_nodes SET parent_id = ? WHERE id = ?').bind(tempIdToDbId.get(p) ?? null, inserted.results[i].id)
      );
    } else if (typeof p === 'number') {
      updateStmts.push(c.env.DB.prepare('UPDATE tree_nodes SET parent_id = ? WHERE id = ?').bind(p, inserted.results[i].id));
    }
  });
  if (updateStmts.length > 0) await c.env.DB.batch(updateStmts);

  // ---- 迁移折旧配置：将上一版本的折旧记录按 node 名称匹配复制到新版本 ----
  const prevConfigId = configId - 1;
  if (prevConfigId > 0) {
    const prevDeps = await c.env.DB.prepare(
      `SELECT ad.*, tn.name AS node_name FROM asset_depreciation ad
       JOIN tree_nodes tn ON tn.id = ad.node_id AND tn.config_id = ad.config_id
       WHERE ad.config_id = ?`
    ).bind(prevConfigId).all<{ node_name: string; depreciation_category: string; original_value: number; purchase_date: string; useful_life_months: number; salvage_rate: number; salvage_mode: string; market_salvage_value: number | null }>();

    if (prevDeps.results.length > 0) {
      const newNodes = await c.env.DB.prepare('SELECT id, name FROM tree_nodes WHERE config_id = ?').bind(configId).all<{ id: number; name: string }>();
      const nameToNewId = new Map<string, number>();
      for (const nn of newNodes.results) nameToNewId.set(nn.name, nn.id);

      const migStmts = prevDeps.results
        .filter((d) => nameToNewId.has(d.node_name))
        .map((d) =>
          c.env.DB.prepare(
            `INSERT INTO asset_depreciation (node_id, config_id, depreciation_category, original_value, purchase_date,
             useful_life_months, salvage_rate, salvage_mode, market_salvage_value, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            nameToNewId.get(d.node_name)!,
            configId,
            d.depreciation_category,
            d.original_value,
            d.purchase_date,
            d.useful_life_months,
            d.salvage_rate,
            d.salvage_mode,
            d.market_salvage_value,
            now
          )
        );
      if (migStmts.length > 0) await c.env.DB.batch(migStmts);
    }
  }

  return ok(c, { configId, version });
});

export default tree;
