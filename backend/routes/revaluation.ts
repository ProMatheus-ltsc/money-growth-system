/**
 * 公允价值重估 API（CPA 视角）：
 * - GET  /revaluation          查询重估记录列表（支持按节点筛选）
 * - POST /revaluation          新增重估记录
 * - GET  /revaluation/:id      查询单条重估详情
 * - DELETE /revaluation/:id    删除重估记录
 * 权限：admin 可写，viewer 可读。
 */
import { Hono } from 'hono';
import { invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';

interface RevaluationRow {
  id: number;
  node_id: number;
  revaluation_date: string;
  previous_value_cents: number;
  new_value_cents: number;
  change_cents: number;
  change_type: 'appreciation' | 'depreciation';
  reason: string | null;
  appraiser: string | null;
  created_by: number | null;
  created_at: string;
}

const revaluation = new Hono<AppEnv>();

revaluation.get('/', requireAuth, async (c) => {
  const nodeId = c.req.query('nodeId');
  let sql = 'SELECT * FROM asset_revaluations';
  const binds: unknown[] = [];
  if (nodeId) {
    sql += ' WHERE node_id = ?';
    binds.push(Number(nodeId));
  }
  sql += ' ORDER BY revaluation_date DESC, id DESC';
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const { results } = await stmt.all() as { results: RevaluationRow[] };
  return ok(c, {
    items: results.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      revaluationDate: r.revaluation_date,
      previousValue: r.previous_value_cents / 100,
      newValue: r.new_value_cents / 100,
      change: r.change_cents / 100,
      changeType: r.change_type,
      reason: r.reason,
      appraiser: r.appraiser,
      createdAt: r.created_at,
    })),
  });
});

revaluation.get('/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) throw invalidParam('id 必须为正整数');
  const row = await c.env.DB.prepare('SELECT * FROM asset_revaluations WHERE id = ?').bind(id).first<RevaluationRow>();
  if (!row) throw notFound('重估记录不存在');
  return ok(c, {
    id: row.id,
    nodeId: row.node_id,
    revaluationDate: row.revaluation_date,
    previousValue: row.previous_value_cents / 100,
    newValue: row.new_value_cents / 100,
    change: row.change_cents / 100,
    changeType: row.change_type,
    reason: row.reason,
    appraiser: row.appraiser,
    createdAt: row.created_at,
  });
});

revaluation.post('/', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) throw invalidParam('请求体必须为 JSON 对象');

  const nodeId = Number(body.nodeId);
  if (!Number.isInteger(nodeId) || nodeId < 1) throw invalidParam('nodeId 必须为正整数');

  const node = await c.env.DB.prepare('SELECT id, asset_category FROM tree_nodes WHERE id = ?').bind(nodeId).first<{ id: number; asset_category: string }>();
  if (!node) throw notFound('资产节点不存在');

  const revaluationDate = String(body.revaluationDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(revaluationDate)) throw invalidParam('revaluationDate 格式应为 YYYY-MM-DD');

  const previousValue = Number(body.previousValue);
  const newValue = Number(body.newValue);
  if (!Number.isFinite(previousValue) || previousValue < 0) throw invalidParam('previousValue 必须为非负数（单位：元）');
  if (!Number.isFinite(newValue) || newValue < 0) throw invalidParam('newValue 必须为非负数（单位：元）');

  const previousCents = Math.round(previousValue * 100);
  const newCents = Math.round(newValue * 100);
  const changeCents = newCents - previousCents;
  const changeType = changeCents >= 0 ? 'appreciation' : 'depreciation';

  const reason = body.reason ? String(body.reason) : null;
  const appraiser = body.appraiser ? String(body.appraiser) : null;
  const userId = c.get('user').id;

  const res = await c.env.DB.prepare(
    `INSERT INTO asset_revaluations (node_id, revaluation_date, previous_value_cents, new_value_cents, change_cents, change_type, reason, appraiser, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(nodeId, revaluationDate, previousCents, newCents, changeCents, changeType, reason, appraiser, userId).run();

  return ok(c, {
    id: Number(res.meta.last_row_id),
    nodeId,
    revaluationDate,
    previousValue,
    newValue,
    change: changeCents / 100,
    changeType,
  });
});

revaluation.delete('/:id', requireAuth, requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) throw invalidParam('id 必须为正整数');
  const existing = await c.env.DB.prepare('SELECT id FROM asset_revaluations WHERE id = ?').bind(id).first();
  if (!existing) throw notFound('重估记录不存在');
  await c.env.DB.prepare('DELETE FROM asset_revaluations WHERE id = ?').bind(id).run();
  return ok(c, { deleted: id });
});

export default revaluation;
