/**
 * PDF 导出数据包（05 §3.32，F-11，决策 D6：只读账号可用）。
 * 后端仅提供聚合数据，不参与 PDF 生成（前端 html2canvas + jsPDF，04 §3.5）；
 * 文件名由前端按「财务报告-{YYYY-MM}.pdf」/「定期报告-{类型}-{期间}.pdf」生成。
 * 权限：admin + viewer。
 */
import { Hono } from 'hono';
import { invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { isValidMonth } from '../lib/month';
import type { AppEnv } from '../middleware/auth';
import { requireAuth } from '../middleware/auth';
import { buildAssetReport, buildFinanceReport, reportLabel } from '../services/reportCore';
import { loadBundle } from '../services/snapshotRepo';

const pdf = new Hono<AppEnv>();

pdf.get('/payload', requireAuth, async (c) => {
  const scope = c.req.query('scope');
  const now = new Date().toISOString();

  if (scope === 'month') {
    const month = c.req.query('month');
    if (!month || !isValidMonth(month)) throw invalidParam("scope='month' 时 month 必填且格式为 YYYY-MM");
    const bundle = await loadBundle(c.env.DB, month);
    if (!bundle) throw notFound(`${month} 尚无资产快照，无法导出`);
    const finance = await buildFinanceReport(c.env.DB, bundle);
    const asset = await buildAssetReport(c.env.DB, bundle, '12m', null);
    const { results: aiRows } = await c.env.DB.prepare('SELECT * FROM ai_analyses WHERE asset_month = ? ORDER BY analysis_date DESC')
      .bind(month)
      .all<{ id: number; analysis_date: string; asset_month: string; payload_json: string }>();
    return ok(c, {
      scope,
      month,
      title: `家庭财务报告 ${month}`,
      kpis: {
        totalAssets: finance.balanceSheet.kpi.totalAssets,
        netWorth: finance.balanceSheet.kpi.netWorth,
        debtRatio: finance.balanceSheet.kpi.debtRatio,
        balance: finance.incomeStatement.kpi.balance,
      },
      statements: finance,
      charts: { trend: asset.trend, treemap: asset.treemap, sankey: asset.sankey, debtDonut: finance.balanceSheet.debtDonut },
      aiRecords: aiRows.map((r) => ({ id: r.id, analysisDate: r.analysis_date, payload: JSON.parse(r.payload_json) })),
      meta: { generatedAt: now, unit: '元', noPII: true },
    });
  }

  if (scope === 'report') {
    const id = Number(c.req.query('id'));
    if (!Number.isInteger(id) || id <= 0) throw invalidParam("scope='report' 时 id 必填且为正整数");
    const r = await c.env.DB.prepare('SELECT * FROM report_snapshots WHERE id = ?').bind(id).first<{
      id: number; report_type: string; start_month: string; end_month: string; payload_json: string;
    }>();
    if (!r) throw notFound('报告快照不存在');
    const payload = JSON.parse(r.payload_json) as {
      kpis: unknown; charts: unknown; statements: unknown; details: unknown; aiRecordIds: number[];
    };
    const aiRecords: { id: number; analysisDate: string; payload: unknown }[] = [];
    for (const aiId of payload.aiRecordIds ?? []) {
      const row = await c.env.DB.prepare('SELECT * FROM ai_analyses WHERE id = ?').bind(aiId).first<{
        id: number; analysis_date: string; payload_json: string;
      }>();
      if (row) aiRecords.push({ id: row.id, analysisDate: row.analysis_date, payload: JSON.parse(row.payload_json) });
    }
    return ok(c, {
      scope,
      reportId: r.id,
      title: reportLabel(r.report_type, r.start_month),
      kpis: payload.kpis,
      statements: payload.statements,
      charts: payload.charts,
      aiRecords,
      meta: { generatedAt: now, unit: '元', noPII: true },
    });
  }

  throw invalidParam("scope 取值必须为 'month'/'report'");
});

export default pdf;
