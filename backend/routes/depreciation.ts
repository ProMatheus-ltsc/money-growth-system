/**
 * 实物资产折旧管理（PRD F-13 / 04 §4.3）：
 * - GET    /depreciation       查询指定配置版本下所有折旧记录（可选 month 参数计算当前净值）
 * - POST   /depreciation       新增或更新折旧配置（同一 nodeId+configId 唯一）
 * - DELETE /depreciation/:id   删除折旧记录
 *
 * 折旧方法：
 *   - 电子设备：年数总和法（前期折旧多、后期少，符合电子产品贬值规律）
 *   - 家具/车辆/机械/建筑：直线法（均匀折旧）
 *
 * 残值模式：
 *   - rate：按残值率 × 原值计算（默认）
 *   - market：按市场残值估价（用户手动输入）
 *
 * 权限：仅 admin。
 */
import { Hono } from 'hono';
import { invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';

const depreciation = new Hono<AppEnv>();

/** 折旧记录数据库行结构 */
export interface DepreciationRow {
  id: number;
  node_id: number;
  config_id: number;
  depreciation_category: string;
  original_value: number;
  purchase_date: string;
  useful_life_months: number;
  salvage_rate: number;
  salvage_mode: string;
  market_salvage_value: number | null;
  created_at: string;
}

/** 支持的折旧资产类别 */
const CATEGORIES = ['electronics', 'furniture', 'vehicle', 'machinery', 'building'] as const;

/** 各类别最低折旧年限（月）——参照企业会计准则 */
const MIN_LIFE_MONTHS: Record<string, number> = {
  electronics: 36,   // 电子设备 ≥ 3 年
  furniture: 60,     // 家具 ≥ 5 年
  vehicle: 48,       // 车辆 ≥ 4 年
  machinery: 60,     // 机械 ≥ 5 年
  building: 240,     // 建筑 ≥ 20 年
};

/** 各类别最大折旧年限（月） */
const MAX_LIFE_MONTHS: Record<string, number> = {
  electronics: 60,
  furniture: 120,
  vehicle: 72,
  machinery: 120,
  building: 480,
};

/** 各类别默认折旧年限（月） */
const DEFAULT_LIFE_MONTHS: Record<string, number> = {
  electronics: 36,
  furniture: 60,
  vehicle: 48,
  machinery: 60,
  building: 240,
};

/** 各类别默认残值率（残值 = 原值 × 残值率） */
const DEFAULT_SALVAGE_RATE: Record<string, number> = {
  electronics: 0.20,  // 电子设备残值 20%
  furniture: 0.30,    // 家具残值 30%
  vehicle: 0.40,      // 车辆残值 40%
  machinery: 0.15,    // 机械残值 15%
  building: 0.70,     // 建筑残值 70%
};

/** 各类别默认折旧方法 */
const DEPRECIATION_METHOD: Record<string, 'straight' | 'sum_of_years'> = {
  electronics: 'sum_of_years',  // 电子设备：年数总和法（加速折旧）
  furniture: 'straight',        // 家具：直线法
  vehicle: 'straight',          // 车辆：直线法
  machinery: 'straight',        // 机械：直线法
  building: 'straight',         // 建筑：直线法
};

/**
 * 将数据库行（snake_case）转换为前端 API 响应格式（camelCase）。
 * 仅做字段映射，不含业务计算。
 */
function depreciationOut(r: DepreciationRow) {
  return {
    id: r.id,
    nodeId: r.node_id,
    configId: r.config_id,
    depreciationCategory: r.depreciation_category,
    originalValue: r.original_value,
    purchaseDate: r.purchase_date,
    usefulLifeMonths: r.useful_life_months,
    salvageRate: r.salvage_rate,
    salvageMode: r.salvage_mode,
    marketSalvageValue: r.market_salvage_value,
  };
}

/**
 * 计算某条折旧记录在指定月份（asOfMonth，格式 YYYY-MM）的当前净值。
 *
 * 算法：
 *   1. 确定残值（rate 模式 = 原值×残值率；market 模式 = 用户手动估价）
 *   2. 计算已折旧月数 = asOfMonth 与 purchaseDate 之间的自然月差
 *   3. 根据资产类别选择折旧方法：
 *      - 年数总和法（sum_of_years）：每年折旧额 = 可折旧金额 × (剩余年数/年数总和)
 *      - 直线法（straight）：每月折旧额 = 可折旧金额 / 总月数
 *   4. 净值 = max(残值, 原值 - 累计折旧)
 *
 * @returns 包含当前净值、月折旧额、累计折旧、是否已完全折旧等信息
 */
export function calcDepreciation(dep: DepreciationRow, asOfMonth: string): {
  currentValue: number;
  monthlyDep: number;
  totalDepreciated: number;
  salvageValue: number;
  depreciatedMonths: number;
  isFullyDepreciated: boolean;
  method: 'straight' | 'sum_of_years';
} {
  const salvageValue = dep.salvage_mode === 'market' && dep.market_salvage_value !== null
    ? dep.market_salvage_value
    : dep.original_value * dep.salvage_rate;

  const purchaseDateStr = dep.purchase_date.length === 7 ? dep.purchase_date + '-01' : dep.purchase_date;
  const purchaseDate = new Date(purchaseDateStr);
  const asOfDate = new Date(asOfMonth + '-01');
  const depreciatedMonths = Math.max(0,
    (asOfDate.getFullYear() - purchaseDate.getFullYear()) * 12 +
    (asOfDate.getMonth() - purchaseDate.getMonth())
  );

  const method = DEPRECIATION_METHOD[dep.depreciation_category] ?? 'straight';
  const depreciableAmount = dep.original_value - salvageValue;
  const effectiveMonths = Math.min(depreciatedMonths, dep.useful_life_months);

  if (method === 'sum_of_years') {
    const totalYears = dep.useful_life_months / 12;
    const sumOfYears = (totalYears * (totalYears + 1)) / 2;
    let totalDep = 0;
    let currentMonthDep = 0;

    for (let m = 0; m < effectiveMonths; m++) {
      const yearIndex = Math.floor(m / 12);
      const remainingYears = totalYears - yearIndex;
      const yearlyDep = depreciableAmount * (remainingYears / sumOfYears);
      const mDep = yearlyDep / 12;
      totalDep += mDep;
      currentMonthDep = mDep;
    }

    const currentValue = Math.max(salvageValue, dep.original_value - totalDep);
    const isFullyDepreciated = depreciatedMonths >= dep.useful_life_months;

    return { currentValue, monthlyDep: currentMonthDep, totalDepreciated: totalDep, salvageValue, depreciatedMonths: effectiveMonths, isFullyDepreciated, method };
  }

  const monthlyDep = depreciableAmount / dep.useful_life_months;
  const totalDepreciated = monthlyDep * effectiveMonths;
  const currentValue = Math.max(salvageValue, dep.original_value - totalDepreciated);
  const isFullyDepreciated = depreciatedMonths >= dep.useful_life_months;

  return { currentValue, monthlyDep, totalDepreciated, salvageValue, depreciatedMonths: effectiveMonths, isFullyDepreciated, method };
}

/** GET /depreciation — 查询指定配置版本下所有折旧记录，可选 month 参数计算当前净值 */
depreciation.get('/', requireAuth, requireAdmin, async (c) => {
  const configId = c.req.query('configId');
  const month = c.req.query('month');
  if (!configId) throw invalidParam('configId 为必填参数');

  const { results } = await c.env.DB
    .prepare('SELECT * FROM asset_depreciation WHERE config_id = ?')
    .bind(Number(configId))
    .all<DepreciationRow>();

  const items = results.map(r => {
    const out = depreciationOut(r);
    if (month) {
      const calc = calcDepreciation(r, month);
      return { ...out, ...calc };
    }
    return out;
  });

  return ok(c, { items, defaults: { lifeMonths: DEFAULT_LIFE_MONTHS, minLifeMonths: MIN_LIFE_MONTHS, maxLifeMonths: MAX_LIFE_MONTHS, salvageRates: DEFAULT_SALVAGE_RATE, methods: DEPRECIATION_METHOD } });
});

/** POST /depreciation — 新增或更新折旧配置（同一 nodeId+configId 唯一，存在则更新） */
depreciation.post('/', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) throw invalidParam('请求体必须为 JSON');

  const nodeId = body.nodeId;
  const configId = body.configId;
  const category = body.depreciationCategory as string;
  const originalValue = body.originalValue;
  const purchaseDate = body.purchaseDate as string;
  const usefulLifeMonths = body.usefulLifeMonths;
  const salvageRate = body.salvageRate;
  const salvageMode = body.salvageMode as string || 'rate';
  const marketSalvageValue = body.marketSalvageValue;

  if (!nodeId || typeof nodeId !== 'number') throw invalidParam('nodeId 为必填数字');
  if (!configId || typeof configId !== 'number') throw invalidParam('configId 为必填数字');
  if (!category || !(CATEGORIES as readonly string[]).includes(category)) {
    throw invalidParam(`depreciationCategory 须为 ${CATEGORIES.join('/')}`);
  }
  if (!originalValue || typeof originalValue !== 'number' || originalValue <= 0) {
    throw invalidParam('originalValue 须为正数');
  }
  if (!purchaseDate || !/^\d{4}-\d{2}(-\d{2})?$/.test(purchaseDate)) {
    throw invalidParam('purchaseDate 格式须为 YYYY-MM 或 YYYY-MM-DD');
  }
  const lifeMonths = typeof usefulLifeMonths === 'number' ? usefulLifeMonths : DEFAULT_LIFE_MONTHS[category];
  const minLife = MIN_LIFE_MONTHS[category];
  if (lifeMonths < minLife) {
    throw invalidParam(`${category} 最低折旧年限为 ${minLife} 个月（${minLife / 12} 年），当前设置 ${lifeMonths} 个月不满足要求`);
  }
  const rate = typeof salvageRate === 'number' ? salvageRate : DEFAULT_SALVAGE_RATE[category];

  if (salvageMode !== 'rate' && salvageMode !== 'market') {
    throw invalidParam("salvageMode 须为 'rate' 或 'market'");
  }

  const normalizedDate = purchaseDate.length === 7 ? purchaseDate + '-01' : purchaseDate;

  const existing = await c.env.DB
    .prepare('SELECT id FROM asset_depreciation WHERE node_id = ? AND config_id = ?')
    .bind(nodeId, configId)
    .first<{ id: number }>();

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE asset_depreciation SET depreciation_category=?, original_value=?, purchase_date=?,
       useful_life_months=?, salvage_rate=?, salvage_mode=?, market_salvage_value=?
       WHERE id=?`
    ).bind(category, originalValue, normalizedDate, lifeMonths, rate, salvageMode, marketSalvageValue ?? null, existing.id).run();
    return ok(c, { id: existing.id, updated: true });
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO asset_depreciation (node_id, config_id, depreciation_category, original_value, purchase_date,
     useful_life_months, salvage_rate, salvage_mode, market_salvage_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(nodeId, configId, category, originalValue, normalizedDate, lifeMonths, rate, salvageMode, marketSalvageValue ?? null).run();

  return ok(c, { id: Number(res.meta.last_row_id), updated: false });
});

/** DELETE /depreciation/:id — 删除指定折旧记录 */
depreciation.delete('/:id', requireAuth, requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  if (!id || Number.isNaN(id)) throw invalidParam('id 须为数字');
  const row = await c.env.DB.prepare('SELECT id FROM asset_depreciation WHERE id = ?').bind(id).first();
  if (!row) throw notFound('折旧记录不存在');
  await c.env.DB.prepare('DELETE FROM asset_depreciation WHERE id = ?').bind(id).run();
  return ok(c, { deleted: true });
});

export default depreciation;
