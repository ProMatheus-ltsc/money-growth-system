-- 0003_asset_category.sql — 资产分类：区分资金资产(financial)与实物资产(physical)
-- 仅顶层 module 设置 asset_category，子节点继承父级分类。
-- 实物资产：可二手交易的高价值物品（电子产品等），按当前二手市值估值录入。
-- 黄金、房产暂不列入实物资产。

ALTER TABLE tree_nodes ADD COLUMN asset_category TEXT
  CHECK (asset_category IN ('financial','physical')) DEFAULT 'financial';

-- 新增默认实物资产模块（电子产品）
INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled, sort_order, identity_info, is_placeholder, asset_category, created_at)
VALUES (1, NULL, '实物资产（电子产品）', 'module', NULL, 'quarterly', 1, 7, NULL, 0, 'physical', '2026-08-25T00:00:00Z');

-- 实物资产下的子模块
INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled, sort_order, identity_info, is_placeholder, asset_category, created_at)
VALUES
(1, (SELECT id FROM tree_nodes WHERE name='实物资产（电子产品）' AND config_id=1), '手机', 'leaf', NULL, 'quarterly', 1, 0, NULL, 0, 'physical', '2026-08-25T00:00:00Z'),
(1, (SELECT id FROM tree_nodes WHERE name='实物资产（电子产品）' AND config_id=1), '电脑', 'leaf', NULL, 'quarterly', 1, 1, NULL, 0, 'physical', '2026-08-25T00:00:00Z'),
(1, (SELECT id FROM tree_nodes WHERE name='实物资产（电子产品）' AND config_id=1), '平板', 'leaf', NULL, 'quarterly', 1, 2, NULL, 0, 'physical', '2026-08-25T00:00:00Z');
