/**
 * 备份核心（05 §3.26~§3.27，F-07，V1.4 移除 R2 后仅本地备份）：
 * - 导出结构（§3.26）：节点引用采用「名称路径」而非数据库 id，保证跨实例可恢复；
 *   不含账号与身份信息（users/sessions 不导出）。
 * - 本地下载（§3.26）与本地恢复（§3.27）同一结构同一校验器；云端备份（R2）已下线（04 §7.1）。
 * - 恢复：先校验后写入；非法拒绝且不改变任何现有数据（PRD §4 数据完整性）。
 *
 * 格式版本：
 * - v1：仅 treeConfigs/catConfigs/debts/snapshots/reportSnapshots/aiAnalyses；
 *   节点缺 assetCategory/liquidity，且不含折旧/重估/或有负债/健康配置。
 * - v2（当前）：节点补齐 assetCategory/liquidity；新增 depreciations/revaluations/
 *   contingentLiabilities/healthConfig 四组数据；恢复为「全量覆盖」。
 * - v1 文件仍可恢复：缺失字段回退默认值，折旧/重估因外键必须先清空（结果里给出告警），
 *   或有负债/健康配置不受影响（这两张表不引用资产树，保留原值）。
 */
import type { Env } from '../env';
import type { ErrorDetail } from '../lib/errors';
import { isValidMonth } from '../lib/month';
import { catKeyPath, getCatItems, getTreeNodes, loadBundle } from './snapshotRepo';
import { nodeKeyPath } from './treeUtil';

/** 当前导出格式版本 */
export const BACKUP_SCHEMA_VERSION = 2;
/** 恢复可接受的版本（v1 为历史文件，恢复时降级处理并给出告警） */
export const SUPPORTED_BACKUP_SCHEMA_VERSIONS: readonly number[] = [1, 2];

const ASSET_CATEGORIES = ['financial', 'physical'] as const;
const LIQUIDITIES = ['high', 'medium', 'low'] as const;

/** 健康配置缺省值（迁移 0007 的种子；v1 备份恢复时用于回填） */
const HEALTH_CONFIG_DEFAULTS: { key: string; value: string }[] = [
  { key: 'concentration_threshold', value: '0.5' },
  { key: 'liquidity_months_min', value: '3' },
  { key: 'debt_service_ratio_max', value: '0.4' },
  { key: 'savings_rate_min', value: '0.2' },
  { key: 'cpi_annual_rate', value: '0.02' },
];

export interface BackupTreePayloadNode {
  name: string;
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
    assets: { nodeKey: string; balance: number; hasNewFunds: boolean; updateSource: string }[];
    moduleGains: { module: string; gain: number | null }[];
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
  /** v2：实物资产折旧参数（按配置版本 + 节点名称路径定位） */
  depreciations?: {
    treeConfigVersion: number;
    nodeKey: string;
    depreciationCategory: string;
    originalValue: number;
    purchaseDate: string;
    usefulLifeMonths: number;
    salvageRate: number;
    salvageMode: string;
    marketSalvageValue: number | null;
  }[];
  /** v2：公允价值重估记录（按配置版本 + 节点名称路径定位；created_by 不导出） */
  revaluations?: {
    treeConfigVersion: number;
    nodeKey: string;
    revaluationDate: string;
    previousValue: number;
    newValue: number;
    change: number;
    changeType: string;
    reason: string | null;
    appraiser: string | null;
  }[];
  /** v2：或有负债（不计入负债总额，仅报表附注披露；created_by 不导出） */
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
  /** v2：财务健康阈值配置（key/value 字符串表） */
  healthConfig?: { key: string; value: string }[];
}

/**
 * 全库 → §3.26 导出结构（名称路径）。
 * v2 起覆盖 0003~0007 四张扩展表；新增表时必须同步 restoreFromPayload 的清理与重放。
 */
export async function buildExportPayload(db: Env['DB']): Promise<BackupPayload> {
  const now = new Date().toISOString();
  const treeConfigs: BackupPayload['treeConfigs'] = [];
  /** config.id → version */
  const configVersionById = new Map<number, number>();
  /** config.id → 该版本节点集（用于名称路径解析） */
  const nodesByConfigId = new Map<number, Awaited<ReturnType<typeof getTreeNodes>>>();
  const { results: cfgs } = await db.prepare('SELECT * FROM tree_configs ORDER BY version ASC').all<{
    id: number; version: number; effective_from_month: string; note: string | null;
  }>();
  for (const cfg of cfgs) {
    const nodes = await getTreeNodes(db, cfg.id);
    configVersionById.set(cfg.id, cfg.version);
    nodesByConfigId.set(cfg.id, nodes);
    // 拓扑排序（父先于子），保证备份文件内名称路径链前向可解析
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
    treeConfigs.push({
      version: cfg.version,
      effectiveFromMonth: cfg.effective_from_month,
      note: cfg.note,
      nodes: ordered.map((n) => ({
        name: n.name,
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
    const nodeName = (nodeId: number) => nodeKeyPath(b.treeNodes, nodeId);
    snapshots.push({
      month: s.month,
      treeConfigVersion: b.treeConfig.version,
      catConfigVersion: b.catConfig.version,
      assets: b.assets.map((a) => ({
        nodeKey: nodeName(a.node_id),
        balance: a.balance_cents / 100,
        hasNewFunds: a.has_new_funds === 1,
        updateSource: a.update_source,
      })),
      // CR-005：moduleGains 按「节点全路径名称」导出（与 assets.nodeKey 同构，恢复侧可直接命中；
      // 原导出叶子名、恢复按全路径匹配 → 必 miss → node_id=0 脏行。05 §3.9 契约语义修订待用户拍板）
      moduleGains: b.gains.map((g) => ({ module: nodeName(g.module_node_id), gain: g.gain_cents === null ? null : g.gain_cents / 100 })),
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

  // ---- v2：折旧参数（node_id → 配置版本 + 名称路径） ----
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
    // 以节点实际所属配置为准（config_id 与 node 归属不一致时以 node 为准，保证路径可解析）
    const ownerConfigId = d.node_config_id ?? d.config_id;
    const nodes = nodesByConfigId.get(ownerConfigId);
    const version = configVersionById.get(ownerConfigId);
    if (!nodes || version === undefined) continue; // 极端脏数据：跳过而非产出不可恢复的条目
    depreciations.push({
      treeConfigVersion: version,
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

  // ---- v2：重估记录 ----
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

  // ---- v2：或有负债（不计入负债总额） ----
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

  // ---- v2：健康阈值配置 ----
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

/** 先校验（§3.25/§3.27 同一校验器）：非法逐条列出，不改变任何数据 */
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
  for (const key of ['treeConfigs', 'catConfigs', 'debts', 'snapshots'] as const) {
    if (!Array.isArray(b[key])) errors.push({ field: key, message: `${key} 缺失或不是数组` });
  }
  if (errors.length > 0) return errors;
  if (!Array.isArray(b.reportSnapshots)) b.reportSnapshots = [];
  if (!Array.isArray(b.aiAnalyses)) b.aiAnalyses = [];

  // v2 必含四组扩展数据：缺失说明文件被截断，宁可报错也不静默丢数据
  if (schemaVersion >= 2) {
    for (const key of ['depreciations', 'revaluations', 'contingentLiabilities', 'healthConfig'] as const) {
      if (!Array.isArray(b[key])) {
        errors.push({ field: key, message: `v${schemaVersion} 备份缺少 ${key} 数组（文件可能被截断）` });
      }
    }
    if (errors.length > 0) return errors;
  }

  // treeConfigs：parentKey 链可在本配置内解析
  const treeKeysByVersion = new Map<number, Set<string>>();
  b.treeConfigs!.forEach((cfg, ci) => {
    const cf = `treeConfigs[${ci}]`;
    if (typeof cfg.version !== 'number') errors.push({ field: `${cf}.version`, message: 'version 必须为数字' });
    if (!isValidMonth(cfg.effectiveFromMonth)) errors.push({ field: `${cf}.effectiveFromMonth`, message: '生效月份格式应为 YYYY-MM' });
    if (!Array.isArray(cfg.nodes) || cfg.nodes.length === 0) {
      errors.push({ field: `${cf}.nodes`, message: '节点列表缺失或为空' });
      return;
    }
    // 两遍校验：先收集全部节点键，再校验父路径存在（与数组顺序无关）
    const keys = new Set<string>();
    cfg.nodes.forEach((n) => {
      const key = n.parentKey === null || n.parentKey === undefined ? n.name : `${n.parentKey}>${n.name}`;
      keys.add(key);
    });
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
    treeKeysByVersion.set(cfg.version, keys);
  });

  // catConfigs：两级、方向合法、父名存在
  const catKeysByVersion = new Map<number, Set<string>>();
  b.catConfigs!.forEach((cfg, ci) => {
    const cf = `catConfigs[${ci}]`;
    if (typeof cfg.version !== 'number') errors.push({ field: `${cf}.version`, message: 'version 必须为数字' });
    if (typeof cfg.threshold !== 'number' || cfg.threshold <= 0) errors.push({ field: `${cf}.threshold`, message: '阈值必须为正数' });
    if (!Array.isArray(cfg.items) || cfg.items.length === 0) {
      errors.push({ field: `${cf}.items`, message: '分类列表缺失或为空' });
      return;
    }
    // 两遍校验：先收集全部分类键，再校验父分类存在（与数组顺序无关）
    const keys = new Set<string>();
    cfg.items.forEach((it) => keys.add(`${it.direction}:${it.name}`));
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

  // debts
  const debtNames = new Set<string>();
  b.debts!.forEach((d, di) => {
    const df = `debts[${di}]`;
    if (typeof d.name !== 'string' || d.name.length === 0) errors.push({ field: `${df}.name`, message: '负债名称缺失' });
    else debtNames.add(d.name);
    if (!['mortgage', 'auto_loan', 'credit_card', 'other'].includes(d.debtType)) errors.push({ field: `${df}.debtType`, message: '负债类型非法' });
    if (!['short', 'long'].includes(d.term)) errors.push({ field: `${df}.term`, message: '期限非法' });
    if (typeof d.balance !== 'number' || d.balance < 0) errors.push({ field: `${df}.balance`, message: '余额非法' });
  });

  // snapshots：月份唯一、引用可解析
  const monthsSeen = new Set<string>();
  b.snapshots!.forEach((s, si) => {
    const sf = `snapshots[${si}]`;
    if (!isValidMonth(s.month)) {
      errors.push({ field: `${sf}.month`, message: '月份格式非法' });
      return;
    }
    if (monthsSeen.has(s.month)) errors.push({ field: `${sf}.month`, message: `月份重复：${s.month}` });
    monthsSeen.add(s.month);
    const treeKeys = treeKeysByVersion.get(s.treeConfigVersion);
    if (!treeKeys) errors.push({ field: `${sf}.treeConfigVersion`, message: `引用的资产树版本不存在：v${s.treeConfigVersion}` });
    const catKeys = catKeysByVersion.get(s.catConfigVersion);
    if (!catKeys) errors.push({ field: `${sf}.catConfigVersion`, message: `引用的分类版本不存在：v${s.catConfigVersion}` });
    // CR-023：assets 缺失必须显式报错（原可选链静默通过）
    if (!Array.isArray(s.assets)) {
      errors.push({ field: `${sf}.assets`, message: 'assets 数组缺失' });
    } else {
      s.assets.forEach((a, ai) => {
        if (treeKeys && !treeKeys.has(a.nodeKey)) {
          errors.push({ field: `${sf}.assets[${ai}].nodeKey`, message: '节点路径在资产树配置中不存在' });
        }
      });
    }
    for (const dir of ['income', 'expense'] as const) {
      (s[dir] ?? []).forEach((x, xi) => {
        if (!catKeys) return;
        // CR-023：cat 非字符串时不再抛异常（收集错误而非 500）
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
    s.debts?.forEach((d, di) => {
      if (!debtNames.has(d.name)) errors.push({ field: `${sf}.debts[${di}].name`, message: `负债不存在：${d.name}` });
    });
  });

  // v2：折旧 / 重估的节点引用必须可解析（否则恢复会写坏外键）
  const checkNodeRef = (items: unknown[] | undefined, label: string) => {
    (items ?? []).forEach((raw, i) => {
      const it = raw as { treeConfigVersion?: unknown; nodeKey?: unknown };
      const f = `${label}[${i}]`;
      const keys = typeof it?.treeConfigVersion === 'number' ? treeKeysByVersion.get(it.treeConfigVersion) : undefined;
      if (!keys) {
        errors.push({ field: `${f}.treeConfigVersion`, message: `引用的资产树版本不存在：v${String(it?.treeConfigVersion)}` });
        return;
      }
      if (typeof it.nodeKey !== 'string' || it.nodeKey.length === 0) {
        errors.push({ field: `${f}.nodeKey`, message: '节点路径缺失' });
        return;
      }
      if (!keys.has(it.nodeKey)) {
        errors.push({ field: `${f}.nodeKey`, message: `节点路径在资产树配置中不存在：${it.nodeKey}` });
      }
    });
  };
  checkNodeRef(b.depreciations, 'depreciations');
  checkNodeRef(b.revaluations, 'revaluations');

  // v2：或有负债枚举值
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

  // v2：健康配置键值
  (b.healthConfig ?? []).forEach((r, i) => {
    const f = `healthConfig[${i}]`;
    if (typeof r.key !== 'string' || r.key.length === 0) errors.push({ field: `${f}.key`, message: 'key 缺失' });
    if (typeof r.value !== 'string') errors.push({ field: `${f}.value`, message: 'value 必须为字符串' });
  });

  return errors;
}

/**
 * 恢复（事务内清空业务表并重放；users/sessions 不受影响，05 §3.25）。
 * 调用前必须已通过 validateBackupPayload。
 *
 * 删除顺序即外键依赖顺序：先删引用方（明细/扩展表），再删被引用方（tree_nodes/tree_configs）。
 * asset_depreciation / asset_revaluations 均外键引用 tree_nodes(id)，必须在 tree_nodes 之前清空。
 */
export async function restoreFromPayload(db: Env['DB'], p: BackupPayload) {
  const now = new Date().toISOString();
  const schemaVersion = Number(p.schemaVersion);
  const isV2 = schemaVersion >= 2;
  const warnings: string[] = [];

  // v1 备份不含折旧/重估：清空后无法回填，先统计以便告警
  if (!isV2) {
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

  const deletes: ReturnType<Env['DB']['prepare']>[] = [
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
    db.prepare('DELETE FROM ai_analyses'),
  ];
  if (isV2) {
    // v2 为全量覆盖：或有负债 / 健康配置随备份重建；v1 不含这两张表 → 保留原值
    deletes.push(db.prepare('DELETE FROM contingent_liabilities'));
    deletes.push(db.prepare('DELETE FROM health_config'));
  }
  deletes.push(
    db.prepare('DELETE FROM debts'),
    db.prepare('DELETE FROM cat_items'),
    db.prepare('DELETE FROM cat_configs'),
    db.prepare('DELETE FROM tree_nodes'),
    db.prepare('DELETE FROM tree_configs')
  );
  await db.batch(deletes);

  // ---- tree configs（名称路径 → 新 id） ----
  const treeNodeIdByVersion = new Map<number, Map<string, number>>();
  const treeConfigIdByVersion = new Map<number, number>();
  for (const cfg of p.treeConfigs) {
    const res = await db.prepare('INSERT INTO tree_configs (version, effective_from_month, note, created_at) VALUES (?, ?, ?, ?)')
      .bind(cfg.version, cfg.effectiveFromMonth, cfg.note ?? null, now)
      .run();
    const configId = Number(res.meta.last_row_id);
    treeConfigIdByVersion.set(cfg.version, configId);
    const keyToId = new Map<string, number>();
    // 先插（父置空），再回填父引用
    const ids: number[] = [];
    for (const n of cfg.nodes) {
      const r = await db.prepare(
        `INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled, sort_order,
         identity_info, is_placeholder, asset_category, liquidity, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          configId,
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
          now
        )
        .run();
      const id = Number(r.meta.last_row_id);
      ids.push(id);
      const key = n.parentKey === null ? n.name : `${n.parentKey}>${n.name}`;
      keyToId.set(key, id);
    }
    for (let i = 0; i < cfg.nodes.length; i++) {
      const n = cfg.nodes[i];
      if (n.parentKey !== null) {
        const parentId = keyToId.get(n.parentKey);
        if (parentId !== undefined) {
          await db.prepare('UPDATE tree_nodes SET parent_id = ? WHERE id = ?').bind(parentId, ids[i]).run();
        }
      }
    }
    treeNodeIdByVersion.set(cfg.version, keyToId);
  }

  // ---- cat configs ----
  const catItemIdByVersion = new Map<number, Map<string, number>>();
  const catConfigIdByVersion = new Map<number, number>();
  for (const cfg of p.catConfigs) {
    const res = await db.prepare('INSERT INTO cat_configs (version, threshold_cents, created_at) VALUES (?, ?, ?)')
      .bind(cfg.version, Math.round(cfg.threshold * 100), now)
      .run();
    const configId = Number(res.meta.last_row_id);
    catConfigIdByVersion.set(cfg.version, configId);
    const keyToId = new Map<string, number>();
    const ids: number[] = [];
    for (const it of cfg.items) {
      const r = await db.prepare('INSERT INTO cat_items (config_id, parent_id, direction, name, sort_order, created_at) VALUES (?, NULL, ?, ?, ?, ?)')
        .bind(configId, it.direction, it.name, it.sortOrder ?? 0, now)
        .run();
      const id = Number(r.meta.last_row_id);
      ids.push(id);
      keyToId.set(`${it.direction}:${it.name}`, id);
    }
    for (let i = 0; i < cfg.items.length; i++) {
      const it = cfg.items[i];
      if (it.parentName !== null) {
        const parentId = keyToId.get(`${it.direction}:${it.parentName}`);
        if (parentId !== undefined) {
          await db.prepare('UPDATE cat_items SET parent_id = ? WHERE id = ?').bind(parentId, ids[i]).run();
        }
      }
    }
    catItemIdByVersion.set(cfg.version, keyToId);
  }
  // ---- debts ----
  const debtIdByName = new Map<string, number>();
  for (const d of p.debts) {
    const r = await db.prepare(
      `INSERT INTO debts (name, debt_type, term, balance_cents, annual_rate, monthly_payment_cents, fixed_repayment, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(d.name, d.debtType, d.term, Math.round(d.balance * 100), d.annualRate, Math.round(d.monthlyPayment * 100), d.fixedRepayment ? 1 : 0, d.enabled ? 1 : 0, debtIdByName.size, now, now)
      .run();
    debtIdByName.set(d.name, Number(r.meta.last_row_id));
  }

  // ---- monthly snapshots ----
  for (const s of p.snapshots) {
    const treeConfigId = treeConfigIdByVersion.get(s.treeConfigVersion)!;
    const catConfigId = catConfigIdByVersion.get(s.catConfigVersion)!;
    const nodeIds = treeNodeIdByVersion.get(s.treeConfigVersion)!;
    const catIds = catItemIdByVersion.get(s.catConfigVersion)!;

    const totalAssets = Math.round(s.assets.reduce((x, a) => x + a.balance, 0) * 100);
    const totalIncome = Math.round(s.income.reduce((x, a) => x + a.amount, 0) * 100);
    const totalExpense = Math.round(s.expense.reduce((x, a) => x + a.amount, 0) * 100);
    const totalDebt = Math.round(s.debts.reduce((x, a) => x + a.balance, 0) * 100);
    const res = await db.prepare(
      `INSERT INTO monthly_snapshots (month, tree_config_id, cat_config_id, total_assets_cents, total_debt_cents,
       total_income_cents, total_expense_cents, created_at, updated_at, corrected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(s.month, treeConfigId, catConfigId, totalAssets, totalDebt, totalIncome, totalExpense, now, now, s.correctedAt ?? null)
      .run();
    const snapshotId = Number(res.meta.last_row_id);

    const detailStmts: ReturnType<Env['DB']['prepare']>[] = [];
    const values = (n: number, cols: number) => Array(n).fill(`(${Array(cols).fill('?').join(',')})`).join(',');
    if (s.assets.length > 0) {
      detailStmts.push(
        db.prepare(`INSERT INTO snapshot_assets (snapshot_id, node_id, balance_cents, has_new_funds, update_source) VALUES ${values(s.assets.length, 5)}`)
          .bind(...s.assets.flatMap((a) => [snapshotId, nodeIds.get(a.nodeKey) ?? 0, Math.round(a.balance * 100), a.hasNewFunds ? 1 : 0, a.updateSource]))
      );
    }
    if (s.moduleGains.length > 0) {
      // CR-005：module 已按节点全路径名称导出（与 assets.nodeKey 同构），直接命中 nodeIds；
      // 旧版备份（叶子名）匹配失败时降级为 0 并记录，不再静默写入脏行语义。
      const rows = s.moduleGains.map((g) => {
        let moduleId = nodeIds.get(g.module) ?? 0;
        if (moduleId === 0) {
          // 兼容旧备份：全路径 key 的末段 == 叶子名 时也命中
          for (const [key, id] of nodeIds) {
            if (key.split('>').pop() === g.module) { moduleId = id; break; }
          }
        }
        return [snapshotId, moduleId, g.gain === null ? null : Math.round(g.gain * 100)];
      });
      detailStmts.push(
        db.prepare(`INSERT INTO snapshot_gains (snapshot_id, module_node_id, gain_cents) VALUES ${values(rows.length, 3)}`)
          .bind(...rows.flat())
      );
    }
    if (s.debts.length > 0) {
      detailStmts.push(
        db.prepare(`INSERT INTO snapshot_debts (snapshot_id, debt_id, balance_cents, repayment_cents) VALUES ${values(s.debts.length, 4)}`)
          .bind(...s.debts.flatMap((d) => [snapshotId, debtIdByName.get(d.name) ?? 0, Math.round(d.balance * 100), Math.round(d.repayment * 100)]))
      );
    }
    const catRows = [
      ...s.income.map((x) => [snapshotId, catIds.get(`income:${x.cat.split('>')[1]}`) ?? catIds.get(`income:${x.cat}`) ?? 0, Math.round(x.amount * 100)]),
      ...s.expense.map((x) => [snapshotId, catIds.get(`expense:${x.cat.split('>')[1]}`) ?? catIds.get(`expense:${x.cat}`) ?? 0, Math.round(x.amount * 100)]),
    ];
    if (catRows.length > 0) {
      detailStmts.push(
        db.prepare(`INSERT INTO snapshot_cat_amounts (snapshot_id, cat_item_id, amount_cents) VALUES ${values(catRows.length, 3)}`)
          .bind(...catRows.flat())
      );
    }
    if (s.largeItems.length > 0) {
      detailStmts.push(
        db.prepare(`INSERT INTO snapshot_large_items (snapshot_id, direction, cat_item_id, name, amount_cents, created_at) VALUES ${values(s.largeItems.length, 6)}`)
          .bind(...s.largeItems.flatMap((li) => [
            snapshotId,
            li.direction,
            catIds.get(`${li.direction}:${li.cat.split('>')[1]}`) ?? catIds.get(`${li.direction}:${li.cat}`) ?? 0,
            li.name,
            Math.round(li.amount * 100),
            now,
          ]))
      );
    }
    if (detailStmts.length > 0) await db.batch(detailStmts);
  }

  // ---- report snapshots & ai analyses ----
  for (const r of p.reportSnapshots) {
    await db.prepare(
      `INSERT INTO report_snapshots (report_type, start_month, end_month, generated_at, total_assets_cents, net_worth_cents, debt_ratio, period_balance_cents, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        r.reportType,
        r.startMonth,
        r.endMonth,
        r.generatedAt,
        Math.round(((r.payload as { kpis?: { totalAssets?: number } })?.kpis?.totalAssets ?? 0) * 100),
        Math.round(((r.payload as { kpis?: { netWorth?: number } })?.kpis?.netWorth ?? 0) * 100),
        (r.payload as { kpis?: { debtRatio?: number } })?.kpis?.debtRatio ?? 0,
        Math.round(((r.payload as { kpis?: { periodBalance?: number } })?.kpis?.periodBalance ?? 0) * 100),
        JSON.stringify(r.payload)
      )
      .run();
  }
  for (const a of p.aiAnalyses) {
    await db.prepare('INSERT INTO ai_analyses (analysis_date, asset_month, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .bind(a.analysisDate, a.assetMonth, JSON.stringify(a.payload), now)
      .run();
  }

  // ---- v2：折旧参数（配置版本 + 名称路径 → 新 node_id） ----
  let restoredDepreciations = 0;
  let skippedDepreciations = 0;
  for (const d of p.depreciations ?? []) {
    const configId = treeConfigIdByVersion.get(d.treeConfigVersion);
    const nodeId = treeNodeIdByVersion.get(d.treeConfigVersion)?.get(d.nodeKey);
    if (configId === undefined || nodeId === undefined) {
      skippedDepreciations++;
      continue;
    }
    await db.prepare(
      `INSERT INTO asset_depreciation (node_id, config_id, depreciation_category, original_value, purchase_date,
       useful_life_months, salvage_rate, salvage_mode, market_salvage_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        nodeId,
        configId,
        d.depreciationCategory,
        d.originalValue,
        d.purchaseDate,
        d.usefulLifeMonths,
        d.salvageRate,
        d.salvageMode,
        d.marketSalvageValue ?? null,
        now
      )
      .run();
    restoredDepreciations++;
  }
  if (skippedDepreciations > 0) {
    warnings.push(`${skippedDepreciations} 条折旧配置因节点路径无法解析被跳过（其余已恢复）。`);
  }

  // ---- v2：重估记录（created_by 不导出 → NULL，避免跨实例用户 id 误挂） ----
  let restoredRevaluations = 0;
  let skippedRevaluations = 0;
  for (const r of p.revaluations ?? []) {
    const nodeId = treeNodeIdByVersion.get(r.treeConfigVersion)?.get(r.nodeKey);
    if (nodeId === undefined) {
      skippedRevaluations++;
      continue;
    }
    const changeCents = Math.round(r.newValue * 100) - Math.round(r.previousValue * 100);
    await db.prepare(
      `INSERT INTO asset_revaluations (node_id, revaluation_date, previous_value_cents, new_value_cents, change_cents,
       change_type, reason, appraiser, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    )
      .bind(
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
        now
      )
      .run();
    restoredRevaluations++;
  }
  if (skippedRevaluations > 0) {
    warnings.push(`${skippedRevaluations} 条重估记录因节点路径无法解析被跳过（其余已恢复）。`);
  }

  // ---- v2：或有负债 ----
  let restoredContingent = 0;
  if (isV2) {
    for (const r of p.contingentLiabilities ?? []) {
      await db.prepare(
        `INSERT INTO contingent_liabilities (name, liability_type, estimated_amount_cents, probability, counterparty,
         start_date, expiry_date, description, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
        .bind(
          r.name,
          r.liabilityType,
          Math.round(r.estimatedAmount * 100),
          r.probability,
          r.counterparty ?? null,
          r.startDate ?? null,
          r.expiryDate ?? null,
          r.description ?? null,
          r.status,
          now,
          now
        )
        .run();
      restoredContingent++;
    }
  }

  // ---- v2：健康阈值配置（v1 备份不含 → 只补齐缺失键，绝不覆盖用户已定制的值） ----
  let restoredHealthConfig = 0;
  if (isV2) {
    for (const r of p.healthConfig ?? []) {
      await db.prepare('INSERT OR REPLACE INTO health_config (key, value, updated_at) VALUES (?, ?, ?)')
        .bind(r.key, r.value, now)
        .run();
      restoredHealthConfig++;
    }
  } else {
    // v1：health_config 未被删除，这里仅 INSERT OR IGNORE 补齐缺省键（幂等，不改动既有值）
    for (const d of HEALTH_CONFIG_DEFAULTS) {
      await db.prepare('INSERT OR IGNORE INTO health_config (key, value, updated_at) VALUES (?, ?, ?)')
        .bind(d.key, d.value, now)
        .run();
    }
    restoredHealthConfig = HEALTH_CONFIG_DEFAULTS.length;
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
      depreciations: restoredDepreciations,
      revaluations: restoredRevaluations,
      contingentLiabilities: restoredContingent,
      healthConfig: restoredHealthConfig,
    },
  };
}
