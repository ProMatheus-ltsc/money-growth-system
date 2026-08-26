-- 0001_init.sql — 家庭资产增长记录工具 D1 初始化（04 §4.2，十六表 + 索引）
-- 迁移纪律（04 §4.2 注）：只增表/加列，不改列语义、不删列；回滚依赖备份恢复而非逆向迁移。
-- 金额口径：一律 INTEGER 分（1 元 = 100）；收益率为小数（0.035 = 3.5%）。

-- ============ 账号与会话 ============
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ============ 资产树配置（版本化） ============
CREATE TABLE IF NOT EXISTS tree_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  effective_from_month TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tree_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES tree_configs(id),
  parent_id INTEGER REFERENCES tree_nodes(id),
  name TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK (node_type IN ('module','sub','leaf')),
  target_rate_annual REAL,
  update_freq TEXT CHECK (update_freq IN ('monthly','quarterly','semiannual','annual','irregular')),
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  identity_info TEXT,
  is_placeholder INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tree_nodes_config ON tree_nodes(config_id);
CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent ON tree_nodes(parent_id);

-- ============ 收支分类配置（版本化，catV） ============
CREATE TABLE IF NOT EXISTS cat_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  threshold_cents INTEGER NOT NULL DEFAULT 20000,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cat_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES cat_configs(id),
  parent_id INTEGER REFERENCES cat_items(id),
  direction TEXT NOT NULL CHECK (direction IN ('income','expense')),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cat_items_config ON cat_items(config_id);

-- ============ 负债主档 ============
CREATE TABLE IF NOT EXISTS debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  debt_type TEXT NOT NULL CHECK (debt_type IN ('mortgage','auto_loan','credit_card','other')),
  term TEXT NOT NULL CHECK (term IN ('short','long')),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  annual_rate REAL NOT NULL DEFAULT 0,
  monthly_payment_cents INTEGER NOT NULL DEFAULT 0,
  fixed_repayment INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============ 月度快照（同月唯一） ============
CREATE TABLE IF NOT EXISTS monthly_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL UNIQUE,
  tree_config_id INTEGER NOT NULL REFERENCES tree_configs(id),
  cat_config_id INTEGER NOT NULL REFERENCES cat_configs(id),
  total_assets_cents INTEGER NOT NULL DEFAULT 0,
  total_debt_cents INTEGER NOT NULL DEFAULT 0,
  total_income_cents INTEGER NOT NULL DEFAULT 0,
  total_expense_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  corrected_at TEXT
);

CREATE TABLE IF NOT EXISTS snapshot_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES monthly_snapshots(id),
  node_id INTEGER NOT NULL REFERENCES tree_nodes(id),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  has_new_funds INTEGER NOT NULL DEFAULT 0,
  update_source TEXT NOT NULL DEFAULT 'current' CHECK (update_source IN ('current','carried')),
  UNIQUE (snapshot_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_snap_assets_snap ON snapshot_assets(snapshot_id);

CREATE TABLE IF NOT EXISTS snapshot_gains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES monthly_snapshots(id),
  module_node_id INTEGER NOT NULL REFERENCES tree_nodes(id),
  gain_cents INTEGER,
  UNIQUE (snapshot_id, module_node_id)
);

CREATE TABLE IF NOT EXISTS snapshot_debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES monthly_snapshots(id),
  debt_id INTEGER NOT NULL REFERENCES debts(id),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  repayment_cents INTEGER NOT NULL DEFAULT 0,
  UNIQUE (snapshot_id, debt_id)
);

CREATE TABLE IF NOT EXISTS snapshot_cat_amounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES monthly_snapshots(id),
  cat_item_id INTEGER NOT NULL REFERENCES cat_items(id),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  UNIQUE (snapshot_id, cat_item_id)
);

CREATE TABLE IF NOT EXISTS snapshot_large_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES monthly_snapshots(id),
  direction TEXT NOT NULL CHECK (direction IN ('income','expense')),
  cat_item_id INTEGER NOT NULL REFERENCES cat_items(id),
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_large_items_snap ON snapshot_large_items(snapshot_id);

-- ============ 定期报告快照（冻结） ============
CREATE TABLE IF NOT EXISTS report_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL CHECK (report_type IN ('quarter','half','year')),
  start_month TEXT NOT NULL,
  end_month TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  total_assets_cents INTEGER NOT NULL,
  net_worth_cents INTEGER NOT NULL,
  debt_ratio REAL NOT NULL,
  period_balance_cents INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (report_type, start_month, end_month)
);

-- ============ AI 分析记录 ============
CREATE TABLE IF NOT EXISTS ai_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_date TEXT NOT NULL,
  asset_month TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_month ON ai_analyses(asset_month);

-- ============ 纠错日志 ============
CREATE TABLE IF NOT EXISTS correction_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES monthly_snapshots(id),
  corrected_at TEXT NOT NULL,
  diff_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corr_snap ON correction_logs(snapshot_id);
