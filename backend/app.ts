/**
 * Hono 应用装配：/api/* 全部端点（05 §2 端点清单：P0 21 + P1 11）。
 * - 统一响应结构 {success, data, error}（05 §1.2）
 * - 错误码与 HTTP 状态映射（05 §1.3）：经 ApiError 中间件统一出口
 * - 权限在路由层逐端点挂载（05 §1.4 权限矩阵）
 */
import { Hono } from 'hono';
import type { AppEnv } from './middleware/auth';
import { ApiError } from './lib/errors';
import { fail } from './lib/http';
import auth from './routes/auth';
import tree from './routes/tree';
import snapshots from './routes/snapshots';
import reports from './routes/reports';
import debts from './routes/debts';
import catConfigs from './routes/catConfigs';
import reportSnapshots from './routes/reportSnapshots';
import correct from './routes/correct';
import backups from './routes/backups';
import ai from './routes/ai';
import pdf from './routes/pdf';
import depreciation from './routes/depreciation';
import health from './routes/health';
import revaluation from './routes/revaluation';
import contingentLiabilities from './routes/contingentLiabilities';

export const app = new Hono<AppEnv>();

// 错误统一出口（不向客户端泄露堆栈）
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return fail(c, err.code, err.message, err.status, err.details);
  }
  console.error('[api] unexpected error:', err);
  return fail(c, 'INTERNAL_ERROR', '服务端错误', 500);
});

// /api 之外的路径落静态层（Pages 行为）；/api 下未匹配路由返回统一 404
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return fail(c, 'NOT_FOUND', '接口不存在', 404);
  }
  return c.notFound();
});

app.route('/api/auth', auth); // §3.1~3.4 认证 4 端点
app.route('/api/tree', tree); // §3.5/3.6 资产树 2 端点
app.route('/api/snapshots', snapshots); // §3.7/3.8/3.9 快照 3 端点
app.route('/api/reports', reports); // §3.10/3.11 报表 2 端点
app.route('/api/debts', debts); // §3.12~3.15 负债 4 端点
app.route('/api/cat-configs', catConfigs); // §3.16/3.17 分类配置 2 端点
app.route('/api/report-snapshots', reportSnapshots); // §3.18~3.21 报告快照 4 端点
app.route('/api', correct); // §3.22 纠错 1 端点（/api/snapshots/:month/correct）
app.route('/api/backups', backups); // §3.23~3.27 备份 5 端点
app.route('/api/ai', ai); // §3.28~3.31 AI 4 端点
app.route('/api/pdf', pdf); // §3.32 PDF 数据包 1 端点
app.route('/api/depreciation', depreciation); // 实物资产折旧管理
app.route('/api/health', health); // CPA 财务健康指标
app.route('/api/revaluation', revaluation); // 公允价值重估
app.route('/api/contingent-liabilities', contingentLiabilities); // 或有负债披露
