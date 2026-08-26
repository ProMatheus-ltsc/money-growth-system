/**
 * 统一响应封装（05 §1.2）：{ success, data, error }。
 */
import type { Context } from 'hono';
import type { ErrorDetail } from './errors';

/** 成功响应：{ success: true, data, error: null } */
export function ok(c: Context, data: unknown, status: 200 | 201 = 200) {
  return c.json({ success: true, data, error: null }, status);
}

/** 失败响应：{ success: false, data: null, error: { code, message, details? } } */
export function fail(
  c: Context,
  code: string,
  message: string,
  status: number,
  details?: ErrorDetail[]
) {
  const error: { code: string; message: string; details?: ErrorDetail[] } = { code, message };
  if (details && details.length > 0) error.details = details;
  return c.json({ success: false, data: null, error }, status as 400);
}
