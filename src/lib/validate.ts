/**
 * 前端录入校验（06 T16 / 04 §6.2）：复用 @shared/core formValidation 原语，
 * 叠加项目特有规则；服务端为权威校验（05 各端点校验规则同源）。
 */
import { isEmptyValue } from '@shared/core/utils/formValidation';

export { isEmptyValue };

/** 金额：≥0 且至多 2 位小数（元） */
export function isValidAmount(raw: string | number | null | undefined): boolean {
  if (raw === null || raw === undefined || raw === '') return false;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return false;
  const s = typeof raw === 'string' ? raw.trim() : String(raw);
  if (typeof raw === 'string' && !/^\d+(\.\d{1,2})?$/.test(s)) return false;
  return Math.round(n * 100) === n * 100;
}

/** 金额可空（收益金额：可正可负，至多 2 位小数） */
export function isValidSignedAmount(raw: string | number | null | undefined): boolean {
  if (raw === null || raw === undefined || raw === '') return true; // 空 = 留空
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return false;
  if (typeof raw === 'string' && !/^-?\d+(\.\d{1,2})?$/.test(raw.trim())) return false;
  return Math.round(n * 100) === n * 100;
}

/** 月份 YYYY-MM */
export function isValidMonth(s: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return false;
  return true;
}

/** 用户名：3~20 字符，字母/数字/下划线（05 §3.1） */
export function isValidUsername(s: string): boolean {
  return /^[A-Za-z0-9_]{3,20}$/.test(s);
}

/** 密码：8~64 字符（05 §3.1） */
export function isValidPassword(s: string): boolean {
  return s.length >= 8 && s.length <= 64;
}

/** 名称长度（节点 1~30；分类 1~20；大额明细名称 1~50） */
export function isValidName(s: string, max: number): boolean {
  const t = (s ?? '').trim();
  return t.length >= 1 && t.length <= max;
}

/** 收益率（年化，小数 0~10）可空=继承 */
export function isValidRateInput(raw: string): boolean {
  if (raw.trim() === '') return true;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10;
}

/** 解析输入框中的数字（空 → null） */
export function parseAmount(raw: string): number | null {
  const t = (raw ?? '').trim();
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
