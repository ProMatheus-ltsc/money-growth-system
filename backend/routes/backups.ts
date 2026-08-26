/**
 * 备份与恢复（05 §3.23~§3.27，F-07）：
 * - GET  /backups         云端备份列表 + 策略
 * - POST /backups         手动生成云端备份（与定时备份同结构同校验器）
 * - POST /backups/restore 从云端备份恢复（先校验后写入；非法拒绝且数据不变）
 * - GET  /backups/export  本地 JSON 全量备份下载（§3.26 附件流，唯一非统一响应结构端点）
 * - POST /backups/import  本地 JSON 恢复（同一校验器）
 * users/sessions 不受备份/恢复影响（账号体系独立）。权限：仅 admin。
 */
import { Hono } from 'hono';
import { invalidParam, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';
import {
  BACKUP_PREFIX,
  BACKUP_RETENTION,
  buildExportPayload,
  pruneBackups,
  restoreFromPayload,
  validateBackupPayload,
  type BackupPayload,
} from '../services/backupCore';

const backups = new Hono<AppEnv>();

// §3.23 云端备份列表
backups.get('/', requireAuth, requireAdmin, async (c) => {
  const listed = await c.env.BACKUP.list({ prefix: BACKUP_PREFIX });
  const list = [...listed.objects]
    .sort((a, b) => (a.uploaded < b.uploaded ? 1 : -1))
    .map((o) => ({ key: o.key, sizeBytes: o.size, createdAt: o.uploaded.toISOString() }));
  return ok(c, { backups: list, policy: { cron: '每日 01:00', retention: BACKUP_RETENTION } });
});

// §3.24 手动生成备份
backups.post('/', requireAuth, requireAdmin, async (c) => {
  const payload = await buildExportPayload(c.env.DB);
  const text = JSON.stringify(payload);
  const sizeBytes = new TextEncoder().encode(text).byteLength;
  const date = new Date().toISOString().slice(0, 10);
  const key = `${BACKUP_PREFIX}${date}-manual.json`;
  await c.env.BACKUP.put(key, text, { httpMetadata: { contentType: 'application/json' } });
  await pruneBackups(c.env.BACKUP);
  return ok(c, { key, sizeBytes, createdAt: new Date().toISOString() });
});

// §3.25 从云端备份恢复
backups.post('/restore', requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key : '';
  if (!key) throw invalidParam('key 为必填项');
  const obj = await c.env.BACKUP.get(key);
  if (!obj) throw notFound(`备份对象不存在：${key}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await obj.text());
  } catch {
    throw invalidParam('备份文件校验失败，现有数据未变更', [{ field: 'payload', message: '备份内容不是合法 JSON' }]);
  }
  const errors = validateBackupPayload(parsed);
  if (errors.length > 0) throw invalidParam('备份文件校验失败，现有数据未变更', errors);
  const result = await restoreFromPayload(c.env.DB, parsed as BackupPayload);
  return ok(c, result);
});

// §3.26 本地 JSON 备份下载（统一响应结构的唯一例外：直接返回 JSON 文件流）
backups.get('/export', requireAuth, requireAdmin, async (c) => {
  const payload = await buildExportPayload(c.env.DB);
  const date = new Date().toISOString().slice(0, 10);
  return c.body(JSON.stringify(payload), 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="fam-asset-backup-${date}.json"`,
  });
});

// §3.27 本地 JSON 恢复
backups.post('/import', requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { payload?: unknown } | null;
  if (!body || typeof body !== 'object' || body.payload === undefined) {
    throw invalidParam('请求体必须为 { payload: <备份内容> }');
  }
  const errors = validateBackupPayload(body.payload);
  if (errors.length > 0) throw invalidParam('备份文件校验失败，现有数据未变更', errors);
  const result = await restoreFromPayload(c.env.DB, body.payload as BackupPayload);
  return ok(c, result);
});

export default backups;
