/**
 * 负债管理（05 §3.12~§3.15，F-02c）：
 * - GET    /debts      列表与汇总（月还款合计 = 固定按定额 + 非固定按当月实录）
 * - POST   /debts      新增（固定还款开关默认 true）
 * - PUT    /debts/:id  编辑（固定/非固定切换不回改历史，决策 D8）
 * - DELETE /debts/:id  删除（存在历史快照引用时拒绝，改停用）
 * 权限：仅 admin（viewer 的负债数据经 reports/finance 返回）。
 */
import { Hono } from 'hono';
import type { ErrorDetail } from '../lib/errors';
import { conflict, invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { centsToYuan, round4, yuanToCents } from '../lib/money';
import { isValidMonth } from '../lib/month';
import { boolField, intField, strField, idParam } from '../lib/validate';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { getAllDebts, loadBundle } from '../services/snapshotRepo';

const debts = new Hono<AppEnv>();

const DEBT_TYPES = ['mortgage', 'auto_loan', 'credit_card', 'other'] as const;
const TERMS = ['short', 'long'] as const;

// §3.12 负债列表与汇总
debts.get('/', requireAuth, requireAdmin, async (c) => {
  const monthQ = c.req.query('month');
  const all = await getAllDebts(c.env.DB);
  const latestSnap = await c.env.DB.prepare('SELECT MAX(month) AS m FROM monthly_snapshots').first<{ m: string | null }>();
  const month = monthQ && isValidMonth(monthQ) ? monthQ : latestSnap?.m ?? null;
  if (monthQ && !isValidMonth(monthQ)) throw invalidParam('month 格式应为 YYYY-MM');

  const bundle = month ? await loadBundle(c.env.DB, month) : null;
  const list = all.map((d) => {
    const sd = bundle?.debtsSnap.find((x) => x.debt_id === d.id);
    const monthBalance = sd ? sd.balance_cents : d.balance_cents;
    let monthRepayment: number | null;
    if (d.fixed_repayment === 1) monthRepayment = centsToYuan(d.monthly_payment_cents);
    else monthRepayment = sd ? centsToYuan(sd.repayment_cents) : null;
    return {
      id: d.id,
      name: d.name,
      debtType: d.debt_type,
      term: d.term,
      annualRate: d.annual_rate,
      monthlyPayment: centsToYuan(d.monthly_payment_cents),
      fixedRepayment: d.fixed_repayment === 1,
      enabled: d.enabled === 1,
      monthBalance: centsToYuan(monthBalance),
      monthRepayment,
      _sort: d.sort_order,
      _balanceCents: monthBalance,
    };
  });

  const enabled = list.filter((d) => d.enabled);
  const totalDebt = enabled.reduce((s, d) => s + d._balanceCents, 0);
  const shortTermDebt = enabled.filter((d) => d.term === 'short').reduce((s, d) => s + d._balanceCents, 0);
  const longTermDebt = totalDebt - shortTermDebt;
  const monthlyRepayment = enabled.reduce((s, d) => {
    if (d.fixedRepayment) return s + d.monthlyPayment;
    return s + (d.monthRepayment ?? 0);
  }, 0);
  const totalAssets = bundle?.snapshot.total_assets_cents ?? null;

  return ok(c, {
    debts: list.map(({ _sort, _balanceCents, ...rest }) => rest),
    totals: {
      totalDebt: centsToYuan(totalDebt),
      shortTermDebt: centsToYuan(shortTermDebt),
      longTermDebt: centsToYuan(longTermDebt),
      debtRatio: totalAssets && totalAssets > 0 ? round4(totalDebt / totalAssets) : null,
      monthlyRepayment,
      netWorth: totalAssets !== null ? centsToYuan(totalAssets - totalDebt) : null,
    },
  });
});

// §3.13 新增负债
debts.post('/', requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw invalidParam('请求体必须为 JSON 对象');
  const errors: ErrorDetail[] = [];
  const name = strField(body.name, 'name', errors, { max: 30, label: '负债名称' });
  const debtType = body.debtType;
  if (!(DEBT_TYPES as readonly string[]).includes(String(debtType))) {
    errors.push({ field: 'debtType', message: "debtType 必须为 'mortgage'/'auto_loan'/'credit_card'/'other'" });
  }
  const term = body.term;
  if (!(TERMS as readonly string[]).includes(String(term))) {
    errors.push({ field: 'term', message: "term 必须为 'short'/'long'" });
  }
  const balance = yuanToCents(body.balance, 'balance', errors, { label: '当前余额' });
  const annualRate = typeof body.annualRate === 'number' && Number.isFinite(body.annualRate) && body.annualRate >= 0 && body.annualRate <= 1
    ? body.annualRate
    : (errors.push({ field: 'annualRate', message: 'annualRate 须为 0~1 的小数' }), null);
  const monthlyPayment = yuanToCents(body.monthlyPayment, 'monthlyPayment', errors, { label: '月还款额' });
  const fixedRepayment = boolField(body.fixedRepayment, 'fixedRepayment', errors, true);
  if (errors.length > 0) throw invalidParam('负债参数校验失败', errors);

  const now = new Date().toISOString();
  const maxSort = await c.env.DB.prepare('SELECT MAX(sort_order) AS s FROM debts').first<{ s: number | null }>();
  const res = await c.env.DB.prepare(
    `INSERT INTO debts (name, debt_type, term, balance_cents, annual_rate, monthly_payment_cents, fixed_repayment, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(name, debtType as string, term as string, balance, annualRate, monthlyPayment, fixedRepayment ? 1 : 0, (maxSort?.s ?? -1) + 1, now, now)
    .run();
  return ok(c, { id: Number(res.meta.last_row_id), createdAt: now });
});

// §3.14 编辑负债（局部更新；固定/非固定切换不回改历史）
debts.put('/:id', requireAuth, requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'));
  const existing = await c.env.DB.prepare('SELECT * FROM debts WHERE id = ?').bind(id).first<{
    id: number; name: string; debt_type: string; term: string; balance_cents: number; annual_rate: number;
    monthly_payment_cents: number; fixed_repayment: number; enabled: number; sort_order: number;
  }>();
  if (!existing) throw notFound('负债项不存在');

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw invalidParam('请求体必须为 JSON 对象');
  const errors: ErrorDetail[] = [];

  const name = body.name !== undefined ? strField(body.name, 'name', errors, { max: 30, label: '负债名称' }) : existing.name;
  const debtType = body.debtType !== undefined
    ? (DEBT_TYPES as readonly string[]).includes(String(body.debtType))
      ? String(body.debtType)
      : (errors.push({ field: 'debtType', message: "debtType 必须为 'mortgage'/'auto_loan'/'credit_card'/'other'" }), existing.debt_type)
    : existing.debt_type;
  const term = body.term !== undefined
    ? (TERMS as readonly string[]).includes(String(body.term))
      ? String(body.term)
      : (errors.push({ field: 'term', message: "term 必须为 'short'/'long'" }), existing.term)
    : existing.term;
  const balance = body.balance !== undefined ? yuanToCents(body.balance, 'balance', errors, { label: '当前余额' }) : existing.balance_cents;
  const annualRate = body.annualRate !== undefined
    ? (typeof body.annualRate === 'number' && Number.isFinite(body.annualRate) && body.annualRate >= 0 && body.annualRate <= 1
        ? body.annualRate
        : (errors.push({ field: 'annualRate', message: 'annualRate 须为 0~1 的小数' }), existing.annual_rate))
    : existing.annual_rate;
  const monthlyPayment = body.monthlyPayment !== undefined
    ? yuanToCents(body.monthlyPayment, 'monthlyPayment', errors, { label: '月还款额' })
    : existing.monthly_payment_cents;
  const fixedRepayment = body.fixedRepayment !== undefined ? boolField(body.fixedRepayment, 'fixedRepayment', errors, true) : existing.fixed_repayment === 1;
  const enabled = body.enabled !== undefined ? boolField(body.enabled, 'enabled', errors, true) : existing.enabled === 1;
  const sortOrder = body.sortOrder !== undefined ? intField(body.sortOrder, 'sortOrder', errors, { min: 0 }) ?? existing.sort_order : existing.sort_order;
  if (errors.length > 0) throw invalidParam('负债参数校验失败', errors);

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE debts SET name = ?, debt_type = ?, term = ?, balance_cents = ?, annual_rate = ?,
     monthly_payment_cents = ?, fixed_repayment = ?, enabled = ?, sort_order = ?, updated_at = ? WHERE id = ?`
  )
    .bind(name, debtType, term, balance, annualRate, monthlyPayment, fixedRepayment ? 1 : 0, enabled ? 1 : 0, sortOrder, now, id)
    .run();
  return ok(c, { id, updatedAt: now });
});

// §3.15 删除负债（有历史快照引用拒绝，保护历史勾稽）
debts.delete('/:id', requireAuth, requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'));
  const existing = await c.env.DB.prepare('SELECT id FROM debts WHERE id = ?').bind(id).first();
  if (!existing) throw notFound('负债项不存在');
  const ref = await c.env.DB.prepare('SELECT COUNT(*) AS cnt FROM snapshot_debts WHERE debt_id = ?').bind(id).first<{ cnt: number }>();
  if ((ref?.cnt ?? 0) > 0) throw conflict('该负债存在历史快照记录，不能删除，请改用停用');
  await c.env.DB.prepare('DELETE FROM debts WHERE id = ?').bind(id).run();
  return ok(c, {});
});

export default debts;
