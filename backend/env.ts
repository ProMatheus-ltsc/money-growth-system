/**
 * Workers 运行时绑定（04 §7.1，wrangler.toml）：
 * - DB: D1 数据库 fam-asset-db（16 表，金额 INTEGER 分）
 * - BACKUP: R2 桶 fam-asset-backups（每日全量备份，保留 30 份）
 */
export interface Env {
  DB: D1Database;
  BACKUP: R2Bucket;
}
