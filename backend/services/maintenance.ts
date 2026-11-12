/**
 * 认证相关运维清理（惰性，无定时任务依赖）：
 * - sessions：已过期的登录令牌（7 天 TTL）无保留价值；
 * - gate_tokens：已过期的邀请码短期凭证（10 分钟 TTL）；
 * - ip_rate_limit：失败计数已「冷却」的陈旧行（未被锁定且最后一次尝试早于阈值），
 *   使其失败计数自然归零，避免历史 IP 记录无限堆积。
 * - login_audit_log：审计留痕按保留期裁剪（默认 180 天），保留足够追溯窗口。
 *
 * 调用点：登录 / 邀请码验证等低频未鉴权入口（Pages 无 scheduled handler，故走惰性清理），
 * 另提供 admin 手动端点 GET/POST /api/auth/maintenance 以便运维即时收敛。
 */
import type { Env } from '../env';

/** IP 失败计数的冷却阈值（小时）：超过且未锁定 → 视为陈旧可清理 */
const IP_RATE_LIMIT_STALE_HOURS = 24;
/** 登录审计日志保留天数 */
const LOGIN_AUDIT_RETENTION_DAYS = 180;

export interface MaintenanceResult {
  sessions: number;
  gateTokens: number;
  ipRateLimit: number;
  loginAudit: number;
}

/** 清理过期/陈旧认证数据；返回各表删除行数。失败不抛出（清理属尽力而为） */
export async function pruneStaleAuthRows(db: Env['DB'], now: Date = new Date()): Promise<MaintenanceResult> {
  const nowIso = now.toISOString();
  const ipCutoff = new Date(now.getTime() - IP_RATE_LIMIT_STALE_HOURS * 3600_000).toISOString();
  const auditCutoff = new Date(now.getTime() - LOGIN_AUDIT_RETENTION_DAYS * 86_400_000).toISOString();
  try {
    const results = await db.batch([
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso),
      db.prepare('DELETE FROM gate_tokens WHERE expires_at < ?').bind(nowIso),
      // 仅清理「未处于锁定状态」且久未尝试的行：锁定中的行必须保留，否则可通过清理绕过限流
      db.prepare(
        `DELETE FROM ip_rate_limit
         WHERE last_attempt_at < ?
           AND (locked_until IS NULL OR locked_until < ?)`
      ).bind(ipCutoff, nowIso),
      db.prepare('DELETE FROM login_audit_log WHERE created_at < ?').bind(auditCutoff),
    ]);
    return {
      sessions: results[0]?.meta?.changes ?? 0,
      gateTokens: results[1]?.meta?.changes ?? 0,
      ipRateLimit: results[2]?.meta?.changes ?? 0,
      loginAudit: results[3]?.meta?.changes ?? 0,
    };
  } catch (e) {
    console.error('[maintenance] pruneStaleAuthRows failed:', e instanceof Error ? e.message : String(e));
    return { sessions: 0, gateTokens: 0, ipRateLimit: 0, loginAudit: 0 };
  }
}
