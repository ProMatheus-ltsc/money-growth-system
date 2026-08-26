/**
 * 备份 Worker（04 §7.1）：cron 每日 01:00（北京时间）全量导出。
 * 与本地 JSON 备份（§3.26）同一数据格式（schemaVersion: 1），恢复共用同一校验器。
 * 复用主项目 backend/services/backupCore（构建期由 wrangler 一并打包）。
 */
import { BACKUP_PREFIX, buildExportPayload, pruneBackups } from '../../backend/services/backupCore';

interface Env {
  DB: D1Database;
  BACKUP: R2Bucket;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runBackup(env));
  },
};

export async function runBackup(env: Env): Promise<{ key: string; sizeBytes: number }> {
  const payload = await buildExportPayload(env.DB);
  const text = JSON.stringify(payload);
  const sizeBytes = new TextEncoder().encode(text).byteLength;
  const date = new Date().toISOString().slice(0, 10);
  const key = `${BACKUP_PREFIX}${date}.json`;
  await env.BACKUP.put(key, text, { httpMetadata: { contentType: 'application/json' } });
  await pruneBackups(env.BACKUP);
  console.log(`[backup] wrote ${key} (${sizeBytes} bytes)`);
  return { key, sizeBytes };
}
