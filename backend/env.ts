/**
 * Workers 运行时绑定（04 §7.1，wrangler.toml）：
 * - DB: D1 数据库 fam-asset-db（16 表，金额 INTEGER 分）
 * - INVITE_CODE: 登录前置门控邀请码（CR-004：不入仓库，由 wrangler secret/env 注入）
 * V1.4（2026-08-27）：移除 BACKUP（R2）绑定——云备份功能下线，备份仅保留本地导出/导入。
 *
 * D1 句柄类型收归 @shared/core/server/d1 的统一声明
 * （与 Cloudflare 官方 D1Database 结构兼容，但换成不依赖类型包的结构化类型，
 *  各项目因此可以用同一套写法：toD1(env.DB)、runBatches、queryAll 等）。
 */
import type { D1WithBatchLike } from '@shared/core/server/d1';

export interface Env {
  /**
   * D1 数据库句柄。
   *
   * 用含 batch 的变体：本项目多处直接调用 `db.batch(...)`，
   * TypeScript 知道它一定在，不必写非空断言。
   */
  DB: D1WithBatchLike;
  /** 邀请码（登录前置门控）；本地开发经 .dev.vars，线上经 wrangler secret 注入 */
  INVITE_CODE: string;
}
