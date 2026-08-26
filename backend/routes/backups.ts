/**
 * 备份与恢复（05 §3.26~§3.27，F-07，V1.4 移除 R2 后仅本地备份）：
 * - GET  /backups/export  本地 JSON 全量备份下载（§3.26 附件流，唯一非统一响应结构端点）
 * - POST /backups/import  本地 JSON 恢复（同一校验器）
 * V1.4（2026-08-27）：云端备份（R2：列表/手动/restore/pre-restore 留底）已下线——
 * 用户不需要 R2（需绑卡）；备份仅保留本地导出/导入，由用户手工下载留档。
 * users/sessions 不受备份/恢复影响（账号体系独立）。权限：仅 admin。
 */
import { Hono } from 'hono';
import { invalidParam } from '../lib/errors';
import { ok } from '../lib/http';
import type { AppEnv } from '../middleware/auth';
import { requireAdmin, requireAuth } from '../middleware/auth';
import {
  buildExportPayload,
  restoreFromPayload,
  validateBackupPayload,
  type BackupPayload,
} from '../services/backupCore';

const backups = new Hono<AppEnv>();

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
