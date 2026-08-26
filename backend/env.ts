/**
 * Workers 运行时绑定（04 §7.1，wrangler.toml）：
 * - DB: D1 数据库 fam-asset-db（16 表，金额 INTEGER 分）
 * - INVITE_CODE: 登录前置门控邀请码（CR-004：不入仓库，由 wrangler secret/env 注入）
 * V1.4（2026-08-27）：移除 BACKUP（R2）绑定——云备份功能下线，备份仅保留本地导出/导入。
 */
export interface Env {
  DB: D1Database;
  /** 邀请码（登录前置门控）；本地开发经 .dev.vars，线上经 wrangler secret 注入 */
  INVITE_CODE: string;
}
