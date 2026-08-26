/**
 * AI 数据包导出与结果导入（05 §3.28~§3.31，F-09/F-10，CHG-02 改动三）：
 * - GET    /ai/export        四分区文本（无快照时拒绝导出）
 * - POST   /ai/analyses      结果导入（按「## 结果格式」schema 逐字段校验；兼容中文字段名）
 * - GET    /ai/analyses      历史（按月过滤；payload 原样返回，不参与任何计算）
 * - DELETE /ai/analyses/:id  删除（报告快照中关联记录不再展示正文）
 * 权限：仅 admin（AI 页对只读账号不可见）。
 */
import { Hono } from 'hono';
import { idParam } from '../lib/validate';
import type { ErrorDetail } from '../lib/errors';
import { invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { isValidMonth } from '../lib/month';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { buildAiExportText } from '../services/aiText';
import { loadBundle } from '../services/snapshotRepo';

const ai = new Hono<AppEnv>();

// §3.28 四分区导出
ai.get('/export', requireAuth, requireAdmin, async (c) => {
  const month = c.req.query('month');
  if (!month || !isValidMonth(month)) throw invalidParam('month 参数必填且格式为 YYYY-MM');
  const bundle = await loadBundle(c.env.DB, month);
  if (!bundle) throw notFound(`${month} 尚无资产快照，请先录入数据再导出`);
  const text = await buildAiExportText(c.env.DB, bundle);
  return ok(c, { month, text });
});

const CN_KEY_MAP: Record<string, string> = {
  建议类型: 'type',
  目标模块: 'module',
  当前配置: 'current',
  建议方案: 'plan',
  理由: 'reason',
  优先级: 'priority',
};
const SUGGESTION_FIELDS = ['type', 'module', 'current', 'plan', 'reason', 'priority'] as const;
const FIELD_LABEL: Record<string, string> = {
  type: '建议类型',
  module: '目标模块',
  current: '当前配置',
  plan: '建议方案',
  reason: '理由',
  priority: '优先级',
};
const MAX_LEN: Record<string, number> = { type: 50, module: 50, current: 500, plan: 500, reason: 500, priority: 10 };

// §3.29 AI 结果导入
ai.post('/analyses', requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidParam('AI 结果 schema 校验失败，未保存', [{ field: 'payload', message: '请求体必须为 JSON 对象' }]);
  }
  const errors: ErrorDetail[] = [];

  // 顶层字段（兼容中文键名：分析日期/资产月份/优化建议）
  const analysisDate = body.analysisDate ?? body['分析日期'];
  const assetMonth = body.assetMonth ?? body['资产月份'];
  const rawSuggestions = body.suggestions ?? body['优化建议'];

  if (typeof analysisDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(analysisDate)) {
    errors.push({ field: 'analysisDate', message: `日期格式应为 YYYY-MM-DD，实际为 ${String(analysisDate)}` });
  } else {
    const d = new Date(`${analysisDate}T00:00:00Z`);
    const [y, m, day] = analysisDate.split('-').map(Number);
    if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) {
      errors.push({ field: 'analysisDate', message: `不是合法日期：${analysisDate}` });
    }
  }
  if (typeof assetMonth !== 'string' || !isValidMonth(assetMonth)) {
    errors.push({ field: 'assetMonth', message: `资产月份格式应为 YYYY-MM，实际为 ${String(assetMonth)}` });
  }
  if (!Array.isArray(rawSuggestions) || rawSuggestions.length === 0) {
    errors.push({ field: 'suggestions', message: '优化建议列表缺失或为空（至少 1 项）' });
  }

  // 逐条建议校验（兼容中文字段名）
  const suggestions: Record<string, string>[] = [];
  if (Array.isArray(rawSuggestions)) {
    rawSuggestions.forEach((raw, i) => {
      const f = `suggestions[${i}]`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push({ field: f, message: '建议项必须为对象' });
        return;
      }
      const src = raw as Record<string, unknown>;
      const normalized: Record<string, string> = {};
      for (const field of SUGGESTION_FIELDS) {
        const cnKey = Object.keys(CN_KEY_MAP).find((k) => CN_KEY_MAP[k] === field);
        const v = src[field] ?? (cnKey ? src[cnKey] : undefined);
        if (v === undefined || v === null || String(v).trim() === '') {
          errors.push({ field: `${f}.${field}`, message: `缺少必填字段 ${FIELD_LABEL[field]}（${field}）` });
          continue;
        }
        const s = String(v).trim();
        if (s.length > MAX_LEN[field]) {
          errors.push({ field: `${f}.${field}`, message: `${FIELD_LABEL[field]}（${field}）不能超过 ${MAX_LEN[field]} 字符` });
          continue;
        }
        normalized[field] = s;
      }
      if (normalized.priority !== undefined && !['高', '中', '低'].includes(normalized.priority)) {
        errors.push({ field: `${f}.priority`, message: `优先级取值必须为 高/中/低，实际为 ${normalized.priority}` });
        delete normalized.priority;
      }
      if (Object.keys(normalized).length === SUGGESTION_FIELDS.length) suggestions.push(normalized);
    });
  }

  if (errors.length > 0) throw invalidParam('AI 结果 schema 校验失败，未保存', errors);

  const now = new Date().toISOString();
  const payload = { analysisDate, assetMonth, suggestions };
  const res = await c.env.DB.prepare(
    'INSERT INTO ai_analyses (analysis_date, asset_month, payload_json, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(analysisDate as string, assetMonth as string, JSON.stringify(payload), now)
    .run();
  return ok(c, { id: Number(res.meta.last_row_id), analysisDate, assetMonth });
});

// §3.30 AI 分析历史
ai.get('/analyses', requireAuth, requireAdmin, async (c) => {
  const month = c.req.query('month');
  if (month && !isValidMonth(month)) throw invalidParam('month 格式应为 YYYY-MM');
  const sql = month
    ? 'SELECT * FROM ai_analyses WHERE asset_month = ? ORDER BY analysis_date DESC, id DESC'
    : 'SELECT * FROM ai_analyses ORDER BY analysis_date DESC, id DESC';
  const stmt = month ? c.env.DB.prepare(sql).bind(month) : c.env.DB.prepare(sql);
  const { results } = await stmt.all<{ id: number; analysis_date: string; asset_month: string; payload_json: string; created_at: string }>();
  const list = results.map((r) => {
    const payload = JSON.parse(r.payload_json) as { suggestions?: unknown[] };
    return {
      id: r.id,
      analysisDate: r.analysis_date,
      assetMonth: r.asset_month,
      createdAt: r.created_at,
      suggestionCount: Array.isArray(payload.suggestions) ? payload.suggestions.length : 0,
      payload,
    };
  });
  return ok(c, { list });
});

// §3.31 删除 AI 记录
ai.delete('/analyses/:id', requireAuth, requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'));
  const existing = await c.env.DB.prepare('SELECT id FROM ai_analyses WHERE id = ?').bind(id).first();
  if (!existing) throw notFound('AI 分析记录不存在');
  await c.env.DB.prepare('DELETE FROM ai_analyses WHERE id = ?').bind(id).run();
  return ok(c, {});
});

export default ai;
