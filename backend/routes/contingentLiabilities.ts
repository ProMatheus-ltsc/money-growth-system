/**
 * 或有负债披露 API（CPA 视角）：
 * - GET    /contingent-liabilities         查询或有负债列表
 * - POST   /contingent-liabilities         新增或有负债
 * - PUT    /contingent-liabilities/:id     更新或有负债
 * - DELETE /contingent-liabilities/:id     删除或有负债
 *
 * CPA 要求：担保、诉讼等或有负债不计入负债总额，但在报表附注中披露。
 * 权限：admin 可写，viewer 可读。
 */
import { Hono } from 'hono';
import { idParam } from '../lib/validate';
import { invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';

interface ContingentLiabilityRow {
  id: number;
  name: string;
  liability_type: 'guarantee' | 'litigation' | 'commitment' | 'other';
  estimated_amount_cents: number;
  probability: 'probable' | 'possible' | 'remote';
  counterparty: string | null;
  start_date: string | null;
  expiry_date: string | null;
  description: string | null;
  status: 'active' | 'resolved' | 'expired';
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

const TYPES = ['guarantee', 'litigation', 'commitment', 'other'] as const;
const PROBS = ['probable', 'possible', 'remote'] as const;
const STATUSES = ['active', 'resolved', 'expired'] as const;

const contingent = new Hono<AppEnv>();

function rowToDto(r: ContingentLiabilityRow) {
  return {
    id: r.id,
    name: r.name,
    liabilityType: r.liability_type,
    estimatedAmount: r.estimated_amount_cents / 100,
    probability: r.probability,
    counterparty: r.counterparty,
    startDate: r.start_date,
    expiryDate: r.expiry_date,
    description: r.description,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

contingent.get('/', requireAuth, async (c) => {
  const status = c.req.query('status');
  let sql = 'SELECT * FROM contingent_liabilities';
  const binds: unknown[] = [];
  if (status && (STATUSES as readonly string[]).includes(status)) {
    sql += ' WHERE status = ?';
    binds.push(status);
  }
  sql += ' ORDER BY created_at DESC';
  const stmt = binds.length > 0 ? c.env.DB.prepare(sql).bind(...binds) : c.env.DB.prepare(sql);
  const { results } = await stmt.all() as { results: ContingentLiabilityRow[] };
  const totalEstimated = results.filter((r: ContingentLiabilityRow) => r.status === 'active').reduce((s: number, r: ContingentLiabilityRow) => s + r.estimated_amount_cents, 0);
  return ok(c, {
    items: results.map(rowToDto),
    summary: {
      total: results.length,
      activeCount: results.filter((r: ContingentLiabilityRow) => r.status === 'active').length,
      totalEstimatedAmount: totalEstimated / 100,
    },
  });
});

contingent.post('/', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) throw invalidParam('请求体必须为 JSON 对象');

  const name = String(body.name ?? '').trim();
  if (!name) throw invalidParam('name 不能为空');
  if (name.length > 100) throw invalidParam('name 长度不超过 100');

  const liabilityType = String(body.liabilityType ?? '');
  if (!(TYPES as readonly string[]).includes(liabilityType)) throw invalidParam('liabilityType 须为 guarantee/litigation/commitment/other');

  const estimatedAmount = Number(body.estimatedAmount ?? 0);
  if (!Number.isFinite(estimatedAmount) || estimatedAmount < 0) throw invalidParam('estimatedAmount 必须为非负数（单位：元）');

  const probability = String(body.probability ?? 'possible');
  if (!(PROBS as readonly string[]).includes(probability)) throw invalidParam('probability 须为 probable/possible/remote');

  const counterparty = body.counterparty ? String(body.counterparty).slice(0, 100) : null;
  const startDate = body.startDate ? String(body.startDate) : null;
  const expiryDate = body.expiryDate ? String(body.expiryDate) : null;
  const description = body.description ? String(body.description).slice(0, 500) : null;
  const userId = c.get('user').id;
  const now = new Date().toISOString();

  const res = await c.env.DB.prepare(
    `INSERT INTO contingent_liabilities (name, liability_type, estimated_amount_cents, probability, counterparty, start_date, expiry_date, description, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).bind(name, liabilityType, Math.round(estimatedAmount * 100), probability, counterparty, startDate, expiryDate, description, userId, now, now).run();

  return ok(c, { id: Number(res.meta.last_row_id), name, liabilityType });
});

contingent.put('/:id', requireAuth, requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) throw invalidParam('id 必须为正整数');

  const existing = await c.env.DB.prepare('SELECT * FROM contingent_liabilities WHERE id = ?').bind(id).first<ContingentLiabilityRow>();
  if (!existing) throw notFound('或有负债记录不存在');

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) throw invalidParam('请求体必须为 JSON 对象');

  const name = body.name !== undefined ? String(body.name).trim() : existing.name;
  if (!name || name.length > 100) throw invalidParam('name 不能为空且长度不超过 100');

  const liabilityType = body.liabilityType !== undefined ? String(body.liabilityType) : existing.liability_type;
  if (!(TYPES as readonly string[]).includes(liabilityType)) throw invalidParam('liabilityType 须为 guarantee/litigation/commitment/other');

  const estimatedAmount = body.estimatedAmount !== undefined ? Number(body.estimatedAmount) : existing.estimated_amount_cents / 100;
  if (!Number.isFinite(estimatedAmount) || estimatedAmount < 0) throw invalidParam('estimatedAmount 必须为非负数');

  const probability = body.probability !== undefined ? String(body.probability) : existing.probability;
  if (!(PROBS as readonly string[]).includes(probability)) throw invalidParam('probability 须为 probable/possible/remote');

  const status = body.status !== undefined ? String(body.status) : existing.status;
  if (!(STATUSES as readonly string[]).includes(status)) throw invalidParam('status 须为 active/resolved/expired');

  const counterparty = body.counterparty !== undefined ? (body.counterparty ? String(body.counterparty).slice(0, 100) : null) : existing.counterparty;
  const startDate = body.startDate !== undefined ? (body.startDate ? String(body.startDate) : null) : existing.start_date;
  const expiryDate = body.expiryDate !== undefined ? (body.expiryDate ? String(body.expiryDate) : null) : existing.expiry_date;
  const description = body.description !== undefined ? (body.description ? String(body.description).slice(0, 500) : null) : existing.description;
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `UPDATE contingent_liabilities SET name=?, liability_type=?, estimated_amount_cents=?, probability=?, counterparty=?, start_date=?, expiry_date=?, description=?, status=?, updated_at=? WHERE id=?`
  ).bind(name, liabilityType, Math.round(estimatedAmount * 100), probability, counterparty, startDate, expiryDate, description, status, now, id).run();

  return ok(c, { id, name, status });
});

contingent.delete('/:id', requireAuth, requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) throw invalidParam('id 必须为正整数');
  const existing = await c.env.DB.prepare('SELECT id FROM contingent_liabilities WHERE id = ?').bind(id).first();
  if (!existing) throw notFound('或有负债记录不存在');
  await c.env.DB.prepare('DELETE FROM contingent_liabilities WHERE id = ?').bind(id).run();
  return ok(c, { deleted: id });
});

export default contingent;
