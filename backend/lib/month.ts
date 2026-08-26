/**
 * 月份工具：统一 YYYY-MM；「当前月」按 Asia/Shanghai 时区（业务月度以北京时间为准）。
 */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(v: unknown): v is string {
  return typeof v === 'string' && MONTH_RE.test(v);
}

export function currentMonth(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  });
  return fmt.format(now); // "YYYY-MM"
}

export function monthToIndex(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + (m - 1);
}

export function indexToMonth(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

/** b - a（月数） */
export function monthDiff(a: string, b: string): number {
  return monthToIndex(b) - monthToIndex(a);
}

export function addMonths(ym: string, n: number): string {
  return indexToMonth(monthToIndex(ym) + n);
}

/** 含首尾的月份序列（升序） */
export function monthRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let i = monthToIndex(start); i <= monthToIndex(end); i++) out.push(indexToMonth(i));
  return out;
}

export function yearOf(ym: string): number {
  return Number(ym.slice(0, 4));
}

export function monthOf(ym: string): number {
  return Number(ym.slice(5, 7));
}
