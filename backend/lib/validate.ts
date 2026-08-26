/**
 * 通用字段校验原语：非法时推入 errors，调用方统一抛 INVALID_PARAM（details 逐条）。
 */
import type { ErrorDetail } from './errors';
import { invalidParam } from './errors';

/** URL 路径参数 id 解析（CR-021）：非法 id 抛 400 INVALID_PARAM，而非依赖 D1 绑定语义（避免 500） */
export function idParam(raw: string, label = 'id'): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw invalidParam(`${label} 必须为正整数`, [{ field: label, message: `非法 ${label}：${raw}` }]);
  }
  return id;
}

export function strField(
  v: unknown,
  field: string,
  errors: ErrorDetail[],
  opts: { min?: number; max?: number; required?: boolean; label?: string; pattern?: RegExp; patternMsg?: string } = {}
): string | null {
  const required = opts.required !== false;
  const label = opts.label ?? field;
  if (typeof v !== 'string') {
    if (required) errors.push({ field, message: `${label}为必填字符串` });
    return null;
  }
  const s = v.trim();
  const min = opts.min ?? 1;
  if (s.length < min) {
    errors.push({ field, message: `${label}至少 ${min} 个字符` });
    return null;
  }
  if (opts.max !== undefined && s.length > opts.max) {
    errors.push({ field, message: `${label}不能超过 ${opts.max} 个字符` });
    return null;
  }
  if (opts.pattern && !opts.pattern.test(s)) {
    errors.push({ field, message: opts.patternMsg ?? `${label}格式非法` });
    return null;
  }
  return s;
}

export function boolField(v: unknown, field: string, errors: ErrorDetail[], fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') {
    errors.push({ field, message: `${field} 必须为布尔值` });
    return fallback;
  }
  return v;
}

export function enumField<T extends string>(
  v: unknown,
  field: string,
  errors: ErrorDetail[],
  allowed: readonly T[],
  label?: string
): T | null {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    errors.push({ field, message: `${label ?? field}取值必须为 ${allowed.join('/')} 之一` });
    return null;
  }
  return v as T;
}

export function intField(
  v: unknown,
  field: string,
  errors: ErrorDetail[],
  opts: { min?: number; label?: string } = {}
): number | null {
  const label = opts.label ?? field;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    errors.push({ field, message: `${label}必须为整数` });
    return null;
  }
  if (opts.min !== undefined && v < opts.min) {
    errors.push({ field, message: `${label}必须 ≥ ${opts.min}` });
    return null;
  }
  return v;
}

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
