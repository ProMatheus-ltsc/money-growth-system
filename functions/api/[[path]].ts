/**
 * Pages Functions 入口：挂载 Hono 应用，承接 /api/* 全部端点（04 §7.1 / 05 §2）。
 * 静态资源由 Pages 静态层处理，非 /api/* 请求不会进入本函数。
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import { app } from '../../backend/app';
import type { Env } from '../../backend/env';

export const onRequest: PagesFunction<Env> = async (context) => {
  // Hono 第三参（ExecutionContext）本应用未使用（无 waitUntil 需求），省略
  return app.fetch(context.request, context.env);
};
