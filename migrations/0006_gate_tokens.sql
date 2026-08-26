-- 独立的门控令牌表，用于邀请码验证后的短期凭证存储
-- 避免复用 sessions 表（sessions 有 user_id 外键约束）
CREATE TABLE IF NOT EXISTS gate_tokens (
  token TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
