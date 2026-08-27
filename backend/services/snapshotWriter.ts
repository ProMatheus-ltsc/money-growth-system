/**
 * 快照写入核心（05 §3.9）：校验 + 勾稽计算 + 事务写入。
 * 供 PUT /api/snapshots/{month}（当月）与 POST /api/snapshots/{month}/correct（历史纠错，§3.22）复用。
 *
 * 勾稽（服务端事务内派生）：总资产=Σ启用末级余额；总收入=Σ收入二级；总支出=Σ支出二级；
 * 净资产=总资产−总负债；结余=总收入−总支出；负债率=总负债/总资产。
 */
import type { Env } from '../env';
import type { ErrorDetail } from '../lib/errors';
import { yuanToCents } from '../lib/money';
import { addMonths, currentMonth } from '../lib/month';
import { getAllDebts, getCatItems, getSnapshotRow, getTreeNodes, leafCats } from './snapshotRepo';
import { descendantLeaves, enabledLeaves, topLevelModules } from './treeUtil';

export interface SnapshotInput {
  treeConfigId?: unknown;
  catConfigId?: unknown;
  assets?: unknown;
  moduleGains?: unknown;
  income?: unknown;
  expense?: unknown;
  largeItems?: unknown;
  debts?: unknown;
}

interface ValidatedSnapshot {
  treeConfigId: number;
  catConfigId: number;
  assets: { node_id: number; balance_cents: number; has_new_funds: number; update_source: string }[];
  gains: { module_node_id: number; gain_cents: number | null }[];
  income: { cat_item_id: number; amount_cents: number }[];
  expense: { cat_item_id: number; amount_cents: number }[];
  largeItems: { direction: string; cat_item_id: number; name: string; amount_cents: number }[];
  debts: { debt_id: number; balance_cents: number; repayment_cents: number }[];
  totals: {
    totalAssetsCents: number;
    totalDebtCents: number;
    totalIncomeCents: number;
    totalExpenseCents: number;
  };
}

/**
 * 校验快照请求体（配置版本的「最新/钉住」语义由路由层先行校验）。
 */
export async function validateSnapshotInput(
  db: Env['DB'],
  month: string,
  body: SnapshotInput,
  errors: ErrorDetail[]
): Promise<ValidatedSnapshot | null> {
  // ---- 配置版本 ----
  const treeConfigId = typeof body.treeConfigId === 'number' ? body.treeConfigId : null;
  const catConfigId = typeof body.catConfigId === 'number' ? body.catConfigId : null;
  if (treeConfigId === null) errors.push({ field: 'treeConfigId', message: 'treeConfigId 为必填项' });
  if (catConfigId === null) errors.push({ field: 'catConfigId', message: 'catConfigId 为必填项' });
  if (errors.length > 0) return null;

  const treeNodes = await getTreeNodes(db, treeConfigId!);
  const catItems = await getCatItems(db, catConfigId!);
  const catConfig = await db.prepare('SELECT * FROM cat_configs WHERE id = ?').bind(catConfigId!).first<{ threshold_cents: number }>();
  if (treeNodes.length === 0) errors.push({ field: 'treeConfigId', message: '资产树配置不存在' });
  if (catItems.length === 0 || !catConfig) errors.push({ field: 'catConfigId', message: '分类配置不存在' });
  if (errors.length > 0) return null;

  // ---- 资产末级 ----
  const leafSet = new Map(enabledLeaves(treeNodes).map((n) => [n.id, n]));
  const assetsOut: ValidatedSnapshot['assets'] = [];
  const seenNodes = new Set<number>();
  if (!Array.isArray(body.assets)) {
    errors.push({ field: 'assets', message: 'assets 为必填数组' });
  } else {
    for (let i = 0; i < body.assets.length; i++) {
      const a = body.assets[i] as Record<string, unknown>;
      const f = `assets[${i}]`;
      const nodeId = typeof a.nodeId === 'number' ? a.nodeId : null;
      if (nodeId === null || !leafSet.has(nodeId)) {
        errors.push({ field: `${f}.nodeId`, message: '节点不存在或不是启用末级节点' });
        continue;
      }
      if (seenNodes.has(nodeId)) {
        errors.push({ field: `${f}.nodeId`, message: `节点 ${nodeId} 重复录入` });
        continue;
      }
      seenNodes.add(nodeId);
      const balance = yuanToCents(a.balance, `${f}.balance`, errors, { label: '余额' });
      if (balance === null) continue;
      if (typeof a.hasNewFunds !== 'boolean') {
        errors.push({ field: `${f}.hasNewFunds`, message: 'hasNewFunds 必须为布尔值' });
        continue;
      }
      const us = a.updateSource;
      if (us !== 'current' && us !== 'carried') {
        errors.push({ field: `${f}.updateSource`, message: "updateSource 必须为 'current'/'carried'" });
        continue;
      }
      if (us === 'carried') {
        // carried 时 balance 必须等于该节点最近一次 'current' 录入值（防止误改，05 §3.9）
        const last = await db
          .prepare(
            `SELECT sa.balance_cents FROM snapshot_assets sa
             JOIN monthly_snapshots ms ON ms.id = sa.snapshot_id
             WHERE sa.node_id = ? AND sa.update_source = 'current' AND ms.month < ?
             ORDER BY ms.month DESC LIMIT 1`
          )
          .bind(nodeId, month)
          .first<{ balance_cents: number }>();
        if (!last) {
          errors.push({ field: `${f}.updateSource`, message: `节点 ${nodeId} 无可沿用的上期录入值` });
          continue;
        }
        if (last.balance_cents !== balance) {
          errors.push({ field: `${f}.balance`, message: `沿用上期时余额必须等于上次录入值（${last.balance_cents / 100} 元）` });
          continue;
        }
      }
      assetsOut.push({ node_id: nodeId, balance_cents: balance, has_new_funds: a.hasNewFunds ? 1 : 0, update_source: us });
    }
    for (const [id] of leafSet) {
      if (!seenNodes.has(id)) errors.push({ field: 'assets', message: `缺少启用末级节点的录入：nodeId=${id}` });
    }
  }

  // ---- 收益金额（每个标记新增资金的叶子节点各自一条） ----
  const gainsOut: ValidatedSnapshot['gains'] = [];
  const newFundLeafIds = new Set(assetsOut.filter((a) => a.has_new_funds === 1).map((a) => a.node_id));
  if (body.moduleGains !== undefined && body.moduleGains !== null) {
    if (!Array.isArray(body.moduleGains)) {
      errors.push({ field: 'moduleGains', message: 'moduleGains 必须为数组' });
    } else {
      const seenNodes = new Set<number>();
      for (let i = 0; i < body.moduleGains.length; i++) {
        const g = body.moduleGains[i] as Record<string, unknown>;
        const f = `moduleGains[${i}]`;
        const nodeId = typeof g.nodeId === 'number' ? g.nodeId : null;
        if (nodeId === null || !newFundLeafIds.has(nodeId)) {
          errors.push({ field: `${f}.nodeId`, message: 'nodeId 必须为标记了新增资金的叶子节点' });
          continue;
        }
        if (seenNodes.has(nodeId)) {
          errors.push({ field: `${f}.nodeId`, message: '每个叶子节点至多一条收益金额' });
          continue;
        }
        seenNodes.add(nodeId);
        if (g.gain === null || g.gain === undefined) {
          gainsOut.push({ module_node_id: nodeId, gain_cents: null });
        } else {
          const cents = yuanToCents(g.gain, `${f}.gain`, errors, { min: -Infinity, label: '收益金额' });
          if (cents === null) continue;
          gainsOut.push({ module_node_id: nodeId, gain_cents: cents });
        }
      }
    }
  }

  // ---- 收支二级分类 ----
  const leafIncome = new Map(leafCats(catItems, 'income').map((c) => [c.id, c]));
  const leafExpense = new Map(leafCats(catItems, 'expense').map((c) => [c.id, c]));
  const parseCatAmounts = (
    arr: unknown,
    field: 'income' | 'expense',
    valid: Map<number, { id: number }>
  ): { cat_item_id: number; amount_cents: number }[] => {
    const out: { cat_item_id: number; amount_cents: number }[] = [];
    if (!Array.isArray(arr)) {
      errors.push({ field, message: `${field} 为必填数组` });
      return out;
    }
    const seen = new Set<number>();
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i] as Record<string, unknown>;
      const f = `${field}[${i}]`;
      const catItemId = typeof it.catItemId === 'number' ? it.catItemId : null;
      if (catItemId === null || !valid.has(catItemId)) {
        errors.push({ field: `${f}.catItemId`, message: '分类不存在或不是二级（叶子）分类，或方向不匹配' });
        continue;
      }
      if (seen.has(catItemId)) {
        errors.push({ field: `${f}.catItemId`, message: '分类重复录入' });
        continue;
      }
      seen.add(catItemId);
      const amount = yuanToCents(it.amount, `${f}.amount`, errors, { label: '金额' });
      if (amount === null) continue;
      out.push({ cat_item_id: catItemId, amount_cents: amount });
    }
    return out;
  };
  const incomeOut = parseCatAmounts(body.income, 'income', leafIncome);
  const expenseOut = parseCatAmounts(body.expense, 'expense', leafExpense);

  // ---- 大额单笔（决策 D9：仅校验 ≥ 阈值） ----
  const largeOut: ValidatedSnapshot['largeItems'] = [];
  if (body.largeItems !== undefined && body.largeItems !== null) {
    if (!Array.isArray(body.largeItems)) {
      errors.push({ field: 'largeItems', message: 'largeItems 必须为数组' });
    } else {
      const threshold = catConfig!.threshold_cents;
      for (let i = 0; i < body.largeItems.length; i++) {
        const it = body.largeItems[i] as Record<string, unknown>;
        const f = `largeItems[${i}]`;
        const direction = it.direction === 'income' || it.direction === 'expense' ? it.direction : null;
        if (!direction) {
          errors.push({ field: `${f}.direction`, message: "direction 必须为 'income'/'expense'" });
          continue;
        }
        const valid = direction === 'income' ? leafIncome : leafExpense;
        const catItemId = typeof it.catItemId === 'number' ? it.catItemId : null;
        if (catItemId === null || !valid.has(catItemId)) {
          errors.push({ field: `${f}.catItemId`, message: '所属二级分类不存在或方向不一致' });
          continue;
        }
        const name = typeof it.name === 'string' ? it.name.trim() : '';
        if (name.length < 1 || name.length > 50) {
          errors.push({ field: `${f}.name`, message: '名称须为 1~50 字符' });
          continue;
        }
        const amount = yuanToCents(it.amount, `${f}.amount`, errors, { label: '金额' });
        if (amount === null) continue;
        if (amount < threshold) {
          errors.push({
            field: `${f}.amount`,
            message: `单笔金额 ${amount / 100} 元低于阈值 ${threshold / 100} 元，不予记录`,
          });
          continue;
        }
        largeOut.push({ direction, cat_item_id: catItemId, name, amount_cents: amount });
      }
    }
  }

  // ---- 负债 ----
  const debtsMaster = await getAllDebts(db);
  const enabledDebts = debtsMaster.filter((d) => d.enabled === 1);
  const debtsOut: ValidatedSnapshot['debts'] = [];
  if (!Array.isArray(body.debts)) {
    errors.push({ field: 'debts', message: 'debts 为必填数组' });
  } else {
    const seen = new Set<number>();
    for (let i = 0; i < body.debts.length; i++) {
      const it = body.debts[i] as Record<string, unknown>;
      const f = `debts[${i}]`;
      const debtId = typeof it.debtId === 'number' ? it.debtId : null;
      const master = debtId !== null ? debtsMaster.find((d) => d.id === debtId) : undefined;
      if (!master) {
        errors.push({ field: `${f}.debtId`, message: '负债项不存在' });
        continue;
      }
      if (seen.has(master.id)) {
        errors.push({ field: `${f}.debtId`, message: '负债项重复录入' });
        continue;
      }
      seen.add(master.id);
      const balance = yuanToCents(it.balance, `${f}.balance`, errors, { label: '负债余额' });
      if (balance === null) continue;
      let repaymentCents: number;
      if (master.fixed_repayment === 1) {
        // 固定还款：忽略客户端值，服务端按定额填（F-02c 规则 2）
        repaymentCents = master.monthly_payment_cents;
      } else {
        const r = yuanToCents(it.repayment, `${f}.repayment`, errors, {
          required: true,
          label: '非固定还款的当月还款额',
        });
        if (r === null) continue;
        repaymentCents = r;
      }
      debtsOut.push({ debt_id: master.id, balance_cents: balance, repayment_cents: repaymentCents });
    }
    for (const d of enabledDebts) {
      if (!seen.has(d.id)) errors.push({ field: 'debts', message: `缺少启用负债项的录入：debtId=${d.id}` });
    }
  }

  if (errors.length > 0) return null;

  const totalAssetsCents = assetsOut.reduce((s, a) => s + a.balance_cents, 0);
  const totalIncomeCents = incomeOut.reduce((s, a) => s + a.amount_cents, 0);
  const totalExpenseCents = expenseOut.reduce((s, a) => s + a.amount_cents, 0);
  const totalDebtCents = debtsOut.reduce((s, d) => s + d.balance_cents, 0);

  return {
    treeConfigId: treeConfigId!,
    catConfigId: catConfigId!,
    assets: assetsOut,
    gains: gainsOut,
    income: incomeOut,
    expense: expenseOut,
    largeItems: largeOut,
    debts: debtsOut,
    totals: { totalAssetsCents, totalDebtCents, totalIncomeCents, totalExpenseCents },
  };
}

/**
 * 写入快照（新增或覆盖，D1 batch = 单事务）。返回写入后的汇总（元）。
 */
export async function writeSnapshot(db: Env['DB'], month: string, v: ValidatedSnapshot) {
  const now = new Date().toISOString();
  const existing = await getSnapshotRow(db, month);
  let snapshotId: number;

  if (existing) {
    snapshotId = existing.id;
    const stmts: ReturnType<Env['DB']['prepare']>[] = [
      db.prepare('DELETE FROM snapshot_large_items WHERE snapshot_id = ?').bind(snapshotId),
      db.prepare('DELETE FROM snapshot_cat_amounts WHERE snapshot_id = ?').bind(snapshotId),
      db.prepare('DELETE FROM snapshot_debts WHERE snapshot_id = ?').bind(snapshotId),
      db.prepare('DELETE FROM snapshot_gains WHERE snapshot_id = ?').bind(snapshotId),
      db.prepare('DELETE FROM snapshot_assets WHERE snapshot_id = ?').bind(snapshotId),
      db
        .prepare(
          `UPDATE monthly_snapshots SET tree_config_id = ?, cat_config_id = ?,
           total_assets_cents = ?, total_debt_cents = ?, total_income_cents = ?, total_expense_cents = ?,
           updated_at = ? WHERE id = ?`
        )
        .bind(
          v.treeConfigId,
          v.catConfigId,
          v.totals.totalAssetsCents,
          v.totals.totalDebtCents,
          v.totals.totalIncomeCents,
          v.totals.totalExpenseCents,
          now,
          snapshotId
        ),
      ...detailInsertStmts(db, snapshotId, v, now),
      ...debtSyncStmts(db, v, now),
    ];
    await db.batch(stmts);
  } else {
    // CR-003：主表行先插（须取 last_row_id），明细 + 负债主档同步并入单 batch（原子）；
    // 明细失败时补偿删除主表行，不留脏快照。
    const res = await db
      .prepare(
        `INSERT INTO monthly_snapshots (month, tree_config_id, cat_config_id, total_assets_cents, total_debt_cents,
         total_income_cents, total_expense_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        month,
        v.treeConfigId,
        v.catConfigId,
        v.totals.totalAssetsCents,
        v.totals.totalDebtCents,
        v.totals.totalIncomeCents,
        v.totals.totalExpenseCents,
        now,
        now
      )
      .run();
    snapshotId = Number(res.meta.last_row_id);
    const stmts = [...detailInsertStmts(db, snapshotId, v, now), ...debtSyncStmts(db, v, now)];
    try {
      if (stmts.length > 0) await db.batch(stmts);
    } catch (e) {
      await db
        .prepare('DELETE FROM monthly_snapshots WHERE id = ?')
        .bind(snapshotId)
        .run()
        .catch(() => undefined);
      throw e;
    }
  }

  const t = v.totals;
  return {
    month,
    treeConfigId: v.treeConfigId,
    catConfigId: v.catConfigId,
    totals: {
      totalAssets: t.totalAssetsCents / 100,
      totalDebt: t.totalDebtCents / 100,
      netWorth: (t.totalAssetsCents - t.totalDebtCents) / 100,
      debtRatio: t.totalAssetsCents > 0 ? Math.round((t.totalDebtCents / t.totalAssetsCents) * 10000) / 10000 : null,
      totalIncome: t.totalIncomeCents / 100,
      totalExpense: t.totalExpenseCents / 100,
      balance: (t.totalIncomeCents - t.totalExpenseCents) / 100,
    },
    updatedAt: now,
  };
}

/** 负债主档余额同步语句（04 §4.2：保存快照时由服务端同步为最新月余额） */
function debtSyncStmts(db: Env['DB'], v: ValidatedSnapshot, now: string) {
  return v.debts.map((d) =>
    db.prepare('UPDATE debts SET balance_cents = ?, updated_at = ? WHERE id = ?').bind(d.balance_cents, now, d.debt_id)
  );
}

/** D1/SQLite 单条语句最多绑定变量数（保守值，官方上限 999） */
const MAX_BIND_VARS = 900;

/** 将大数组按 cols 列数拆分为多条 INSERT，每条不超过 MAX_BIND_VARS 个绑定变量 */
function chunkedInsert<T>(
  db: Env['DB'],
  sql: string,
  cols: number,
  rows: T[],
  mapper: (row: T) => unknown[]
): ReturnType<Env['DB']['prepare']>[] {
  if (rows.length === 0) return [];
  const chunkSize = Math.floor(MAX_BIND_VARS / cols);
  const stmts: ReturnType<Env['DB']['prepare']>[] = [];
  const values = (n: number, c: number) => Array(n).fill(`(${Array(c).fill('?').join(',')})`).join(',');
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    stmts.push(
      db.prepare(`${sql} VALUES ${values(chunk.length, cols)}`).bind(...chunk.flatMap(mapper))
    );
  }
  return stmts;
}

/** 明细多行 VALUES 语句（自动按 D1 变量上限拆分） */
function detailInsertStmts(db: Env['DB'], snapshotId: number, v: ValidatedSnapshot, now: string) {
  const stmts: ReturnType<Env['DB']['prepare']>[] = [];
  stmts.push(...chunkedInsert(
    db,
    'INSERT INTO snapshot_assets (snapshot_id, node_id, balance_cents, has_new_funds, update_source)',
    5,
    v.assets,
    (a) => [snapshotId, a.node_id, a.balance_cents, a.has_new_funds, a.update_source]
  ));
  stmts.push(...chunkedInsert(
    db,
    'INSERT INTO snapshot_gains (snapshot_id, module_node_id, gain_cents)',
    3,
    v.gains,
    (g) => [snapshotId, g.module_node_id, g.gain_cents]
  ));
  stmts.push(...chunkedInsert(
    db,
    'INSERT INTO snapshot_debts (snapshot_id, debt_id, balance_cents, repayment_cents)',
    4,
    v.debts,
    (d) => [snapshotId, d.debt_id, d.balance_cents, d.repayment_cents]
  ));
  const catAll = [...v.income, ...v.expense];
  stmts.push(...chunkedInsert(
    db,
    'INSERT INTO snapshot_cat_amounts (snapshot_id, cat_item_id, amount_cents)',
    3,
    catAll,
    (x) => [snapshotId, x.cat_item_id, x.amount_cents]
  ));
  stmts.push(...chunkedInsert(
    db,
    'INSERT INTO snapshot_large_items (snapshot_id, direction, cat_item_id, name, amount_cents, created_at)',
    6,
    v.largeItems,
    (x) => [snapshotId, x.direction, x.cat_item_id, x.name, x.amount_cents, now]
  ));
  return stmts;
}

/** 当前月（服务端权威，Asia/Shanghai） */
export function serverCurrentMonth(): string {
  return currentMonth();
}

export function prevMonthOf(month: string): string {
  return addMonths(month, -1);
}

/** 路由层小工具：校验请求体是否为对象 */
export function asObject(body: unknown): SnapshotInput | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as SnapshotInput) : null;
}
