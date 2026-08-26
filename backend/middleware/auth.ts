/**
 * 认证与权限中间件（05 §1.4 权限矩阵，服务端逐端点强制）：
 * - requireAuth: Bearer token → sessions → users；401 UNAUTHORIZED
 * - requireAdmin: viewer 命中非白名单端点 → 403 FORBIDDEN（不产生任何数据变更）
 * 白名单编排放在路由层：viewer 可访问的路由仅挂 requireAuth，其余挂 requireAdmin。
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import type { Env } from '../env';
import { forbidden, unauthorized } from '../lib/errors';

export interface SessionUser {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  token: string;
}

/** 全应用统一 Hono 环境类型 */
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

/** 从请求 Authorization 头中提取 Bearer token（无效格式返回 null） */
export function parseToken(c: Context): string | null {
  const header = c.req.header('Authorization') ?? '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** 认证中间件：验证 Bearer token → 查询 sessions+users 表 → 注入 c.user；失败抛 401 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = parseToken(c);
  if (!token) throw unauthorized();
  const row = await c.env.DB.prepare(
    `SELECT s.expires_at, u.id AS user_id, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  )
    .bind(token)
    .first<{ expires_at: string; user_id: number; username: string; role: 'admin' | 'viewer' }>();
  if (!row || row.expires_at < new Date().toISOString()) throw unauthorized();
  c.set('user', { id: row.user_id, username: row.username, role: row.role, token });
  await next();
};

/** 管理员权限中间件：必须在 requireAuth 之后使用；viewer 角色抛 403 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') throw forbidden();
  await next();
};
