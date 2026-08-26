/**
 * 认证端点（05 §3.1~§3.4）：初始化双账号 / 登录 / 登出 / 当前会话。
 * - 密码：PBKDF2-SHA-256（100k 迭代，Web Crypto），每用户随机盐（04 §4.2）
 * - 连续 5 次失败锁定 15 分钟；失败不区分「用户不存在/密码错误」（AUTH_FAILED）
 * - 令牌 7 天有效，存 sessions 表（数据库令牌模式，无 JWT 签名密钥）
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import { ApiError, authFailed, conflict, forbidden, invalidParam, lockedOut } from '../lib/errors';
import { fail, ok } from '../lib/http';
import { derivePasswordHash, newToken, randomSaltHex } from '../lib/password';
import { strField, USERNAME_RE, idParam } from '../lib/validate';
import { requireAuth, parseToken, type AppEnv } from '../middleware/auth';

/** 账号级：连续失败后锁定时长（分钟） */
const LOCK_MINUTES = 15;
/** 账号级：最大连续失败次数，达到后锁定账号 */
const MAX_ATTEMPTS = 5;
/** 登录令牌有效期（天），支持多设备同时在线 */
const TOKEN_TTL_DAYS = 7;

/** IP 级限流：最大连续失败次数 */
const IP_MAX_ATTEMPTS = 10;
/** IP 级限流：锁定时长（分钟） */
const IP_LOCK_MINUTES = 30;

const auth = new Hono<AppEnv>();

// §3.1 首次运行初始化（仅 users 表为空时一次性生效）
auth.post('/init', async (c) => {
  const { count } = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>().then((r) => ({ count: r?.count ?? 0 }));
  if (count > 0) throw conflict('系统已完成初始化，该端点不再可用');

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const errors: { field: string; message: string }[] = [];
  const admin = (body?.admin ?? {}) as Record<string, unknown>;
  const viewer = (body?.viewer ?? {}) as Record<string, unknown>;

  const adminUsername = strField(admin.username, 'admin.username', errors, {
    pattern: USERNAME_RE,
    patternMsg: '用户名须为 3~20 个字母/数字/下划线',
    label: '管理员用户名',
  });
  const adminPassword = strField(admin.password, 'admin.password', errors, {
    min: 8,
    max: 64,
    label: '管理员密码',
  });
  const viewerUsername = strField(viewer.username, 'viewer.username', errors, {
    pattern: USERNAME_RE,
    patternMsg: '用户名须为 3~20 个字母/数字/下划线',
    label: '只读账号用户名',
  });
  const viewerPassword = strField(viewer.password, 'viewer.password', errors, {
    min: 8,
    max: 64,
    label: '只读账号密码',
  });
  if (errors.length === 0 && adminUsername === viewerUsername) {
    errors.push({ field: 'viewer.username', message: '只读账号用户名不得与管理员相同' });
  }
  if (errors.length > 0) throw invalidParam('初始化参数校验失败', errors);

  const now = new Date().toISOString();
  const [adminSalt, viewerSalt] = [randomSaltHex(), randomSaltHex()];
  const [adminHash, viewerHash] = await Promise.all([
    derivePasswordHash(adminPassword!, adminSalt),
    derivePasswordHash(viewerPassword!, viewerSalt),
  ]);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users (username, password_hash, salt, role, failed_attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .bind(adminUsername, adminHash, adminSalt, 'admin', now),
    c.env.DB.prepare('INSERT INTO users (username, password_hash, salt, role, failed_attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .bind(viewerUsername, viewerHash, viewerSalt, 'viewer', now),
  ]);
  return ok(c, { initialized: true });
});

// 注：无鉴权 /api/auth/register 已删除（CR-001 BLOCKER：任何人可创建 admin）。
// 唯一账号创建途径 = /api/auth/init（首次双账号）+ /api/auth/create-viewer（管理员建只读账号）。

// 邀请码验证（前置门控，也受 IP 限流保护）
auth.post('/verify-invite', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const now = new Date();
  const nowIso = now.toISOString();

  // IP 限流检查（与登录共用同一个 IP 计数器）
  const ipRecord = await c.env.DB.prepare('SELECT failed_attempts, locked_until FROM ip_rate_limit WHERE ip = ?')
    .bind(clientIp)
    .first<{ failed_attempts: number; locked_until: string | null }>();

  if (ipRecord?.locked_until && ipRecord.locked_until > nowIso) {
    await c.env.DB.prepare('INSERT INTO login_audit_log (ip, username, success, reason, created_at) VALUES (?, ?, 0, ?, ?)')
      .bind(clientIp, null, '邀请码验证-IP已锁定', nowIso).run();
    throw lockedOut();
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';

  if (!code) {
    return fail(c, 'INVALID', '请输入邀请码', 400);
  }

  if (code !== c.env.INVITE_CODE) {
    await recordIpFailure(c.env.DB, clientIp, nowIso, now);
    await c.env.DB.prepare('INSERT INTO login_audit_log (ip, username, success, reason, created_at) VALUES (?, ?, 0, ?, ?)')
      .bind(clientIp, null, '邀请码错误: ' + code, nowIso).run();
    return fail(c, 'INVALID', '邀请码不正确', 403);
  }

  // 验证成功，返回一个短期凭证（10分钟有效），前端用它解锁登录表单
  const gateToken = newToken();
  const gateExpires = new Date(now.getTime() + 10 * 60_000).toISOString();
  await c.env.DB.prepare(
    'INSERT INTO gate_tokens (token, expires_at, created_at) VALUES (?, ?, ?)'
  ).bind(gateToken, gateExpires, nowIso).run();

  return ok(c, { gateToken, expiresAt: gateExpires });
});

// §3.2 登录（含 IP 级限流 + 审计日志 + 邀请码门控验证）
auth.post('/login', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const now = new Date();
  const nowIso = now.toISOString();

  // --- IP 级限流检查 ---
  const ipRecord = await c.env.DB.prepare('SELECT failed_attempts, locked_until FROM ip_rate_limit WHERE ip = ?')
    .bind(clientIp)
    .first<{ failed_attempts: number; locked_until: string | null }>();

  if (ipRecord?.locked_until && ipRecord.locked_until > nowIso) {
    await c.env.DB.prepare('INSERT INTO login_audit_log (ip, username, success, reason, created_at) VALUES (?, ?, 0, ?, ?)')
      .bind(clientIp, null, 'IP已锁定', nowIso).run();
    throw lockedOut();
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  // --- 邀请码门控验证：登录必须携带有效 gateToken（一次性，验证通过即消费） ---
  const gateToken = typeof body?.gateToken === 'string' ? body.gateToken : '';
  if (!gateToken) {
    return fail(c, 'GATE_REQUIRED', '请先通过邀请码验证', 403);
  }
  const gate = await c.env.DB.prepare('SELECT expires_at FROM gate_tokens WHERE token = ?')
    .bind(gateToken).first<{ expires_at: string }>();
  if (!gate || gate.expires_at < nowIso) {
    return fail(c, 'GATE_EXPIRED', '邀请码验证已过期，请重新验证', 403);
  }
  const errors: { field: string; message: string }[] = [];
  const username = strField(body?.username, 'username', errors, { max: 64, label: '用户名' });
  const password = strField(body?.password, 'password', errors, { max: 128, label: '密码' });
  if (errors.length > 0) throw invalidParam('登录参数校验失败', errors);

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: number; password_hash: string; salt: string; role: string; failed_attempts: number; locked_until: string | null }>();

  if (!user) {
    await recordIpFailure(c.env.DB, clientIp, nowIso, now);
    await c.env.DB.prepare('INSERT INTO login_audit_log (ip, username, success, reason, created_at) VALUES (?, ?, 0, ?, ?)')
      .bind(clientIp, username, '用户不存在', nowIso).run();
    throw authFailed();
  }

  // 账号锁定检查
  if (user.locked_until && user.locked_until > nowIso) {
    await c.env.DB.prepare('INSERT INTO login_audit_log (ip, username, success, reason, created_at) VALUES (?, ?, 0, ?, ?)')
      .bind(clientIp, username, '账号已锁定', nowIso).run();
    throw lockedOut();
  }

  const hash = await derivePasswordHash(password!, user.salt);
  if (hash !== user.password_hash) {
    const attempts = user.failed_attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString();
      await c.env.DB.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .bind(attempts, lockedUntil, user.id).run();
    } else {
      await c.env.DB.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').bind(attempts, user.id).run();
    }
    await recordIpFailure(c.env.DB, clientIp, nowIso, now);
    await c.env.DB.prepare('INSERT INTO login_audit_log (ip, username, success, reason, created_at) VALUES (?, ?, 0, ?, ?)')
      .bind(clientIp, username, '密码错误', nowIso).run();
    if (attempts >= MAX_ATTEMPTS) throw lockedOut();
    throw authFailed();
  }

  // 成功：清零账号失败计数 + 清零 IP 失败计数，签发 7 天令牌（支持多设备同时在线）
  // CR-017：消费 gateToken（一次性），登录成功即删除
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_DAYS * 24 * 3600_000).toISOString();
  const token = newToken();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(user.id),
    c.env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(token, user.id, expiresAt, nowIso),
    c.env.DB.prepare('DELETE FROM ip_rate_limit WHERE ip = ?').bind(clientIp),
    c.env.DB.prepare('DELETE FROM gate_tokens WHERE token = ?').bind(gateToken),
    c.env.DB.prepare('INSERT INTO login_audit_log (ip, username, success, reason, created_at) VALUES (?, ?, 1, ?, ?)')
      .bind(clientIp, username, '登录成功', nowIso),
  ]);
  return ok(c, { token, username: username!, role: user.role, expiresAt });
});

/**
 * 记录 IP 级认证失败：递增失败计数，达到阈值（IP_MAX_ATTEMPTS）时写入锁定截止时间。
 * 使用 UPSERT（INSERT ... ON CONFLICT DO UPDATE）确保并发安全。
 */
async function recordIpFailure(db: D1Database, ip: string, nowIso: string, now: Date) {
  const existing = await db.prepare('SELECT failed_attempts FROM ip_rate_limit WHERE ip = ?').bind(ip)
    .first<{ failed_attempts: number }>();
  const attempts = (existing?.failed_attempts ?? 0) + 1;
  if (attempts >= IP_MAX_ATTEMPTS) {
    const lockedUntil = new Date(now.getTime() + IP_LOCK_MINUTES * 60_000).toISOString();
    await db.prepare(
      'INSERT INTO ip_rate_limit (ip, failed_attempts, locked_until, last_attempt_at) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET failed_attempts = ?, locked_until = ?, last_attempt_at = ?'
    ).bind(ip, attempts, lockedUntil, nowIso, attempts, lockedUntil, nowIso).run();
  } else {
    await db.prepare(
      'INSERT INTO ip_rate_limit (ip, failed_attempts, last_attempt_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET failed_attempts = ?, last_attempt_at = ?'
    ).bind(ip, attempts, nowIso, attempts, nowIso).run();
  }
}

/** POST /create-viewer — 管理员创建浏览者账户（注册端点禁用后的唯一账号创建途径） */
auth.post('/create-viewer', requireAuth, async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') throw new ApiError('FORBIDDEN', 403, '仅管理员可创建浏览者账户');

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const errors: { field: string; message: string }[] = [];
  const username = strField(body?.username, 'username', errors, {
    pattern: USERNAME_RE,
    patternMsg: '用户名须为 3~20 个字母/数字/下划线',
    label: '用户名',
  });
  const password = strField(body?.password, 'password', errors, {
    min: 8,
    max: 64,
    label: '密码',
  });
  if (errors.length > 0) throw invalidParam('参数校验失败', errors);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: number }>();
  if (existing) throw conflict('该用户名已被使用');

  const now = new Date().toISOString();
  const salt = randomSaltHex();
  const hash = await derivePasswordHash(password!, salt);
  await c.env.DB.prepare('INSERT INTO users (username, password_hash, salt, role, failed_attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .bind(username, hash, salt, 'viewer', now)
    .run();
  return ok(c, { created: true, username, role: 'viewer' });
});

/** GET /users — 管理员获取所有用户列表（仅返回非敏感字段） */
auth.get('/users', requireAuth, async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') throw new ApiError('FORBIDDEN', 403, '仅管理员可查看用户列表');

  const rows = await c.env.DB.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC')
    .all<{ id: number; username: string; role: string; created_at: string }>();
  return ok(c, rows.results);
});

/** DELETE /users/:id — 管理员删除用户（同时清除其所有会话；不可删除自己） */
auth.delete('/users/:id', requireAuth, async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') throw new ApiError('FORBIDDEN', 403, '仅管理员可删除用户');

  const targetId = idParam(c.req.param('id'));
  if (targetId === user.id) throw invalidParam('不能删除自己的账户', []);

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId),
  ]);
  return ok(c, { deleted: true });
});

// §3.3 登出（幂等：令牌已失效时也返回成功）
auth.post('/logout', async (c) => {
  const token = parseToken(c);
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
  return ok(c, {});
});

// §3.4 当前会话
auth.get('/me', requireAuth, (c) => {
  const user = c.get('user');
  return ok(c, { username: user.username, role: user.role });
});

export default auth;
