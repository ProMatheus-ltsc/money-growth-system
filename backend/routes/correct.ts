/**
 * 历史快照纠错（05 §3.22，F-06）：
 * - 必须携带 confirmed: true（前端勾选确认项 + 服务端兜底）
 * - 请求体与 §3.9 相同；配置版本必须为原快照钉住版本（历史口径不可变）
 * - 写入成功后记录纠错日志（更正时间 + 前后差异摘要），其他月份不受影响
 * 权限：仅 admin。
 */
import { Hono } from 'hono';
import type { ErrorDetail } from '../lib/errors';
import { invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { addMonths, isValidMonth } from '../lib/month';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { catKeyPath, loadBundle, type SnapshotBundle } from '../services/snapshotRepo';
import { asObject, serverCurrentMonth, validateSnapshotInput, writeSnapshot, type SnapshotInput } from '../services/snapshotWriter';
import { nodeKeyPath } from '../services/treeUtil';

const correct = new Hono<AppEnv>();

/** 纠错窗口（自然月数）：仅支持最近 20 个月；快照永久保存，更早数据仅供查看 */
const CORRECT_WINDOW_MONTHS = 20;

function computeDiff(oldB: SnapshotBundle, fresh: SnapshotBundle): { field: string; before: unknown; after: unknown }[] {
  const diff: { field: string; before: unknown; after: unknown }[] = [];
  const yuan = (c: number) => c / 100;

  const oldAssets = new Map(oldB.assets.map((a) => [a.node_id, a]));
  for (const a of fresh.assets) {
    const o = oldAssets.get(a.node_id);
    const key = `assets[nodeId=${a.node_id}].balance`;
    if (!o) diff.push({ field: key, before: null, after: yuan(a.balance_cents) });
    else if (o.balance_cents !== a.balance_cents) diff.push({ field: key, before: yuan(o.balance_cents), after: yuan(a.balance_cents) });
  }
  const oldGains = new Map(oldB.gains.map((g) => [g.module_node_id, g]));
  for (const g of fresh.gains) {
    const o = oldGains.get(g.module_node_id);
    const key = `moduleGains[nodeId=${g.module_node_id}].gain`;
    const before = o && o.gain_cents !== null ? yuan(o.gain_cents) : null;
    const after = g.gain_cents !== null ? yuan(g.gain_cents) : null;
    if (before !== after) diff.push({ field: key, before, after });
  }
  const oldCats = new Map(oldB.catAmounts.map((x) => [x.cat_item_id, x]));
  for (const x of fresh.catAmounts) {
    const o = oldCats.get(x.cat_item_id);
    const name = catKeyPath(fresh.catItems, x.cat_item_id);
    const key = `catAmounts[${name}]`;
    if (!o) diff.push({ field: key, before: null, after: yuan(x.amount_cents) });
    else if (o.amount_cents !== x.amount_cents) diff.push({ field: key, before: yuan(o.amount_cents), after: yuan(x.amount_cents) });
  }
  const oldDebts = new Map(oldB.debtsSnap.map((x) => [x.debt_id, x]));
  for (const x of fresh.debtsSnap) {
    const o = oldDebts.get(x.debt_id);
    const name = fresh.debtsMaster.find((d) => d.id === x.debt_id)?.name ?? `#${x.debt_id}`;
    if (!o) {
      diff.push({ field: `debts[${name}].balance`, before: null, after: yuan(x.balance_cents) });
    } else {
      if (o.balance_cents !== x.balance_cents) diff.push({ field: `debts[${name}].balance`, before: yuan(o.balance_cents), after: yuan(x.balance_cents) });
      if (o.repayment_cents !== x.repayment_cents) diff.push({ field: `debts[${name}].repayment`, before: yuan(o.repayment_cents), after: yuan(x.repayment_cents) });
    }
  }
  const liKey = (x: { direction: string; name: string; amount_cents: number }) => `${x.direction}:${x.name}:${x.amount_cents}`;
  const oldLi = new Set(oldB.largeItems.map(liKey));
  for (const x of fresh.largeItems) if (!oldLi.has(liKey(x))) diff.push({ field: `largeItems[${x.name}]`, before: null, after: yuan(x.amount_cents) });
  const freshLi = new Set(fresh.largeItems.map(liKey));
  for (const x of oldB.largeItems) if (!freshLi.has(liKey(x))) diff.push({ field: `largeItems[${x.name}]`, before: yuan(x.amount_cents), after: null });

  // 兜底：汇总变化
  if (oldB.snapshot.total_assets_cents !== fresh.snapshot.total_assets_cents) {
    diff.push({ field: 'totals.totalAssets', before: yuan(oldB.snapshot.total_assets_cents), after: yuan(fresh.snapshot.total_assets_cents) });
  }
  return diff;
}

correct.post('/snapshots/:month/correct', requireAuth, requireAdmin, async (c) => {
  const month = c.req.param('month');
  if (!isValidMonth(month)) throw invalidParam('month 格式应为 YYYY-MM');
  const body = asObject(await c.req.json().catch(() => null)) as
    | (SnapshotInput & { confirmed?: unknown; snapshot?: unknown })
    | null;
  if (!body) throw invalidParam('请求体必须为 JSON 对象');
  if (body.confirmed !== true) throw invalidParam('未勾选确认项，纠错不予执行');

  const oldBundle = await loadBundle(c.env.DB, month);
  if (!oldBundle) throw notFound(`${month} 尚无快照，无需纠错`);
  if (month >= serverCurrentMonth()) throw invalidParam('当月数据请直接保存（PUT /api/snapshots/{month}），无需纠错');
  // 纠错窗口：仅最近 20 个自然月（含当月；快照永久保存，更早数据仅供查看）
  if (month < addMonths(serverCurrentMonth(), -(CORRECT_WINDOW_MONTHS - 1))) {
    throw invalidParam(`纠错仅支持最近 ${CORRECT_WINDOW_MONTHS} 个月；更早的快照永久保存，仅供查看`);
  }

  const snapshot = body.snapshot;
  const snapBody = asObject(snapshot);
  if (!snapBody) throw invalidParam('snapshot 为必填对象（结构与保存快照一致）');

  // 历史口径不可变：配置版本必须为原快照钉住版本
  const errors: ErrorDetail[] = [];
  if (snapBody.treeConfigId !== oldBundle.snapshot.tree_config_id) {
    errors.push({ field: 'snapshot.treeConfigId', message: '纠错必须沿用该月钉住的资产树配置版本（历史口径不可变）' });
  }
  if (snapBody.catConfigId !== oldBundle.snapshot.cat_config_id) {
    errors.push({ field: 'snapshot.catConfigId', message: '纠错必须沿用该月钉住的分类配置版本（历史口径不可变）' });
  }
  if (errors.length > 0) throw invalidParam('纠错参数校验失败', errors);

  const validated = await validateSnapshotInput(c.env.DB, month, snapBody, errors);
  if (!validated || errors.length > 0) throw invalidParam('快照校验失败', errors);

  await writeSnapshot(c.env.DB, month, validated);
  const correctedAt = new Date().toISOString();
  const freshBundle = await loadBundle(c.env.DB, month);
  const diff = computeDiff(oldBundle, freshBundle!);
  const user = c.get('user');
  // CR-003：corrected_at 更新与纠错日志写入并入单 batch（原子；避免日志失败则纠错无痕）
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE monthly_snapshots SET corrected_at = ? WHERE month = ?').bind(correctedAt, month),
    c.env.DB.prepare('INSERT INTO correction_logs (snapshot_id, corrected_at, diff_json, operator_id, operator_name) VALUES (?, ?, ?, ?, ?)')
      .bind(freshBundle!.snapshot.id, correctedAt, JSON.stringify(diff), user.id, user.username),
  ]);

  return ok(c, { month, correctedAt, diff });
});

export default correct;
