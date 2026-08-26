-- 0007: CPA 财务健康指标 + 资产流动性分级 + 审计轨迹增强 + 公允价值重估 + 或有负债
-- =============================================================================

-- (1) tree_nodes 增加 liquidity 字段：标记资产流动性等级（high=随时变现, medium=短期可变现, low=长期锁定）
ALTER TABLE tree_nodes ADD COLUMN liquidity TEXT NOT NULL DEFAULT 'medium' CHECK (liquidity IN ('high','medium','low'));

-- (2) correction_logs 增加操作人信息（审计轨迹增强：记录修改人、修改时间、修改前后值）
ALTER TABLE correction_logs ADD COLUMN operator_id INTEGER REFERENCES users(id);
ALTER TABLE correction_logs ADD COLUMN operator_name TEXT;

-- (3) 健康配置阈值表
CREATE TABLE IF NOT EXISTS health_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO health_config (key, value) VALUES ('concentration_threshold', '0.5');
INSERT OR IGNORE INTO health_config (key, value) VALUES ('liquidity_months_min', '3');
INSERT OR IGNORE INTO health_config (key, value) VALUES ('debt_service_ratio_max', '0.4');
INSERT OR IGNORE INTO health_config (key, value) VALUES ('savings_rate_min', '0.2');
INSERT OR IGNORE INTO health_config (key, value) VALUES ('cpi_annual_rate', '0.02');

-- (4) 公允价值重估记录表（CPA：实物资产每年可做一次市场价重估，记录增值/减值）
CREATE TABLE IF NOT EXISTS asset_revaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES tree_nodes(id),
  revaluation_date TEXT NOT NULL,
  previous_value_cents INTEGER NOT NULL,
  new_value_cents INTEGER NOT NULL,
  change_cents INTEGER NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('appreciation','depreciation')),
  reason TEXT,
  appraiser TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- (5) 或有负债表（CPA：担保、诉讼等或有负债不计入负债总额，但在报表附注中披露）
CREATE TABLE IF NOT EXISTS contingent_liabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  liability_type TEXT NOT NULL CHECK (liability_type IN ('guarantee','litigation','commitment','other')),
  estimated_amount_cents INTEGER NOT NULL DEFAULT 0,
  probability TEXT NOT NULL CHECK (probability IN ('probable','possible','remote')) DEFAULT 'possible',
  counterparty TEXT,
  start_date TEXT,
  expiry_date TEXT,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','resolved','expired')) DEFAULT 'active',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
