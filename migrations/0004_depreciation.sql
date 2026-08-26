-- 实物资产折旧参数表
-- 每个实物资产叶子节点可关联一条折旧记录
CREATE TABLE IF NOT EXISTS asset_depreciation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES tree_nodes(id),
  config_id INTEGER NOT NULL REFERENCES tree_configs(id),
  -- 折旧分类：electronics(电子设备3年), furniture(器具家具5年), vehicle(运输工具4年), machinery(机械设备10年), building(房屋建筑20年)
  depreciation_category TEXT NOT NULL CHECK (depreciation_category IN ('electronics','furniture','vehicle','machinery','building')),
  -- 原值（购入价格，元）
  original_value REAL NOT NULL,
  -- 购入日期 YYYY-MM-DD
  purchase_date TEXT NOT NULL,
  -- 折旧年限（月）- 可自定义覆盖默认值
  useful_life_months INTEGER NOT NULL,
  -- 残值率 0~1（如 0.05 表示5%）
  salvage_rate REAL NOT NULL DEFAULT 0.05,
  -- 残值模式: 'rate'=按残值率计算, 'market'=按市场价手动设置
  salvage_mode TEXT NOT NULL DEFAULT 'rate' CHECK (salvage_mode IN ('rate','market')),
  -- 市场残值（salvage_mode='market'时使用）
  market_salvage_value REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_depreciation_node_config ON asset_depreciation(node_id, config_id);
