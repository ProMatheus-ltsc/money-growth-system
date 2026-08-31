/**
 * 前端录入校验（06 T16 / 04 §6.2）：复用 @shared/core formValidation 原语，
 * 叠加项目特有规则；服务端为权威校验（05 各端点校验规则同源）。
 */
import { isEmptyValue } from '@shared/core/utils/formValidation';

export { isEmptyValue };

/** 金额：≥0 且至多 2 位小数（元）；允许千分位逗号分隔符（如 1,234.56） */
export function isValidAmount(raw: string | number | null | undefined): boolean {
  if (raw === null || raw === undefined || raw === '') return false;
  const s = typeof raw === 'string' ? raw.trim().replace(/,/g, '') : String(raw);
  const n = typeof raw === 'number' ? raw : Number(s);
  if (!Number.isFinite(n) || n < 0) return false;
  if (typeof raw === 'string' && !/^\d+(\.\d{1,2})?$/.test(s)) return false;
  // 两位小数判定用容差（同后端 yuanToCents）：1.1*100=110.00000000000001 等浮点误差不应误判
  return Math.abs(n * 100 - Math.round(n * 100)) <= 1e-6;
}

/** 金额可空（收益金额：可正可负，至多 2 位小数）；允许千分位逗号分隔符 */
export function isValidSignedAmount(raw: string | number | null | undefined): boolean {
  if (raw === null || raw === undefined || raw === '') return true; // 空 = 留空
  const s = typeof raw === 'string' ? raw.trim().replace(/,/g, '') : String(raw);
  const n = typeof raw === 'number' ? raw : Number(s);
  if (!Number.isFinite(n)) return false;
  if (typeof raw === 'string' && !/^-?\d+(\.\d{1,2})?$/.test(s)) return false;
  // 两位小数判定用容差（同后端 yuanToCents）：1.1*100=110.00000000000001 等浮点误差不应误判
  return Math.abs(n * 100 - Math.round(n * 100)) <= 1e-6;
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

/** 解析输入框中的数字（空 → null）；允许千分位逗号分隔符 */
export function parseAmount(raw: string): number | null {
  const t = (raw ?? '').trim().replace(/,/g, '');
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
