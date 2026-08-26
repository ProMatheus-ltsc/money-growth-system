-- 0002_seed.sql — 初始化数据（随迁移下发）：
--   1) F-08 初始资产树 v1：7 个顶层模块 + 已有子分类，目标收益率按冻结表；
--      未补充末级明细前以「（待拆分）」占位子项承载（系统生成占位，is_placeholder=1）。
--      口径（03-prd §0/§7.2 D1）：资产端不含唯一住房节点；房贷负债在负债清单录入。
--   2) F-02b 默认收支分类 catV1：两级分类（收入 2 个一级/4 个二级，支出 8 个一级/12 个二级），
--      大额明细阈值默认 200 元。
-- 注：不预置账号（红线 R2，首次部署经 POST /api/auth/init 设置）；不预置负债（用户按实录入）。

INSERT INTO tree_configs (version, effective_from_month, note, created_at)
VALUES (1, '2026-08', 'F-08 初始资产树（用户提供的顶层模块与合计）', '2026-08-24T00:00:00Z');

-- 顶层模块（id 1~7）
INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled, sort_order, identity_info, is_placeholder, created_at) VALUES
(1, NULL, '现金/存款/货币基金/债券', 'module', 0.03, NULL, 1, 0, NULL, 0, '2026-08-24T00:00:00Z'),
(1, NULL, '怀孕与育儿基金', 'module', 0.03, NULL, 1, 1, NULL, 0, '2026-08-24T00:00:00Z'),
(1, NULL, '孩子婚礼基金', 'module', 0.10, NULL, 1, 2, NULL, 0, '2026-08-24T00:00:00Z'),
(1, NULL, '长期资金', 'module', 0.10, NULL, 1, 3, NULL, 0, '2026-08-24T00:00:00Z'),
(1, NULL, '中长期资金', 'module', 0.35, NULL, 1, 4, NULL, 0, '2026-08-24T00:00:00Z'),
(1, NULL, '消费基金', 'module', 0.50, NULL, 1, 5, NULL, 0, '2026-08-24T00:00:00Z'),
(1, NULL, '创业基金', 'module', 1.00, NULL, 1, 6, NULL, 0, '2026-08-24T00:00:00Z');

-- 长期资金 子模块（房地产基金/教育基金，id 8~9）
INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled, sort_order, identity_info, is_placeholder, created_at) VALUES
(1, 4, '房地产基金', 'sub', NULL, NULL, 1, 0, NULL, 0, '2026-08-24T00:00:00Z'),
(1, 4, '教育基金', 'sub', NULL, NULL, 1, 1, NULL, 0, '2026-08-24T00:00:00Z');

-- 消费基金 子模块（海外/国内，id 10~11）
INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled, sort_order, identity_info, is_placeholder, created_at) VALUES
(1, 6, '海外', 'sub', NULL, NULL, 1, 0, NULL, 0, '2026-08-24T00:00:00Z'),
(1, 6, '国内', 'sub', NULL, NULL, 1, 1, NULL, 0, '2026-08-24T00:00:00Z');

-- 「（待拆分）」占位末级（F-08 拆分规则；用户补充明细后经资产树管理页拆分，合计不变）
INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled, sort_order, identity_info, is_placeholder, created_at) VALUES
(1, 1, '（待拆分）', 'leaf', NULL, NULL, 1, 0, NULL, 1, '2026-08-24T00:00:00Z'),
(1, 2, '（待拆分）', 'leaf', NULL, NULL, 1, 0, NULL, 1, '2026-08-24T00:00:00Z'),
(1, 3, '（待拆分）', 'leaf', NULL, NULL, 1, 0, NULL, 1, '2026-08-24T00:00:00Z'),
(1, 8, '（待拆分）', 'leaf', NULL, NULL, 1, 0, NULL, 1, '2026-08-24T00:00:00Z'),
(1, 9, '（待拆分）', 'leaf', NULL, NULL, 1, 0, NULL, 1, '2026-08-24T00:00:00Z'),
(1, 5, '（待拆分）', 'leaf', NULL, NULL, 1, 0, NULL, 1, '2026-08-24T00:00:00Z'),
(1, 10, '（待拆分）', 'leaf', NULL, NULL, 1, 0, NULL, 1, '2026-08-24T00:00:00Z'),
(1, 11, '（待拆分）', 'leaf', NULL, NULL, 1, 0, NULL, 1, '2026-08-24T00:00:00Z'),
(1, 7, '（待拆分）', 'leaf', NULL, NULL, 1, 0, NULL, 1, '2026-08-24T00:00:00Z');

-- ============ 收支分类配置 v1（threshold 200 元 = 20000 分） ============
INSERT INTO cat_configs (version, threshold_cents, created_at)
VALUES (1, 20000, '2026-08-24T00:00:00Z');

-- 一级分类（id 1~10）
INSERT INTO cat_items (config_id, parent_id, direction, name, sort_order, created_at) VALUES
(1, NULL, 'income', '职业收入', 0, '2026-08-24T00:00:00Z'),
(1, NULL, 'income', '其他收入', 1, '2026-08-24T00:00:00Z'),
(1, NULL, 'expense', '医疗费用', 0, '2026-08-24T00:00:00Z'),
(1, NULL, 'expense', '居家生活', 1, '2026-08-24T00:00:00Z'),
(1, NULL, 'expense', '人情费用', 2, '2026-08-24T00:00:00Z'),
(1, NULL, 'expense', '食品酒水', 3, '2026-08-24T00:00:00Z'),
(1, NULL, 'expense', '购物消费', 4, '2026-08-24T00:00:00Z'),
(1, NULL, 'expense', '其他杂项', 5, '2026-08-24T00:00:00Z'),
(1, NULL, 'expense', '休闲娱乐', 6, '2026-08-24T00:00:00Z'),
(1, NULL, 'expense', '行车交通', 7, '2026-08-24T00:00:00Z');

-- 二级分类（收入 4 个 + 支出 12 个）
INSERT INTO cat_items (config_id, parent_id, direction, name, sort_order, created_at) VALUES
(1, 1, 'income', '工资', 0, '2026-08-24T00:00:00Z'),
(1, 1, 'income', '季度奖金', 1, '2026-08-24T00:00:00Z'),
(1, 2, 'income', '投资收益', 0, '2026-08-24T00:00:00Z'),
(1, 2, 'income', '利息', 1, '2026-08-24T00:00:00Z'),
(1, 3, 'expense', '门诊药品', 0, '2026-08-24T00:00:00Z'),
(1, 4, 'expense', '房租物业', 0, '2026-08-24T00:00:00Z'),
(1, 4, 'expense', '水电燃气', 1, '2026-08-24T00:00:00Z'),
(1, 5, 'expense', '红包礼金', 0, '2026-08-24T00:00:00Z'),
(1, 6, 'expense', '日常饮食', 0, '2026-08-24T00:00:00Z'),
(1, 6, 'expense', '外出就餐', 1, '2026-08-24T00:00:00Z'),
(1, 7, 'expense', '衣物饰品', 0, '2026-08-24T00:00:00Z'),
(1, 7, 'expense', '数码电器', 1, '2026-08-24T00:00:00Z'),
(1, 8, 'expense', '其他', 0, '2026-08-24T00:00:00Z'),
(1, 9, 'expense', '娱乐休闲', 0, '2026-08-24T00:00:00Z'),
(1, 10, 'expense', '油费过路', 0, '2026-08-24T00:00:00Z'),
(1, 10, 'expense', '保养保险', 1, '2026-08-24T00:00:00Z');
