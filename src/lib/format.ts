/**
 * 展示层格式化工具（04 §6.2）：元/万元换算仅发生在展示层（05 §1.1）
 */

export type Unit = 'yuan' | 'wanyuan';

/** 金额格式化：千分位；万元保留 2 位小数 */
export function fmtMoney(value: number | null | undefined, unit: Unit = 'yuan'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (unit === 'wanyuan') {
    return `${(value / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 万`;
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/** 比率 → 百分比（小数 0.035 → 3.50%） */
export function fmtRate(rate: number | null | undefined, digits = 2): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(digits)}%`;
}

/** 带方向的百分比（环比等）：+3.28% / −1.20% */
export function fmtSignedRate(rate: number | null | undefined, digits = 2): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  const s = (rate * 100).toFixed(digits);
  return rate > 0 ? `+${s}%` : `${s}%`;
}

/** YYYY-MM → 「2026年8月」 */
export function fmtMonth(month: string): string {
  const [y, m] = month.split('-');
  if (!y || !m) return month;
  return `${y}年${Number(m)}月`;
}

/** YYYY-MM → 「2026-08」 原样（输入控件用） */
export function monthValue(month: string): string {
  return month;
}

/** 月份加减（YYYY-MM） */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** 当前月份（客户端近似；服务端以 Asia/Shanghai 为准，写入以服务端校验为权威） */
export function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** 比较月份：a < b → -1 */
export function compareMonth(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 报告类型文案 */
export function reportTypeLabel(t: string): string {
  if (t === 'quarter') return '季报';
  if (t === 'half') return '半年报';
  if (t === 'year') return '年报';
  return t;
}

/** 期间标签：「2026-04 ~ 2026-06」 */
export function periodLabel(startMonth: string, endMonth: string): string {
  return `${startMonth} ~ ${endMonth}`;
}

/** ISO 时间 → 本地可读（yyyy-MM-dd HH:mm） */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 字节数 → 可读 */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 方向标记（色彩不单独承载语义，02-demo-notes：▲/▼ + 文字） */
export function directionMark(diff: number): string {
  if (diff > 0) return '▲';
  if (diff < 0) return '▼';
  return '—';
}
