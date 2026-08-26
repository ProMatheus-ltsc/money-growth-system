/**
 * 报表聚合（05 §3.10/§3.11，F-04/F-04b）：
 * - GET /reports/assets   资产报表（投资表现视角，四图数据同源）
 * - GET /reports/finance  财务三张表（会计健康视角）
 * 权限：admin + viewer（只读可见）。
 */
import { Hono } from 'hono';
import { invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { isValidMonth } from '../lib/month';
import type { AppEnv } from '../middleware/auth';
import { requireAuth } from '../middleware/auth';
import { buildAssetReport, buildFinanceReport } from '../services/reportCore';
import { loadBundle } from '../services/snapshotRepo';

const reports = new Hono<AppEnv>();

// §3.10 资产报表聚合
reports.get('/assets', requireAuth, async (c) => {
  const month = c.req.query('month');
  if (!month || !isValidMonth(month)) throw invalidParam('month 参数必填且格式为 YYYY-MM');
  const bundle = await loadBundle(c.env.DB, month);
  if (!bundle) throw notFound(`${month} 尚无资产快照`);
  const data = await buildAssetReport(c.env.DB, bundle, c.req.query('range'), c.req.query('year') ?? null);
  return ok(c, data);
});

// §3.11 财务三张表
reports.get('/finance', requireAuth, async (c) => {
  const month = c.req.query('month');
  if (!month || !isValidMonth(month)) throw invalidParam('month 参数必填且格式为 YYYY-MM');
  const bundle = await loadBundle(c.env.DB, month);
  if (!bundle) throw notFound(`${month} 尚无资产快照`);
  const data = await buildFinanceReport(c.env.DB, bundle);
  return ok(c, data);
});

export default reports;
