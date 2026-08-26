/**
 * UnitSwitch — 元/万元全局切换（02 §5 / F-02 验收 5）：仅展示层换算，底层存储为元。
 */
import clsx from 'clsx';
import { useUi } from '../../context/UiContext';

export function UnitSwitch() {
  const { unit, setUnit } = useUi();
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5" role="radiogroup" aria-label="金额单位">
      {(['yuan', 'wanyuan'] as const).map((u) => (
        <button
          key={u}
          type="button"
          role="radio"
          aria-checked={unit === u}
          onClick={() => setUnit(u)}
          className={clsx(
            'rounded-md px-3 py-1 text-xs font-medium transition-colors',
            unit === u ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-800'
          )}
        >
          {u === 'yuan' ? '元' : '万元'}
        </button>
      ))}
    </div>
  );
}
