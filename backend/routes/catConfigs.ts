/**
 * 收支分类配置（05 §3.16/§3.17，F-02b，CHG-02 改动四）：
 * - GET  当前配置（两级结构 + 大额阈值）
 * - POST 全量提交生成新版本（仅两级；历史快照钉住旧版本，仅影响未来月份）
 * 权限：仅 admin。
 */
import { Hono } from 'hono';
import type { ErrorDetail } from '../lib/errors';
import { invalidParam } from '../lib/errors';
import { ok } from '../lib/http';
import { yuanToCents } from '../lib/money';
import { centsToYuan } from '../lib/money';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { getCatItems, getLatestCatConfig } from '../services/snapshotRepo';

const catConfigs = new Hono<AppEnv>();

// §3.16 查询当前收支分类配置
catConfigs.get('/', requireAuth, requireAdmin, async (c) => {
  const config = await getLatestCatConfig(c.env.DB);
  if (!config) throw invalidParam('分类配置不存在，请先初始化');
  const items = await getCatItems(c.env.DB, config.id);
  const build = (direction: 'income' | 'expense') =>
    items
      .filter((i) => i.parent_id === null && i.direction === direction)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .map((top) => ({
        id: top.id,
        name: top.name,
        sortOrder: top.sort_order,
        children: items
          .filter((i) => i.parent_id === top.id)
          .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
          .map((leaf) => ({ id: leaf.id, name: leaf.name, sortOrder: leaf.sort_order })),
      }));
  return ok(c, {
    configId: config.id,
    version: config.version,
    threshold: centsToYuan(config.threshold_cents),
    income: build('income'),
    expense: build('expense'),
  });
});

interface CatItemInput {
  tempId?: unknown;
  parentTempId?: unknown;
  direction?: unknown;
  name?: unknown;
  sortOrder?: unknown;
}

// §3.17 保存新版本分类配置
catConfigs.post('/', requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw invalidParam('请求体必须为 JSON 对象');
  const errors: ErrorDetail[] = [];

  const thresholdCents = yuanToCents(body.threshold, 'threshold', errors, {
    min: 0.01,
    label: '大额明细阈值',
  });

  const raw = body.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push({ field: 'items', message: 'items 为必填数组且至少 1 个一级分类' });
    throw invalidParam('分类配置校验失败', errors);
  }
  const items = raw as CatItemInput[];
  const tempIdx = new Map<string, number>();
  items.forEach((it, i) => {
    const f = `items[${i}]`;
    const tid = typeof it.tempId === 'string' && it.tempId.length > 0 ? it.tempId : null;
    if (!tid) errors.push({ field: `${f}.tempId`, message: 'tempId 为必填项' });
    else {
      if (tempIdx.has(tid)) errors.push({ field: `${f}.tempId`, message: `tempId 重复：${tid}` });
      tempIdx.set(tid, i);
    }
    if (it.direction !== 'income' && it.direction !== 'expense') {
      errors.push({ field: `${f}.direction`, message: "direction 必须为 'income'/'expense'" });
    }
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (name.length < 1 || name.length > 20) {
      errors.push({ field: `${f}.name`, message: '分类名须为 1~20 字符' });
    }
    if (it.sortOrder !== undefined && (typeof it.sortOrder !== 'number' || !Number.isInteger(it.sortOrder))) {
      errors.push({ field: `${f}.sortOrder`, message: 'sortOrder 必须为整数' });
    }
  });

  // 父级引用：必须指向同批条目；仅允许两级（父级的父级必须为 null）
  const parentOf = new Map<number, number | null>();
  items.forEach((it, i) => {
    const f = `items[${i}]`;
    const p = it.parentTempId;
    if (p === null || p === undefined) {
      parentOf.set(i, null);
      return;
    }
    if (typeof p !== 'string' || !tempIdx.has(p)) {
      errors.push({ field: `${f}.parentTempId`, message: '父级必须指向同批分类或为 null' });
      return;
    }
    const pi = tempIdx.get(p)!;
    const parentItem = items[pi];
    if (parentItem.parentTempId !== null && parentItem.parentTempId !== undefined) {
      errors.push({ field: `${f}.parentTempId`, message: '仅支持两级分类，二级分类不能再作为父级' });
      return;
    }
    if (parentItem.direction !== it.direction) {
      errors.push({ field: `${f}.direction`, message: '二级分类必须与父级同方向' });
      return;
    }
    parentOf.set(i, pi);
  });

  if (errors.length > 0) throw invalidParam('分类配置校验失败', errors);

  const now = new Date().toISOString();
  const latest = await c.env.DB.prepare('SELECT MAX(version) AS v FROM cat_configs').first<{ v: number | null }>();
  const version = (latest?.v ?? 0) + 1;
  // CR-007：写入含动态 id 依赖（configId→item ids），无法并入单 D1 batch；
  // 失败补偿删除，不留半截配置版本。
  let configId = 0;
  try {
    const cfgRes = await c.env.DB.prepare('INSERT INTO cat_configs (version, threshold_cents, created_at) VALUES (?, ?, ?)')
      .bind(version, thresholdCents, now)
      .run();
    configId = Number(cfgRes.meta.last_row_id);

    const insertStmts = items.map((it) =>
      c.env.DB.prepare(
        'INSERT INTO cat_items (config_id, parent_id, direction, name, sort_order, created_at) VALUES (?, NULL, ?, ?, ?, ?)'
      ).bind(configId, it.direction as string, String(it.name).trim(), typeof it.sortOrder === 'number' ? it.sortOrder : 0, now)
    );
    await c.env.DB.batch(insertStmts);
    const inserted = await c.env.DB.prepare('SELECT id FROM cat_items WHERE config_id = ? ORDER BY id').bind(configId).all<{ id: number }>();
    const updates: ReturnType<AppEnv['Bindings']['DB']['prepare']>[] = [];
    items.forEach((it, i) => {
      const pi = parentOf.get(i);
      if (pi !== null && pi !== undefined) {
        updates.push(c.env.DB.prepare('UPDATE cat_items SET parent_id = ? WHERE id = ?').bind(inserted.results[pi].id, inserted.results[i].id));
      }
    });
    if (updates.length > 0) await c.env.DB.batch(updates);
  } catch (e) {
    await c.env.DB
      .batch([
        c.env.DB.prepare('DELETE FROM cat_items WHERE config_id = ?').bind(configId),
        c.env.DB.prepare('DELETE FROM cat_configs WHERE id = ?').bind(configId),
      ])
      .catch(() => undefined);
    throw e;
  }

  return ok(c, { configId, version });
});

export default catConfigs;
