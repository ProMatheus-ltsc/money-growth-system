/**
 * 金额口径（05 §1.1）：API 层「元」（≤2 位小数），存储「分」（INTEGER）。
 * 转换只发生在服务端边界，杜绝浮点误差。
 */
import type { ErrorDetail } from './errors';

export function centsToYuan(cents: number): number {
  return cents / 100;
}

/**
 * 元 → 分。非法时把错误推入 errors 并返回 null（调用方统一抛 INVALID_PARAM）。
 * opts.min 默认 0；传 -Infinity 允许负数（收益金额）。
 */
export function yuanToCents(
  v: unknown,
  field: string,
  errors: ErrorDetail[],
  opts: { min?: number; required?: boolean; label?: string } = {}
): number | null {
  const required = opts.required !== false;
  const min = opts.min ?? 0;
  const label = opts.label ?? field;
  if (v === undefined || v === null) {
    if (required) errors.push({ field, message: `${label}为必填项` });
    return null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push({ field, message: `${label}必须为数字` });
    return null;
  }
  const cents = Math.round(v * 100);
  if (Math.abs(v * 100 - cents) > 1e-6) {
    errors.push({ field, message: `${label}最多保留两位小数` });
    return null;
  }
  if (cents < Math.round(min * 100)) {
    errors.push({
      field,
      message: min === 0 ? `${label}不能为负数` : `${label}不能小于 ${min}`,
    });
    return null;
  }
  return cents;
}

/** 元数值校验（不转分），用于比率/收益率等 */
export function numberField(
  v: unknown,
  field: string,
  errors: ErrorDetail[],
  opts: { min?: number; max?: number; label?: string } = {}
): number | null {
  const label = opts.label ?? field;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push({ field, message: `${label}必须为数字` });
    return null;
  }
  if (opts.min !== undefined && v < opts.min) {
    errors.push({ field, message: `${label}不能小于 ${opts.min}` });
    return null;
  }
  if (opts.max !== undefined && v > opts.max) {
    errors.push({ field, message: `${label}不能大于 ${opts.max}` });
    return null;
  }
  return v;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
