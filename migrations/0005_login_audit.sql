-- 0005_login_audit.sql — 登录安全加固：IP级限流 + 审计日志

-- IP 级别登录失败计数（防穷举）
CREATE TABLE IF NOT EXISTS ip_rate_limit (
  ip TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_attempt_at TEXT NOT NULL
);

-- 登录审计日志（所有登录尝试，成功和失败都记录）
CREATE TABLE IF NOT EXISTS login_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  username TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ip ON login_audit_log(ip);
CREATE INDEX IF NOT EXISTS idx_audit_time ON login_audit_log(created_at);
