/**
 * KpiCard — 包装 shared-core StatCard（04 §3.9 行 5 / 06 T16）：
 * 补 ▲▼ 方向标记（02-demo-notes：色彩不单独承载语义）与突出态。
 */
import { StatCard } from '@shared/core/components/stats/StatCard';
import clsx from 'clsx';

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  /** 方向：正/负/平（渲染 ▲/▼/— + 配色） */
  direction?: 'up' | 'down' | 'flat';
  /** 突出显示（如「当月结余」「净现金流」） */
  emphasized?: boolean;
  /** 负值如实红色（净资产为负等，决策 D2） */
  negative?: boolean;
}

export function KpiCard({ label, value, hint, direction, emphasized, negative }: KpiCardProps) {
  const dirMark = direction === 'up' ? '▲ ' : direction === 'down' ? '▼ ' : '';
  const accent = clsx(
    negative ? 'text-red-600' : direction === 'down' ? 'text-red-600' : direction === 'up' ? 'text-emerald-600' : 'text-slate-900',
    emphasized && 'text-blue-700'
  );
  return (
    <div className={clsx(emphasized && 'rounded-lg ring-2 ring-blue-100')}>
      <StatCard label={label} value={`${dirMark}${value}`} hint={hint} accentClassName={accent} />
    </div>
  );
}
