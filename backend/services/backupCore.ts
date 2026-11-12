/**
 * 备份核心（05 §3.26~§3.27，F-07，V1.4 移除 R2 后仅本地备份）：
 * - 导出结构（§3.26）：节点引用采用「配置内唯一引用」而非数据库 id，保证跨实例可恢复；
 *   不含账号与身份信息（users/sessions 不导出）。
 * - 本地下载（§3.26）与本地恢复（§3.27）同一结构同一校验器；云端备份（R2）已下线（04 §7.1）。
 * - 恢复：先校验后写入；非法拒绝且不改变任何现有数据（PRD §4 数据完整性）。
 *
 * 格式版本：
 * - v1：仅 treeConfigs/catConfigs/debts/snapshots/reportSnapshots/aiAnalyses；
 *   节点缺 assetCategory/liquidity，且不含折旧/重估/或有负债/健康配置。
 * - v2：节点补齐 assetCategory/liquidity；新增 depreciations/revaluations/
 *   contingentLiabilities/healthConfig 四组数据。
 * - v3（当前）：**节点引用改为显式唯一 `ref`**。v1/v2 用「名称路径」（`A>B>C`）定位节点，
 *   同一父节点下存在重名节点（真实数据里就有：两个「小李纳指100」）时路径相同的两个节点
 *   会塌成一个 key，恢复时后写覆盖前写 → 同一 snapshot 内相同 node_id →
 *   撞 `UNIQUE(snapshot_id, node_id)` 恢复中途失败。v3 给每个节点分配配置内唯一的 `ref`，
 *   任何重名都不再产生歧义。
 *
 * 恢复的原子性：全流程预分配显式主键（不依赖 last_row_id），把所有语句压进 **单个 D1 batch**。
 * D1 batch 即单事务，任一语句失败整批回滚，从而彻底消除「配置已重建、明细为空」的半恢复状态。
 * 历史实现因需读取 last_row_id 做顺序映射，只能拆成多次 await（非原子）。
 */
import type { Env } from '../env';
import type { ErrorDetail } from '../lib/errors';
import { isValidMonth } from '../lib/month';
import { catKeyPath, getCatItems, getTreeNodes, loadBundle } from './snapshotRepo';
import { nodeKeyPath } from './treeUtil';

/** 当前导出格式版本 */
export const BACKUP_SCHEMA_VERSION = 3;
/** 恢复可接受的版本（v1/v2 为历史文件，恢复时降级处理并给出告警） */
export const SUPPORTED_BACKUP_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3];

/**
 * 单次恢复允许的最大语句数（防御性上限）。
 * 超过则在**删除任何数据之前**拒绝，保证永远不会出现半恢复；正常数据量（4 个月快照）约 50 条。
 */
const MAX_RESTORE_STATEMENTS = 800;

const ASSET_CATEGORIES = ['financial', 'physical'] as const;
const LIQUIDITIES = ['high', 'medium', 'low'] as const;

/** D1 每条查询最多 100 个绑定参数（Cloudflare 官方限制） */
const MAX_BIND_VARS = 100;

/** 健康配置缺省值（迁移 0007 的种子；v1 备份恢复时用于回填） */
const HEALTH_CONFIG_DEFAULTS: { key: string; value: string }[] = [
  { key: 'concentration_threshold', value: '0.5' },
  { key: 'liquidity_months_min', value: '3' },
  { key: 'debt_service_ratio_max', value: '0.4' },
  { key: 'savings_rate_min', value: '0.2' },
  { key: 'cpi_annual_rate', value: '0.02' },
];

export interface BackupTreePayloadNode {
  /** v3：配置内唯一引用（如 n1/n2…）。v3 起所有节点引用都用它，不再依赖名称路径 */
  ref?: string;
  name: string;
  /** v3：父节点引用（roots 为 null），与 parentKey 并存以便人工阅读 */
  parentRef?: string | null;
  parentKey: string | null;
  nodeType: string;
  targetRateAnnual: number | null;
  updateFreq: string | null;
  enabled: boolean;
  sortOrder: number;
  identityInfo: string | null;
  isPlaceholder: boolean;
  /** v2 起：资产分类（financial/physical）。v1 备份无此字段 → 恢复回退 financial */
  assetCategory?: string | null;
  /** v2 起：流动性等级（high/medium/low）。v1 备份无此字段 → 恢复回退 medium */
  liquidity?: string | null;
}

export interface BackupPayload {
  schemaVersion: number;
  exportedAt: string;
  treeConfigs: {
    version: number;
    effectiveFromMonth: string;
    note: string | null;
    nodes: BackupTreePayloadNode[];
  }[];
  catConfigs: {
    version: number;
    threshold: number;
    items: { name: string; parentName: string | null; direction: string; sortOrder: number }[];
  }[];
  debts: {
    name: string;
    debtType: string;
    term: string;
    balance: number;
    annualRate: number;
    monthlyPayment: number;
    fixedRepayment: boolean;
    enabled: boolean;
  }[];
  snapshots: {
    month: string;
    treeConfigVersion: number;
    catConfigVersion: number;
    /** v3：nodeRef 为准；nodeKey 仅保留可读性（v1/v2 文件只有 nodeKey） */
    assets: { nodeRef?: string; nodeKey?: string; balance: number; hasNewFunds: boolean; updateSource: string }[];
    moduleGains: { nodeRef?: string; module?: string; gain: number | null }[];
    income: { cat: string; amount: number }[];
    expense: { cat: string; amount: number }[];
    largeItems: { direction: string; cat: string; name: string; amount: number }[];
    debts: { name: string; balance: number; repayment: number }[];
    correctedAt: string | null;
  }[];
  reportSnapshots: {
    reportType: string;
    startMonth: string;
    endMonth: string;
    generatedAt: string;
    payload: unknown;
  }[];
  aiAnalyses: { analysisDate: string; assetMonth: string; payload: unknown }[];
  /** v2 起：实物资产折旧参数（v3 用 treeConfigVersion + nodeRef 定位） */
  depreciations?: {
    treeConfigVersion: number;
    nodeRef?: string;
    nodeKey?: string;
    depreciationCategory: string;
    originalValue: number;
    purchaseDate: string;
    usefulLifeMonths: number;
    salvageRate: number;
    salvageMode: string;
    marketSalvageValue: number | null;
  }[];
  /** v2 起：公允价值重估记录（v3 用 treeConfigVersion + nodeRef 定位；created_by 不导出） */
  revaluations?: {
    treeConfigVersion: number;
    nodeRef?: string;
    nodeKey?: string;
    revaluationDate: string;
    previousValue: number;
    newValue: number;
    change: number;
    changeType: string;
    reason: string | null;
    appraiser: string | null;
  }[];
  /** v2 起：或有负债（不计入负债总额，仅报表附注披露；created_by 不导出） */
  contingentLiabilities?: {
    name: string;
    liabilityType: string;
    estimatedAmount: number;
    probability: string;
    counterparty: string | null;
    startDate: string | null;
    expiryDate: string | null;
    description: string | null;
    status: string;
  }[];
  /** v2 起：财务健康阈值配置（key/value 字符串表） */
  healthConfig?: { key: string; value: string }[];
}

/** 节点名称路径（v1/v2 语义）：父路径 + 名称 */
function keyOfNode(n: { parentKey?: string | null; name: string }): string {
  return n.parentKey === null || n.parentKey === undefined ? n.name : `${n.parentKey}>${n.name}`;
}

/**
 * 全库 → 导出结构。
 * v3 起为每个节点分配配置内唯一 ref，并以 ref 作为快照/折旧/重估的节点引用。
 */
export async function buildExportPayload(db: Env['DB']): Promise<BackupPayload> {
  const now = new Date().toISOString();
  const treeConfigs: BackupPayload['treeConfigs'] = [];
  /** config.id → version */
  const configVersionById = new Map<number, number>();
  /** config.id → 该版本节点集 */
  const nodesByConfigId = new Map<number, Awaited<ReturnType<typeof getTreeNodes>>>();
  /** config version → (nodeId → ref) */
  const refByVersion = new Map<number, Map<number, string>>();

  const { results: cfgs } = await db.prepare('SELECT * FROM tree_configs ORDER BY version ASC').all<{
    id: number; version: number; effective_from_month: string; note: string | null;
  }>();
  for (const cfg of cfgs) {
    const nodes = await getTreeNodes(db, cfg.id);
    configVersionById.set(cfg.id, cfg.version);
    nodesByConfigId.set(cfg.id, nodes);
    // 拓扑排序（父先于子），保证备份文件内父子链前向可解析
    const byParent = new Map<number | null, typeof nodes>();
    for (const n of nodes) {
      const arr = byParent.get(n.parent_id) ?? [];
      arr.push(n);
      byParent.set(n.parent_id, arr);
    }
    const ordered: typeof nodes = [];
    const walk = (parentId: number | null) => {
      for (const n of byParent.get(parentId) ?? []) {
        ordered.push(n);
        walk(n.id);
      }
    };
    walk(null);
    // 同一 config 内 ref 唯一；父先于子，索引稳定
    const refById = new Map<number, string>();
    ordered.forEach((n, i) => refById.set(n.id, `n${i + 1}`));
    refByVersion.set(cfg.version, refById);
    treeConfigs.push({
      version: cfg.version,
      effectiveFromMonth: cfg.effective_from_month,
      note: cfg.note,
      nodes: ordered.map((n) => ({
        ref: refById.get(n.id),
        name: n.name,
        parentRef: n.parent_id === null ? null : refById.get(n.parent_id) ?? null,
        parentKey: n.parent_id === null ? null : nodeKeyPath(nodes, n.parent_id),
        nodeType: n.node_type,
        targetRateAnnual: n.target_rate_annual,
        updateFreq: n.update_freq,
        enabled: n.enabled === 1,
        sortOrder: n.sort_order,
        identityInfo: n.identity_info,
        isPlaceholder: n.is_placeholder === 1,
        assetCategory: n.asset_category ?? 'financial',
        liquidity: n.liquidity ?? 'medium',
      })),
    });
  }

  const catConfigs: BackupPayload['catConfigs'] = [];
  const { results: catCfgs } = await db.prepare('SELECT * FROM cat_configs ORDER BY version ASC').all<{
    id: number; version: number; threshold_cents: number;
  }>();
  for (const cfg of catCfgs) {
    const items = await getCatItems(db, cfg.id);
    const byId = new Map(items.map((i) => [i.id, i]));
    // 一级在前、二级在后（父先于子），保证备份文件前向可解析
    const tops = items.filter((i) => i.parent_id === null);
    const ordered = [...tops, ...items.filter((i) => i.parent_id !== null)];
    catConfigs.push({
      version: cfg.version,
      threshold: cfg.threshold_cents / 100,
      items: ordered.map((i) => ({
        name: i.name,
        parentName: i.parent_id === null ? null : byId.get(i.parent_id)?.name ?? null,
        direction: i.direction,
        sortOrder: i.sort_order,
      })),
    });
  }

  const debts: BackupPayload['debts'] = [];
  const { results: debtRows } = await db.prepare('SELECT * FROM debts ORDER BY sort_order, id').all<{
    name: string; debt_type: string; term: string; balance_cents: number; annual_rate: number;
    monthly_payment_cents: number; fixed_repayment: number; enabled: number;
  }>();
  for (const d of debtRows) {
    debts.push({
      name: d.name,
      debtType: d.debt_type,
      term: d.term,
      balance: d.balance_cents / 100,
      annualRate: d.annual_rate,
      monthlyPayment: d.monthly_payment_cents / 100,
      fixedRepayment: d.fixed_repayment === 1,
      enabled: d.enabled === 1,
    });
  }

  const snapshots: BackupPayload['snapshots'] = [];
  const { results: snaps } = await db.prepare('SELECT month FROM monthly_snapshots ORDER BY month ASC').all<{ month: string }>();
  for (const s of snaps) {
    const b = await loadBundle(db, s.month);
    if (!b) continue;
    const ref = refByVersion.get(b.treeConfig.version);
    const nodeRef = (nodeId: number) => ref?.get(nodeId);
    const nodeName = (nodeId: number) => nodeKeyPath(b.treeNodes, nodeId);
    snapshots.push({
      month: s.month,
      treeConfigVersion: b.treeConfig.version,
      catConfigVersion: b.catConfig.version,
      assets: b.assets.map((a) => ({
        nodeRef: nodeRef(a.node_id),
        nodeKey: nodeName(a.node_id),
        balance: a.balance_cents / 100,
        hasNewFunds: a.has_new_funds === 1,
        updateSource: a.update_source,
      })),
      moduleGains: b.gains.map((g) => ({
        nodeRef: nodeRef(g.module_node_id),
        module: nodeName(g.module_node_id),
        gain: g.gain_cents === null ? null : g.gain_cents / 100,
      })),
      income: b.catAmounts
        .filter((ca) => b.catItems.find((i) => i.id === ca.cat_item_id)?.direction === 'income')
        .map((ca) => ({ cat: catKeyPath(b.catItems, ca.cat_item_id), amount: ca.amount_cents / 100 })),
      expense: b.catAmounts
        .filter((ca) => b.catItems.find((i) => i.id === ca.cat_item_id)?.direction === 'expense')
        .map((ca) => ({ cat: catKeyPath(b.catItems, ca.cat_item_id), amount: ca.amount_cents / 100 })),
      largeItems: b.largeItems.map((li) => ({
        direction: li.direction,
        cat: catKeyPath(b.catItems, li.cat_item_id),
        name: li.name,
        amount: li.amount_cents / 100,
      })),
      debts: b.debtsSnap.map((sd) => ({
        name: b.debtsMaster.find((d) => d.id === sd.debt_id)?.name ?? `#${sd.debt_id}`,
        balance: sd.balance_cents / 100,
        repayment: sd.repayment_cents / 100,
      })),
      correctedAt: b.snapshot.corrected_at,
    });
  }

  const reportSnapshots: BackupPayload['reportSnapshots'] = [];
  const { results: reps } = await db.prepare('SELECT * FROM report_snapshots ORDER BY generated_at ASC').all<{
    report_type: string; start_month: string; end_month: string; generated_at: string; payload_json: string;
  }>();
  for (const r of reps) {
    reportSnapshots.push({
      reportType: r.report_type,
      startMonth: r.start_month,
      endMonth: r.end_month,
      generatedAt: r.generated_at,
      payload: JSON.parse(r.payload_json),
    });
  }

  const aiAnalyses: BackupPayload['aiAnalyses'] = [];
  const { results: ais } = await db.prepare('SELECT * FROM ai_analyses ORDER BY analysis_date ASC').all<{
    analysis_date: string; asset_month: string; payload_json: string;
  }>();
  for (const a of ais) {
    aiAnalyses.push({ analysisDate: a.analysis_date, assetMonth: a.asset_month, payload: JSON.parse(a.payload_json) });
  }

  // ---- 折旧参数（node → 配置版本 + ref） ----
  const depreciations: NonNullable<BackupPayload['depreciations']> = [];
  const { results: depRows } = await db
    .prepare(
      `SELECT ad.node_id, ad.config_id, ad.depreciation_category, ad.original_value, ad.purchase_date,
              ad.useful_life_months, ad.salvage_rate, ad.salvage_mode, ad.market_salvage_value,
              tn.config_id AS node_config_id
       FROM asset_depreciation ad
       LEFT JOIN tree_nodes tn ON tn.id = ad.node_id
       ORDER BY ad.id ASC`
    )
    .all<{
      node_id: number; config_id: number; depreciation_category: string; original_value: number;
      purchase_date: string; useful_life_months: number; salvage_rate: number; salvage_mode: string;
      market_salvage_value: number | null; node_config_id: number | null;
    }>();
  for (const d of depRows) {
    const ownerConfigId = d.node_config_id ?? d.config_id;
    const nodes = nodesByConfigId.get(ownerConfigId);
    const version = configVersionById.get(ownerConfigId);
    if (!nodes || version === undefined) continue; // 极端脏数据：跳过而非产出不可恢复的条目
    depreciations.push({
      treeConfigVersion: version,
      nodeRef: refByVersion.get(version)?.get(d.node_id),
      nodeKey: nodeKeyPath(nodes, d.node_id),
      depreciationCategory: d.depreciation_category,
      originalValue: d.original_value,
      purchaseDate: d.purchase_date,
      usefulLifeMonths: d.useful_life_months,
      salvageRate: d.salvage_rate,
      salvageMode: d.salvage_mode,
      marketSalvageValue: d.market_salvage_value,
    });
  }

  // ---- 重估记录 ----
  const revaluations: NonNullable<BackupPayload['revaluations']> = [];
  const { results: revRows } = await db
    .prepare(
      `SELECT ar.node_id, ar.revaluation_date, ar.previous_value_cents, ar.new_value_cents, ar.change_cents,
              ar.change_type, ar.reason, ar.appraiser, tn.config_id AS node_config_id
       FROM asset_revaluations ar
       LEFT JOIN tree_nodes tn ON tn.id = ar.node_id
       ORDER BY ar.id ASC`
    )
    .all<{
      node_id: number; revaluation_date: string; previous_value_cents: number; new_value_cents: number;
      change_cents: number; change_type: string; reason: string | null; appraiser: string | null;
      node_config_id: number | null;
    }>();
  for (const r of revRows) {
    if (r.node_config_id === null) continue;
    const nodes = nodesByConfigId.get(r.node_config_id);
    const version = configVersionById.get(r.node_config_id);
    if (!nodes || version === undefined) continue;
    revaluations.push({
      treeConfigVersion: version,
      nodeRef: refByVersion.get(version)?.get(r.node_id),
      nodeKey: nodeKeyPath(nodes, r.node_id),
      revaluationDate: r.revaluation_date,
      previousValue: r.previous_value_cents / 100,
      newValue: r.new_value_cents / 100,
      change: r.change_cents / 100,
      changeType: r.change_type,
      reason: r.reason,
      appraiser: r.appraiser,
    });
  }

  // ---- 或有负债（不计入负债总额） ----
  const contingentLiabilities: NonNullable<BackupPayload['contingentLiabilities']> = [];
  const { results: clRows } = await db
    .prepare('SELECT * FROM contingent_liabilities ORDER BY id ASC')
    .all<{
      name: string; liability_type: string; estimated_amount_cents: number; probability: string;
      counterparty: string | null; start_date: string | null; expiry_date: string | null;
      description: string | null; status: string;
    }>();
  for (const r of clRows) {
    contingentLiabilities.push({
      name: r.name,
      liabilityType: r.liability_type,
      estimatedAmount: r.estimated_amount_cents / 100,
      probability: r.probability,
      counterparty: r.counterparty,
      startDate: r.start_date,
      expiryDate: r.expiry_date,
      description: r.description,
      status: r.status,
    });
  }

  // ---- 健康阈值配置 ----
  const healthConfig: NonNullable<BackupPayload['healthConfig']> = [];
  const { results: hcRows } = await db.prepare('SELECT key, value FROM health_config ORDER BY key ASC').all<{ key: string; value: string }>();
  for (const r of hcRows) healthConfig.push({ key: r.key, value: r.value });

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: now,
    treeConfigs,
    catConfigs,
    debts,
    snapshots,
    reportSnapshots,
    aiAnalyses,
    depreciations,
    revaluations,
    contingentLiabilities,
    healthConfig,
  };
}

/**
 * 先校验（§3.25/§3.27 同一校验器）：非法逐条列出，不改变任何数据。
 *
 * v3 起额外强制「引用唯一性」——这是恢复能在单事务内跑完的前提：
 * 同一 config 内节点 ref 唯一；同一快照内 assets / moduleGains 的节点引用唯一；
 * 负债名称唯一。历史 v1/v2 文件仍按名称路径校验，但会显式拒绝「路径碰撞」，
 * 避免重名节点在恢复时塌成一个 id 触发 UNIQUE 冲突。
 */
export function validateBackupPayload(p: unknown): ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return [{ field: 'payload', message: '备份内容必须为 JSON 对象' }];
  }
  const b = p as Partial<BackupPayload>;
  if (!SUPPORTED_BACKUP_SCHEMA_VERSIONS.includes(Number(b.schemaVersion))) {
    errors.push({
      field: 'schemaVersion',
      message: `不支持的备份版本：${String(b.schemaVersion)}（当前支持 ${SUPPORTED_BACKUP_SCHEMA_VERSIONS.join(' / ')}）`,
    });
    return errors;
  }
  const schemaVersion = Number(b.schemaVersion);
  const isV3 = schemaVersion >= 3;
  for (const key of ['treeConfigs', 'catConfigs', 'debts', 'snapshots'] as const) {
    if (!Array.isArray(b[key])) errors.push({ field: key, message: `${key} 缺失或不是数组` });
  }
  if (errors.length > 0) return errors;
  if (!Array.isArray(b.reportSnapshots)) b.reportSnapshots = [];
  if (!Array.isArray(b.aiAnalyses)) b.aiAnalyses = [];

  // v2+ 必含四组扩展数据：缺失说明文件被截断，宁可报错也不静默丢数据
  if (schemaVersion >= 2) {
    for (const key of ['depreciations', 'revaluations', 'contingentLiabilities', 'healthConfig'] as const) {
      if (!Array.isArray(b[key])) {
        errors.push({ field: key, message: `v${schemaVersion} 备份缺少 ${key} 数组（文件可能被截断）` });
      }
    }
    if (errors.length > 0) return errors;
  }

  // ---- treeConfigs ----
  /** version → 该配置内全部可解析的节点引用（v3 为 ref，v1/v2 为名称路径） */
  const treeRefsByVersion = new Map<number, Set<string>>();
  b.treeConfigs!.forEach((cfg, ci) => {
    const cf = `treeConfigs[${ci}]`;
    if (typeof cfg.version !== 'number') errors.push({ field: `${cf}.version`, message: 'version 必须为数字' });
    if (!isValidMonth(cfg.effectiveFromMonth)) errors.push({ field: `${cf}.effectiveFromMonth`, message: '生效月份格式应为 YYYY-MM' });
    if (!Array.isArray(cfg.nodes) || cfg.nodes.length === 0) {
      errors.push({ field: `${cf}.nodes`, message: '节点列表缺失或为空' });
      return;
    }

    if (isV3) {
      // v3：ref 唯一 + parentRef 可解析
      const refs = new Set<string>();
      const dupRefs: string[] = [];
      cfg.nodes.forEach((n, ni) => {
        const nf = `${cf}.nodes[${ni}]`;
        if (typeof n.ref !== 'string' || n.ref.length === 0) {
          errors.push({ field: `${nf}.ref`, message: 'v3 节点缺少唯一引用 ref' });
          return;
        }
        if (refs.has(n.ref)) dupRefs.push(n.ref);
        refs.add(n.ref);
      });
      if (dupRefs.length > 0) {
        errors.push({ field: `${cf}.nodes`, message: `节点引用重复：${[...new Set(dupRefs)].join('、')}` });
      }
      cfg.nodes.forEach((n, ni) => {
        const nf = `${cf}.nodes[${ni}]`;
        if (typeof n.name !== 'string' || n.name.length === 0) errors.push({ field: `${nf}.name`, message: '节点名称缺失' });
        if (!['module', 'sub', 'leaf'].includes(n.nodeType)) errors.push({ field: `${nf}.nodeType`, message: '节点类型非法' });
        if (n.parentRef !== null && n.parentRef !== undefined && !refs.has(n.parentRef)) {
          errors.push({ field: `${nf}.parentRef`, message: `父节点引用不存在：${String(n.parentRef)}` });
        }
        if (n.assetCategory !== undefined && n.assetCategory !== null && !(ASSET_CATEGORIES as readonly string[]).includes(String(n.assetCategory))) {
          errors.push({ field: `${nf}.assetCategory`, message: "assetCategory 须为 'financial'/'physical'" });
        }
        if (n.liquidity !== undefined && n.liquidity !== null && !(LIQUIDITIES as readonly string[]).includes(String(n.liquidity))) {
          errors.push({ field: `${nf}.liquidity`, message: "liquidity 须为 'high'/'medium'/'low'" });
        }
      });
      treeRefsByVersion.set(cfg.version, refs);
      return;
    }

    // v1/v2：名称路径。先收集，再检测碰撞（同一路径出现 ≥2 次 → 无法无歧义恢复）
    const keys = new Set<string>();
    const collisions = new Map<string, number>();
    cfg.nodes.forEach((n) => {
      const key = keyOfNode(n);
      if (keys.has(key)) collisions.set(key, (collisions.get(key) ?? 1) + 1);
      keys.add(key);
    });
    if (collisions.size > 0) {
      const detail = [...collisions.entries()].map(([k, c]) => `${k}（${c} 个）`).join('、');
      errors.push({
        field: `${cf}.nodes`,
        message: `存在同路径重名节点，无法无歧义恢复：${detail}。该文件为 v${schemaVersion} 旧格式，请重新导出备份（v3 起使用唯一引用）后再恢复`,
      });
    }
    cfg.nodes.forEach((n, ni) => {
      const nf = `${cf}.nodes[${ni}]`;
      if (typeof n.name !== 'string' || n.name.length === 0) errors.push({ field: `${nf}.name`, message: '节点名称缺失' });
      if (!['module', 'sub', 'leaf'].includes(n.nodeType)) errors.push({ field: `${nf}.nodeType`, message: '节点类型非法' });
      if (n.parentKey !== null && n.parentKey !== undefined && !keys.has(n.parentKey)) {
        errors.push({ field: `${nf}.parentKey`, message: `父节点路径在资产树配置中不存在：${String(n.parentKey)}` });
      }
      if (n.assetCategory !== undefined && n.assetCategory !== null && !(ASSET_CATEGORIES as readonly string[]).includes(String(n.assetCategory))) {
        errors.push({ field: `${nf}.assetCategory`, message: "assetCategory 须为 'financial'/'physical'" });
      }
      if (n.liquidity !== undefined && n.liquidity !== null && !(LIQUIDITIES as readonly string[]).includes(String(n.liquidity))) {
        errors.push({ field: `${nf}.liquidity`, message: "liquidity 须为 'high'/'medium'/'low'" });
      }
    });
    treeRefsByVersion.set(cfg.version, keys);
  });

  // ---- catConfigs ----
  const catKeysByVersion = new Map<number, Set<string>>();
  b.catConfigs!.forEach((cfg, ci) => {
    const cf = `catConfigs[${ci}]`;
    if (typeof cfg.version !== 'number') errors.push({ field: `${cf}.version`, message: 'version 必须为数字' });
    if (typeof cfg.threshold !== 'number' || cfg.threshold <= 0) errors.push({ field: `${cf}.threshold`, message: '阈值必须为正数' });
    if (!Array.isArray(cfg.items) || cfg.items.length === 0) {
      errors.push({ field: `${cf}.items`, message: '分类列表缺失或为空' });
      return;
    }
    const keys = new Set<string>();
    const dupNames: string[] = [];
    cfg.items.forEach((it) => {
      const k = `${it.direction}:${it.name}`;
      if (keys.has(k)) dupNames.push(k);
      keys.add(k);
    });
    if (dupNames.length > 0) {
      errors.push({ field: `${cf}.items`, message: `分类在同一方向下重名：${[...new Set(dupNames)].join('、')}` });
    }
    cfg.items.forEach((it, ii) => {
      const inf = `${cf}.items[${ii}]`;
      if (typeof it.name !== 'string' || it.name.length === 0) errors.push({ field: `${inf}.name`, message: '分类名缺失' });
      if (!['income', 'expense'].includes(it.direction)) errors.push({ field: `${inf}.direction`, message: '方向非法' });
      if (it.parentName !== null && it.parentName !== undefined && !keys.has(`${it.direction}:${it.parentName}`)) {
        errors.push({ field: `${inf}.parentName`, message: `父分类不存在：${String(it.parentName)}` });
      }
    });
    catKeysByVersion.set(cfg.version, keys);
  });

  // ---- debts（名称必须唯一：快照明细按名称回挂） ----
  const debtNames = new Set<string>();
  const dupDebtNames: string[] = [];
  b.debts!.forEach((d, di) => {
    const df = `debts[${di}]`;
    if (typeof d.name !== 'string' || d.name.length === 0) {
      errors.push({ field: `${df}.name`, message: '负债名称缺失' });
    } else {
      if (debtNames.has(d.name)) dupDebtNames.push(d.name);
      debtNames.add(d.name);
    }
    if (!['mortgage', 'auto_loan', 'credit_card', 'other'].includes(d.debtType)) errors.push({ field: `${df}.debtType`, message: '负债类型非法' });
    if (!['short', 'long'].includes(d.term)) errors.push({ field: `${df}.term`, message: '期限非法' });
    if (typeof d.balance !== 'number' || d.balance < 0) errors.push({ field: `${df}.balance`, message: '余额非法' });
  });
  if (dupDebtNames.length > 0) {
    errors.push({ field: 'debts', message: `负债名称重复：${[...new Set(dupDebtNames)].join('、')}` });
  }

  // ---- snapshots ----
  const monthsSeen = new Set<string>();
  b.snapshots!.forEach((s, si) => {
    const sf = `snapshots[${si}]`;
    if (!isValidMonth(s.month)) {
      errors.push({ field: `${sf}.month`, message: '月份格式非法' });
      return;
    }
    if (monthsSeen.has(s.month)) errors.push({ field: `${sf}.month`, message: `月份重复：${s.month}` });
    monthsSeen.add(s.month);
    const treeRefs = treeRefsByVersion.get(s.treeConfigVersion);
    if (!treeRefs) errors.push({ field: `${sf}.treeConfigVersion`, message: `引用的资产树版本不存在：v${s.treeConfigVersion}` });
    const catKeys = catKeysByVersion.get(s.catConfigVersion);
    if (!catKeys) errors.push({ field: `${sf}.catConfigVersion`, message: `引用的分类版本不存在：v${s.catConfigVersion}` });

    // CR-023：assets 缺失必须显式报错（原可选链静默通过）
    if (!Array.isArray(s.assets)) {
      errors.push({ field: `${sf}.assets`, message: 'assets 数组缺失' });
    } else {
      // 引用唯一性：同一快照内不允许同一节点出现两次（否则撞 UNIQUE(snapshot_id,node_id)）
      const seenRefs = new Map<string, number>();
      const dupRefs: string[] = [];
      s.assets.forEach((a, ai) => {
        const ref = isV3 ? a.nodeRef : a.nodeKey;
        if (typeof ref !== 'string' || ref.length === 0) {
          errors.push({
            field: `${sf}.assets[${ai}].${isV3 ? 'nodeRef' : 'nodeKey'}`,
            message: isV3 ? 'v3 资产明细缺少 nodeRef' : '节点路径缺失',
          });
          return;
        }
        if (seenRefs.has(ref)) dupRefs.push(ref);
        seenRefs.set(ref, (seenRefs.get(ref) ?? 0) + 1);
        if (treeRefs && !treeRefs.has(ref)) {
          errors.push({
            field: `${sf}.assets[${ai}].${isV3 ? 'nodeRef' : 'nodeKey'}`,
            message: `节点引用在资产树配置中不存在：${ref}`,
          });
        }
      });
      if (dupRefs.length > 0) {
        errors.push({
          field: `${sf}.assets`,
          message: `同一快照内节点重复：${[...new Set(dupRefs)].join('、')}（恢复会撞唯一约束）`,
        });
      }
    }

    // moduleGains：同一快照内模块不重复
    const seenGains = new Set<string>();
    const dupGains: string[] = [];
    (s.moduleGains ?? []).forEach((g, gi) => {
      const ref = isV3 ? g.nodeRef : g.module;
      if (typeof ref !== 'string' || ref.length === 0) {
        errors.push({ field: `${sf}.moduleGains[${gi}].${isV3 ? 'nodeRef' : 'module'}`, message: '收益明细的节点引用缺失' });
        return;
      }
      if (seenGains.has(ref)) dupGains.push(ref);
      seenGains.add(ref);
      if (treeRefs && !treeRefs.has(ref)) {
        errors.push({ field: `${sf}.moduleGains[${gi}].${isV3 ? 'nodeRef' : 'module'}`, message: `节点引用在资产树配置中不存在：${ref}` });
      }
    });
    if (dupGains.length > 0) {
      errors.push({ field: `${sf}.moduleGains`, message: `同一快照内收益节点重复：${[...new Set(dupGains)].join('、')}` });
    }

    for (const dir of ['income', 'expense'] as const) {
      (s[dir] ?? []).forEach((x, xi) => {
        if (!catKeys) return;
        if (typeof x.cat !== 'string' || x.cat.length === 0) {
          errors.push({ field: `${sf}.${dir}[${xi}].cat`, message: '分类路径缺失或非法' });
          return;
        }
        const parts = x.cat.split('>');
        const topOk = catKeys.has(`${dir}:${parts[0]}`);
        const leafOk = parts.length === 2 && catKeys.has(`${dir}:${parts[1]}`);
        if (!topOk || (parts.length === 2 && !leafOk)) {
          errors.push({ field: `${sf}.${dir}[${xi}].cat`, message: `分类路径在分类配置中不存在：${x.cat}` });
        }
      });
    }
    s.largeItems?.forEach((li, li_i) => {
      if (!catKeys) return;
      if (typeof li.cat !== 'string' || li.cat.length === 0) {
        errors.push({ field: `${sf}.largeItems[${li_i}].cat`, message: '大额明细分类缺失或非法' });
        return;
      }
      const parts = li.cat.split('>');
      if (parts.length === 2 && !catKeys.has(`${li.direction}:${parts[1]}`)) {
        errors.push({ field: `${sf}.largeItems[${li_i}].cat`, message: `大额明细分类不存在：${li.cat}` });
      }
    });
    const seenDebts = new Set<string>();
    s.debts?.forEach((d, di) => {
      if (!debtNames.has(d.name)) errors.push({ field: `${sf}.debts[${di}].name`, message: `负债不存在：${d.name}` });
      if (seenDebts.has(d.name)) errors.push({ field: `${sf}.debts[${di}].name`, message: `同一快照内负债重复：${d.name}` });
      seenDebts.add(d.name);
    });
  });

  // ---- 折旧 / 重估的节点引用必须可解析 ----
  const checkNodeRef = (items: unknown[] | undefined, label: string) => {
    (items ?? []).forEach((raw, i) => {
      const it = raw as { treeConfigVersion?: unknown; nodeRef?: unknown; nodeKey?: unknown };
      const f = `${label}[${i}]`;
      const refs = typeof it?.treeConfigVersion === 'number' ? treeRefsByVersion.get(it.treeConfigVersion) : undefined;
      if (!refs) {
        errors.push({ field: `${f}.treeConfigVersion`, message: `引用的资产树版本不存在：v${String(it?.treeConfigVersion)}` });
        return;
      }
      const ref = isV3 ? it.nodeRef : it.nodeKey;
      if (typeof ref !== 'string' || ref.length === 0) {
        errors.push({ field: `${f}.${isV3 ? 'nodeRef' : 'nodeKey'}`, message: isV3 ? 'v3 条目缺少 nodeRef' : '节点路径缺失' });
        return;
      }
      if (!refs.has(ref)) {
        errors.push({ field: `${f}.${isV3 ? 'nodeRef' : 'nodeKey'}`, message: `节点引用在资产树配置中不存在：${ref}` });
      }
    });
  };
  checkNodeRef(b.depreciations, 'depreciations');
  checkNodeRef(b.revaluations, 'revaluations');

  // ---- 或有负债枚举值 ----
  const CL_TYPES = ['guarantee', 'litigation', 'commitment', 'other'];
  const CL_PROBS = ['probable', 'possible', 'remote'];
  const CL_STATUS = ['active', 'resolved', 'expired'];
  (b.contingentLiabilities ?? []).forEach((r, i) => {
    const f = `contingentLiabilities[${i}]`;
    if (typeof r.name !== 'string' || r.name.trim().length === 0) errors.push({ field: `${f}.name`, message: '名称缺失' });
    if (!CL_TYPES.includes(r.liabilityType)) errors.push({ field: `${f}.liabilityType`, message: '类型非法' });
    if (typeof r.estimatedAmount !== 'number' || r.estimatedAmount < 0) errors.push({ field: `${f}.estimatedAmount`, message: '金额非法' });
    if (!CL_PROBS.includes(r.probability)) errors.push({ field: `${f}.probability`, message: '可能性取值非法' });
    if (!CL_STATUS.includes(r.status)) errors.push({ field: `${f}.status`, message: '状态非法' });
  });

  // ---- 健康配置键值 ----
  const hcKeys = new Set<string>();
  const dupHc: string[] = [];
  (b.healthConfig ?? []).forEach((r, i) => {
    const f = `healthConfig[${i}]`;
    if (typeof r.key !== 'string' || r.key.length === 0) errors.push({ field: `${f}.key`, message: 'key 缺失' });
    else {
      if (hcKeys.has(r.key)) dupHc.push(r.key);
      hcKeys.add(r.key);
    }
    if (typeof r.value !== 'string') errors.push({ field: `${f}.value`, message: 'value 必须为字符串' });
  });
  if (dupHc.length > 0) {
    errors.push({ field: 'healthConfig', message: `健康阈值键重复：${[...new Set(dupHc)].join('、')}` });
  }

  return errors;
}

/** 把多行 VALUES 按 D1 绑定参数上限拆分 */
function chunkedInsert<T>(
  db: Env['DB'],
  sqlPrefix: string,
  cols: number,
  rows: T[],
  mapper: (row: T) => unknown[]
): ReturnType<Env['DB']['prepare']>[] {
  if (rows.length === 0) return [];
  const chunkSize = Math.max(1, Math.floor(MAX_BIND_VARS / cols));
  const stmts: ReturnType<Env['DB']['prepare']>[] = [];
  const values = (n: number, c: number) => Array(n).fill(`(${Array(c).fill('?').join(',')})`).join(',');
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    stmts.push(db.prepare(`${sqlPrefix} VALUES ${values(chunk.length, cols)}`).bind(...chunk.flatMap(mapper)));
  }
  return stmts;
}

/**
 * 恢复：清空业务表并按备份重建（users/sessions 不受影响，05 §3.25）。
 * 调用前必须已通过 validateBackupPayload。
 *
 * 原子性：全流程使用**预分配的显式主键**（不读 last_row_id），所有语句合成单个
 * `db.batch`（= 单事务）。任何一条失败整批回滚，不会留下半恢复状态。
 * 删除顺序即外键依赖顺序：先删引用方（明细/扩展表），再删被引用方（tree_nodes/tree_configs）。
 */
export async function restoreFromPayload(db: Env['DB'], p: BackupPayload) {
  const now = new Date().toISOString();
  const schemaVersion = Number(p.schemaVersion);
  const isV3 = schemaVersion >= 3;
  const hasExtended = schemaVersion >= 2;
  const warnings: string[] = [];

  // v1 备份不含折旧/重估：清空后无法回填，先统计以便告警
  if (!hasExtended) {
    const dep = await db.prepare('SELECT COUNT(*) AS c FROM asset_depreciation').first<{ c: number }>();
    const rev = await db.prepare('SELECT COUNT(*) AS c FROM asset_revaluations').first<{ c: number }>();
    const depCount = dep?.c ?? 0;
    const revCount = rev?.c ?? 0;
    if (depCount > 0 || revCount > 0) {
      warnings.push(
        `该备份为 v1 格式（不含折旧/重估），恢复后 ${depCount} 条折旧配置、${revCount} 条重估记录已被清空且无法从本文件恢复；`
        + '请改用新版本导出的备份，或恢复后到「实物资产」页重新录入。'
      );
    }
    warnings.push('该备份为 v1 格式：或有负债与健康阈值配置不在备份内，已保留当前值未做改动。');
  }

  // ================= 预分配主键 =================
  const treeConfigIdByVersion = new Map<number, number>();
  p.treeConfigs.forEach((cfg, i) => treeConfigIdByVersion.set(cfg.version, i + 1));

  /**
   * 节点标识 → 新 node_id。
   * v3 用 ref；v1/v2 用名称路径（此时校验器已保证路径无碰撞）。
   */
  const nodeIdByVersion = new Map<number, Map<string, number>>();
  const treeNodeRows: { id: number; configId: number; node: BackupTreePayloadNode; parentId: number | null }[] = [];
  let nextNodeId = 1;
  for (const cfg of p.treeConfigs) {
    const configId = treeConfigIdByVersion.get(cfg.version)!;
    const map = new Map<string, number>();
    const local: { id: number; node: BackupTreePayloadNode }[] = [];
    for (const n of cfg.nodes) {
      const id = nextNodeId++;
      local.push({ id, node: n });
      map.set(isV3 ? String(n.ref) : keyOfNode(n), id);
    }
    nodeIdByVersion.set(cfg.version, map);
    for (const { id, node } of local) {
      let parentId: number | null = null;
      if (isV3 ? node.parentRef !== null && node.parentRef !== undefined : node.parentKey !== null) {
        const parentKey = isV3 ? String(node.parentRef) : String(node.parentKey);
        parentId = map.get(parentKey) ?? null;
      }
      treeNodeRows.push({ id, configId, node, parentId });
    }
  }

  const catConfigIdByVersion = new Map<number, number>();
  p.catConfigs.forEach((cfg, i) => catConfigIdByVersion.set(cfg.version, i + 1));

  const catItemIdByVersion = new Map<number, Map<string, number>>();
  const catItemRows: { id: number; configId: number; item: BackupPayload['catConfigs'][number]['items'][number]; parentId: number | null }[] = [];
  let nextCatItemId = 1;
  for (const cfg of p.catConfigs) {
    const configId = catConfigIdByVersion.get(cfg.version)!;
    const map = new Map<string, number>();
    const local: { id: number; item: BackupPayload['catConfigs'][number]['items'][number] }[] = [];
    for (const it of cfg.items) {
      const id = nextCatItemId++;
      local.push({ id, item: it });
      map.set(`${it.direction}:${it.name}`, id);
    }
    catItemIdByVersion.set(cfg.version, map);
    for (const { id, item } of local) {
      const parentId = item.parentName === null || item.parentName === undefined
        ? null
        : map.get(`${item.direction}:${item.parentName}`) ?? null;
      catItemRows.push({ id, configId, item, parentId });
    }
  }

  const debtIdByName = new Map<string, number>();
  p.debts.forEach((d, i) => debtIdByName.set(d.name, i + 1));

  const snapshotIdByMonth = new Map<string, number>();
  p.snapshots.forEach((s, i) => snapshotIdByMonth.set(s.month, i + 1));

  // ================= 构造语句 =================
  const stmts: ReturnType<Env['DB']['prepare']>[] = [];

  // ---- 清空（外键顺序：先引用方，后被引用方） ----
  stmts.push(
    db.prepare('DELETE FROM correction_logs'),
    // 扩展表必须先于 tree_nodes / tree_configs 删除（外键 NO ACTION，D1 强制）
    db.prepare('DELETE FROM asset_revaluations'),
    db.prepare('DELETE FROM asset_depreciation'),
    db.prepare('DELETE FROM snapshot_large_items'),
    db.prepare('DELETE FROM snapshot_cat_amounts'),
    db.prepare('DELETE FROM snapshot_debts'),
    db.prepare('DELETE FROM snapshot_gains'),
    db.prepare('DELETE FROM snapshot_assets'),
    db.prepare('DELETE FROM monthly_snapshots'),
    db.prepare('DELETE FROM report_snapshots'),
    db.prepare('DELETE FROM ai_analyses')
  );
  if (hasExtended) {
    // v2+ 为全量覆盖：或有负债 / 健康配置随备份重建；v1 不含 → 保留原值
    stmts.push(db.prepare('DELETE FROM contingent_liabilities'), db.prepare('DELETE FROM health_config'));
  }
  stmts.push(
    db.prepare('DELETE FROM debts'),
    db.prepare('DELETE FROM cat_items'),
    db.prepare('DELETE FROM cat_configs'),
    db.prepare('DELETE FROM tree_nodes'),
    db.prepare('DELETE FROM tree_configs')
  );

  // ---- tree_configs / tree_nodes ----
  stmts.push(
    ...chunkedInsert(db, 'INSERT INTO tree_configs (id, version, effective_from_month, note, created_at)', 5, p.treeConfigs,
      (cfg) => [treeConfigIdByVersion.get(cfg.version)!, cfg.version, cfg.effectiveFromMonth, cfg.note ?? null, now])
  );
  // 先插入（parent_id 置空），再统一回填父引用，避免父行尚未存在时触发外键
  stmts.push(
    ...chunkedInsert(
      db,
      `INSERT INTO tree_nodes (id, config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled,
       sort_order, identity_info, is_placeholder, asset_category, liquidity, created_at)`,
      14,
      treeNodeRows,
      ({ id, configId, node: n }) => [
        id,
        configId,
        null,
        n.name,
        n.nodeType,
        n.targetRateAnnual ?? null,
        n.updateFreq ?? null,
        n.enabled ? 1 : 0,
        n.sortOrder ?? 0,
        n.identityInfo ?? null,
        n.isPlaceholder ? 1 : 0,
        // v1 备份无这两列 → 回退默认值（与迁移 0003/0007 的 DEFAULT 一致）
        (ASSET_CATEGORIES as readonly string[]).includes(String(n.assetCategory)) ? String(n.assetCategory) : 'financial',
        (LIQUIDITIES as readonly string[]).includes(String(n.liquidity)) ? String(n.liquidity) : 'medium',
        now,
      ]
    )
  );
  for (const row of treeNodeRows) {
    if (row.parentId !== null) {
      stmts.push(db.prepare('UPDATE tree_nodes SET parent_id = ? WHERE id = ?').bind(row.parentId, row.id));
    }
  }

  // ---- cat_configs / cat_items ----
  stmts.push(
    ...chunkedInsert(db, 'INSERT INTO cat_configs (id, version, threshold_cents, created_at)', 4, p.catConfigs,
      (cfg) => [catConfigIdByVersion.get(cfg.version)!, cfg.version, Math.round(cfg.threshold * 100), now])
  );
  stmts.push(
    ...chunkedInsert(
      db,
      'INSERT INTO cat_items (id, config_id, parent_id, direction, name, sort_order, created_at)',
      7,
      catItemRows,
      ({ id, configId, item }) => [id, configId, null, item.direction, item.name, item.sortOrder ?? 0, now]
    )
  );
  for (const row of catItemRows) {
    if (row.parentId !== null) {
      stmts.push(db.prepare('UPDATE cat_items SET parent_id = ? WHERE id = ?').bind(row.parentId, row.id));
    }
  }

  // ---- debts ----
  stmts.push(
    ...chunkedInsert(
      db,
      `INSERT INTO debts (id, name, debt_type, term, balance_cents, annual_rate, monthly_payment_cents,
       fixed_repayment, enabled, sort_order, created_at, updated_at)`,
      12,
      p.debts,
      (d) => [
        debtIdByName.get(d.name)!,
        d.name,
        d.debtType,
        d.term,
        Math.round(d.balance * 100),
        d.annualRate,
        Math.round(d.monthlyPayment * 100),
        d.fixedRepayment ? 1 : 0,
        d.enabled ? 1 : 0,
        debtIdByName.get(d.name)! - 1,
        now,
        now,
      ]
    )
  );

  // ---- monthly_snapshots 及明细（汇总按明细重算，保证勾稽） ----
  const assetRows: unknown[][] = [];
  const gainRows: unknown[][] = [];
  const snapDebtRows: unknown[][] = [];
  const catAmountRows: unknown[][] = [];
  const largeItemRows: unknown[][] = [];
  const missingNodes: string[] = [];

  for (const s of p.snapshots) {
    const snapshotId = snapshotIdByMonth.get(s.month)!;
    const nodeIds = nodeIdByVersion.get(s.treeConfigVersion)!;
    const catIds = catItemIdByVersion.get(s.catConfigVersion)!;
    const resolveNode = (a: { nodeRef?: string; nodeKey?: string }) => {
      const ref = isV3 ? a.nodeRef : a.nodeKey;
      return typeof ref === 'string' ? nodeIds.get(ref) : undefined;
    };
    const resolveGainNode = (g: { nodeRef?: string; module?: string }) => {
      const ref = isV3 ? g.nodeRef : g.module;
      return typeof ref === 'string' ? nodeIds.get(ref) : undefined;
    };

    for (const a of s.assets) {
      const nodeId = resolveNode(a);
      if (nodeId === undefined) {
        missingNodes.push(`${s.month}:${isV3 ? a.nodeRef : a.nodeKey}`);
        continue;
      }
      assetRows.push([snapshotId, nodeId, Math.round(a.balance * 100), a.hasNewFunds ? 1 : 0, a.updateSource]);
    }
    for (const g of s.moduleGains ?? []) {
      const nodeId = resolveGainNode(g);
      if (nodeId === undefined) {
        missingNodes.push(`${s.month}:${isV3 ? g.nodeRef : g.module}`);
        continue;
      }
      gainRows.push([snapshotId, nodeId, g.gain === null || g.gain === undefined ? null : Math.round(g.gain * 100)]);
    }
    for (const d of s.debts) {
      snapDebtRows.push([snapshotId, debtIdByName.get(d.name) ?? 0, Math.round(d.balance * 100), Math.round(d.repayment * 100)]);
    }
    for (const x of s.income) {
      catAmountRows.push([snapshotId, catIds.get(`income:${x.cat.split('>')[1]}`) ?? catIds.get(`income:${x.cat}`) ?? 0, Math.round(x.amount * 100)]);
    }
    for (const x of s.expense) {
      catAmountRows.push([snapshotId, catIds.get(`expense:${x.cat.split('>')[1]}`) ?? catIds.get(`expense:${x.cat}`) ?? 0, Math.round(x.amount * 100)]);
    }
    for (const li of s.largeItems) {
      largeItemRows.push([
        snapshotId,
        li.direction,
        catIds.get(`${li.direction}:${li.cat.split('>')[1]}`) ?? catIds.get(`${li.direction}:${li.cat}`) ?? 0,
        li.name,
        Math.round(li.amount * 100),
        now,
      ]);
    }
  }

  // 汇总 = 明细重算（与校验阶段无关，保证 total_* 恒等于明细 SUM）
  const totalsBySnapshot = new Map<number, { assets: number; income: number; expense: number; debt: number }>();
  for (const s of p.snapshots) {
    const snapshotId = snapshotIdByMonth.get(s.month)!;
    totalsBySnapshot.set(snapshotId, {
      assets: s.assets.reduce((x, a) => x + Math.round(a.balance * 100), 0),
      income: s.income.reduce((x, a) => x + Math.round(a.amount * 100), 0),
      expense: s.expense.reduce((x, a) => x + Math.round(a.amount * 100), 0),
      debt: s.debts.reduce((x, a) => x + Math.round(a.balance * 100), 0),
    });
  }
  stmts.push(
    ...chunkedInsert(
      db,
      `INSERT INTO monthly_snapshots (id, month, tree_config_id, cat_config_id, total_assets_cents, total_debt_cents,
       total_income_cents, total_expense_cents, created_at, updated_at, corrected_at)`,
      11,
      p.snapshots,
      (s) => {
        const id = snapshotIdByMonth.get(s.month)!;
        const t = totalsBySnapshot.get(id)!;
        return [
          id,
          s.month,
          treeConfigIdByVersion.get(s.treeConfigVersion)!,
          catConfigIdByVersion.get(s.catConfigVersion)!,
          t.assets,
          t.debt,
          t.income,
          t.expense,
          now,
          now,
          s.correctedAt ?? null,
        ];
      }
    )
  );
  stmts.push(
    ...chunkedInsert(db, 'INSERT INTO snapshot_assets (snapshot_id, node_id, balance_cents, has_new_funds, update_source)', 5, assetRows, (r) => r),
    ...chunkedInsert(db, 'INSERT INTO snapshot_gains (snapshot_id, module_node_id, gain_cents)', 3, gainRows, (r) => r),
    ...chunkedInsert(db, 'INSERT INTO snapshot_debts (snapshot_id, debt_id, balance_cents, repayment_cents)', 4, snapDebtRows, (r) => r),
    ...chunkedInsert(db, 'INSERT INTO snapshot_cat_amounts (snapshot_id, cat_item_id, amount_cents)', 3, catAmountRows, (r) => r),
    ...chunkedInsert(
      db,
      'INSERT INTO snapshot_large_items (snapshot_id, direction, cat_item_id, name, amount_cents, created_at)',
      6,
      largeItemRows,
      (r) => r
    )
  );

  // ---- report_snapshots / ai_analyses ----
  stmts.push(
    ...chunkedInsert(
      db,
      `INSERT INTO report_snapshots (report_type, start_month, end_month, generated_at, total_assets_cents,
       net_worth_cents, debt_ratio, period_balance_cents, payload_json)`,
      9,
      p.reportSnapshots,
      (r) => {
        const payload = r.payload as { kpis?: { totalAssets?: number; netWorth?: number; debtRatio?: number; periodBalance?: number } };
        return [
          r.reportType,
          r.startMonth,
          r.endMonth,
          r.generatedAt,
          Math.round((payload?.kpis?.totalAssets ?? 0) * 100),
          Math.round((payload?.kpis?.netWorth ?? 0) * 100),
          payload?.kpis?.debtRatio ?? 0,
          Math.round((payload?.kpis?.periodBalance ?? 0) * 100),
          JSON.stringify(r.payload),
        ];
      }
    ),
    ...chunkedInsert(
      db,
      'INSERT INTO ai_analyses (analysis_date, asset_month, payload_json, created_at)',
      4,
      p.aiAnalyses,
      (a) => [a.analysisDate, a.assetMonth, JSON.stringify(a.payload), now]
    )
  );

  // ---- 折旧参数（配置版本 + ref → 新 node_id） ----
  const depRowsOut: unknown[][] = [];
  let skippedDepreciations = 0;
  for (const d of p.depreciations ?? []) {
    const nodeId = isV3
      ? nodeIdByVersion.get(d.treeConfigVersion)?.get(String(d.nodeRef))
      : nodeIdByVersion.get(d.treeConfigVersion)?.get(String(d.nodeKey));
    const configId = treeConfigIdByVersion.get(d.treeConfigVersion);
    if (nodeId === undefined || configId === undefined) {
      skippedDepreciations++;
      continue;
    }
    depRowsOut.push([
      nodeId,
      configId,
      d.depreciationCategory,
      d.originalValue,
      d.purchaseDate,
      d.usefulLifeMonths,
      d.salvageRate,
      d.salvageMode,
      d.marketSalvageValue ?? null,
      now,
    ]);
  }
  stmts.push(
    ...chunkedInsert(
      db,
      `INSERT INTO asset_depreciation (node_id, config_id, depreciation_category, original_value, purchase_date,
       useful_life_months, salvage_rate, salvage_mode, market_salvage_value, created_at)`,
      10,
      depRowsOut,
      (r) => r
    )
  );
  if (skippedDepreciations > 0) {
    warnings.push(`${skippedDepreciations} 条折旧配置因节点引用无法解析被跳过（其余已恢复）。`);
  }

  // ---- 重估记录（created_by 不导出 → NULL，避免跨实例用户 id 误挂） ----
  const revRowsOut: unknown[][] = [];
  let skippedRevaluations = 0;
  for (const r of p.revaluations ?? []) {
    const nodeId = isV3
      ? nodeIdByVersion.get(r.treeConfigVersion)?.get(String(r.nodeRef))
      : nodeIdByVersion.get(r.treeConfigVersion)?.get(String(r.nodeKey));
    if (nodeId === undefined) {
      skippedRevaluations++;
      continue;
    }
    const changeCents = Math.round(r.newValue * 100) - Math.round(r.previousValue * 100);
    revRowsOut.push([
      nodeId,
      r.revaluationDate,
      Math.round(r.previousValue * 100),
      Math.round(r.newValue * 100),
      Number.isFinite(r.change) ? Math.round(r.change * 100) : changeCents,
      r.changeType === 'appreciation' || r.changeType === 'depreciation'
        ? r.changeType
        : (changeCents >= 0 ? 'appreciation' : 'depreciation'),
      r.reason ?? null,
      r.appraiser ?? null,
      now,
    ]);
  }
  stmts.push(
    ...chunkedInsert(
      db,
      `INSERT INTO asset_revaluations (node_id, revaluation_date, previous_value_cents, new_value_cents, change_cents,
       change_type, reason, appraiser, created_by, created_at)`,
      10,
      revRowsOut,
      ([nodeId, date, prev, next, change, type, reason, appraiser, ts]) => [nodeId, date, prev, next, change, type, reason, appraiser, null, ts]
    )
  );
  if (skippedRevaluations > 0) {
    warnings.push(`${skippedRevaluations} 条重估记录因节点引用无法解析被跳过（其余已恢复）。`);
  }

  // ---- 或有负债 ----
  if (hasExtended) {
    stmts.push(
      ...chunkedInsert(
        db,
        `INSERT INTO contingent_liabilities (name, liability_type, estimated_amount_cents, probability, counterparty,
         start_date, expiry_date, description, status, created_by, created_at, updated_at)`,
        12,
        p.contingentLiabilities ?? [],
        (r) => [
          r.name,
          r.liabilityType,
          Math.round(r.estimatedAmount * 100),
          r.probability,
          r.counterparty ?? null,
          r.startDate ?? null,
          r.expiryDate ?? null,
          r.description ?? null,
          r.status,
          null,
          now,
          now,
        ]
      )
    );
  }

  // ---- 健康阈值配置（v1 备份不含 → 只补齐缺失键，绝不覆盖用户已定制的值） ----
  const healthRows = hasExtended
    ? (p.healthConfig ?? []).map((r) => [r.key, r.value, now])
    : HEALTH_CONFIG_DEFAULTS.map((r) => [r.key, r.value, now]);
  stmts.push(
    ...chunkedInsert(
      db,
      hasExtended
        ? 'INSERT INTO health_config (key, value, updated_at)'
        : 'INSERT OR IGNORE INTO health_config (key, value, updated_at)',
      3,
      healthRows,
      (r) => r
    )
  );

  // ================= 一次性原子提交 =================
  if (stmts.length > MAX_RESTORE_STATEMENTS) {
    // 在删除任何数据之前拒绝：宁可恢复失败，也不留半恢复状态
    throw new Error(
      `备份规模超出单次恢复上限（${stmts.length} 条语句 > ${MAX_RESTORE_STATEMENTS}）。`
      + '已中止且未修改任何数据。'
    );
  }
  await db.batch(stmts);

  if (missingNodes.length > 0) {
    warnings.push(`${missingNodes.length} 条快照明细因节点引用无法解析被跳过：${missingNodes.slice(0, 5).join('，')}${missingNodes.length > 5 ? ' 等' : ''}`);
  }

  return {
    restored: true,
    schemaVersion,
    warnings,
    counts: {
      treeConfigs: p.treeConfigs.length,
      catConfigs: p.catConfigs.length,
      debts: p.debts.length,
      snapshots: p.snapshots.length,
      reportSnapshots: p.reportSnapshots.length,
      aiAnalyses: p.aiAnalyses.length,
      depreciations: depRowsOut.length,
      revaluations: revRowsOut.length,
      contingentLiabilities: hasExtended ? (p.contingentLiabilities ?? []).length : 0,
      healthConfig: healthRows.length,
    },
  };
}
