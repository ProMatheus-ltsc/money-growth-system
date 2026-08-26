/**
 * Workers 运行时绑定（04 §7.1，wrangler.toml）：
 * - DB: D1 数据库 fam-asset-db（16 表，金额 INTEGER 分）
 * - BACKUP: R2 桶 fam-asset-backups（每日全量备份，保留 30 份）
 * - INVITE_CODE: 登录前置门控邀请码（CR-004：不入仓库，由 wrangler secret/env 注入）
 */
export interface Env {
  DB: D1Database;
  BACKUP: R2Bucket;
  /** 邀请码（登录前置门控）；本地开发经 .dev.vars，线上经 wrangler secret put */
  INVITE_CODE: string;
}
