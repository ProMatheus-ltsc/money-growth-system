/**
 * 备份核心（05 §3.26~§3.27，F-07，V1.4 移除 R2 后仅本地备份）：
 * - 导出结构（§3.26，schemaVersion: 1）：节点引用采用「名称路径」而非数据库 id，
 *   保证跨实例可恢复；不含账号与身份信息（users/sessions 不导出）。
 * - 本地下载（§3.26）与本地恢复（§3.27）同一结构同一校验器；云端备份（R2）已下线（04 §7.1）。
 * - 恢复：先校验后写入；非法拒绝且不改变任何现有数据（PRD §4 数据完整性）。
 */
import type { Env } from '../env';
import type { ErrorDetail } from '../lib/errors';
import { isValidMonth } from '../lib/month';
import { catKeyPath, getCatItems, getTreeNodes, loadBundle } from './snapshotRepo';
import { nodeKeyPath } from './treeUtil';

export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupPayload {
  schemaVersion: number;
  exportedAt: string;
  treeConfigs: {
    version: number;
    effectiveFromMonth: string;
    note: string | null;
    nodes: {
      name: string;
      parentKey: string | null;
      nodeType: string;
      targetRateAnnual: number | null;
      updateFreq: string | null;
      enabled: boolean;
      sortOrder: number;
      identityInfo: string | null;
      isPlaceholder: boolean;
    }[];
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
}

/**
 * 全库 → §3.26 导出结构（名称路径）。
 * CR-006：资产折旧/重估/或有负债/健康配置 4 张扩展表（migrations 0003~0007）暂不纳入备份
 * （恢复后需在对应页面重新录入；UI 已提示）。纳入时须同步 restoreFromPayload 的清理与重建。
 */
export async function buildExportPayload(db: Env['DB']): Promise<BackupPayload> {
  const now = new Date().toISOString();
  const treeConfigs: BackupPayload['treeConfigs'] = [];
  const { results: cfgs } = await db.prepare('SELECT * FROM tree_configs ORDER BY version ASC').all<{
    id: number; version: number; effective_from_month: string; note: string | null;
  }>();
  for (const cfg of cfgs) {
    const nodes = await getTreeNodes(db, cfg.id);
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

  return { schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: now, treeConfigs, catConfigs, debts, snapshots, reportSnapshots, aiAnalyses };
}

/** 先校验（§3.25/§3.27 同一校验器）：非法逐条列出，不改变任何数据 */
export function validateBackupPayload(p: unknown): ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return [{ field: 'payload', message: '备份内容必须为 JSON 对象' }];
  }
  const b = p as Partial<BackupPayload>;
  if (b.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    errors.push({ field: 'schemaVersion', message: `不支持的备份版本：${String(b.schemaVersion)}（当前支持 ${BACKUP_SCHEMA_VERSION}）` });
    return errors;
  }
  for (const key of ['treeConfigs', 'catConfigs', 'debts', 'snapshots'] as const) {
    if (!Array.isArray(b[key])) errors.push({ field: key, message: `${key} 缺失或不是数组` });
  }
  if (errors.length > 0) return errors;
  if (!Array.isArray(b.reportSnapshots)) b.reportSnapshots = [];
  if (!Array.isArray(b.aiAnalyses)) b.aiAnalyses = [];

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

  return errors;
}

/**
 * 恢复（事务内清空业务表并重放；users/sessions 不受影响，05 §3.25）。
 * 调用前必须已通过 validateBackupPayload。
 */
export async function restoreFromPayload(db: Env['DB'], p: BackupPayload) {
  const now = new Date().toISOString();
  const stmts: ReturnType<Env['DB']['prepare']>[] = [
    db.prepare('DELETE FROM correction_logs'),
    db.prepare('DELETE FROM snapshot_large_items'),
    db.prepare('DELETE FROM snapshot_cat_amounts'),
    db.prepare('DELETE FROM snapshot_debts'),
    db.prepare('DELETE FROM snapshot_gains'),
    db.prepare('DELETE FROM snapshot_assets'),
    db.prepare('DELETE FROM monthly_snapshots'),
    db.prepare('DELETE FROM report_snapshots'),
    db.prepare('DELETE FROM ai_analyses'),
    db.prepare('DELETE FROM debts'),
    db.prepare('DELETE FROM cat_items'),
    db.prepare('DELETE FROM cat_configs'),
    db.prepare('DELETE FROM tree_nodes'),
    db.prepare('DELETE FROM tree_configs'),
  ];
  await db.batch(stmts);

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
        `INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled, sort_order, identity_info, is_placeholder, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(configId, n.name, n.nodeType, n.targetRateAnnual ?? null, n.updateFreq ?? null, n.enabled ? 1 : 0, n.sortOrder ?? 0, n.identityInfo ?? null, n.isPlaceholder ? 1 : 0, now)
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

  return {
    restored: true,
    counts: {
      treeConfigs: p.treeConfigs.length,
      catConfigs: p.catConfigs.length,
      debts: p.debts.length,
      snapshots: p.snapshots.length,
      reportSnapshots: p.reportSnapshots.length,
      aiAnalyses: p.aiAnalyses.length,
    },
  };
}


