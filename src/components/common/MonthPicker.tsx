/**
 * MonthPicker — 月份选择器（04 §6.2）：驱动全部图表联动重绘。
 * 数据源为已有快照月份序列；同时支持前后月切换。
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fmtMonth } from '../../lib/format';

interface MonthPickerProps {
  months: string[];
  value: string;
  onChange: (month: string) => void;
  disabled?: boolean;
}

export function MonthPicker({ months, value, onChange, disabled }: MonthPickerProps) {
  const idx = months.indexOf(value);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < months.length - 1;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={disabled || !canPrev}
        onClick={() => canPrev && onChange(months[idx - 1])}
        className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="上一月"
      >
        <ChevronLeft size={16} />
      </button>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
        aria-label="选择月份"
      >
        {months.includes(value) ? null : <option value={value}>{fmtMonth(value)}</option>}
        {months.map((m) => (
          <option key={m} value={m}>
            {fmtMonth(m)}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={disabled || !canNext}
        onClick={() => canNext && onChange(months[idx + 1])}
        className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="下一月"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
