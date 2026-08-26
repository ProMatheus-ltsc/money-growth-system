/**
 * UiContext（04 §6.2）：当前月份 / 单位 / 趋势范围 三联动状态。
 * 服务端为唯一权威数据源，这里仅存界面联动参数，不缓存报表数据。
 */
import React, { createContext, useContext, useMemo, useState } from 'react';
import type { Unit } from '../lib/format';
import { currentMonth } from '../lib/format';

export type TrendRange = '12m' | 'year' | 'all';

interface UiContextType {
  month: string;
  setMonth: (m: string) => void;
  unit: Unit;
  setUnit: (u: Unit) => void;
  range: TrendRange;
  setRange: (r: TrendRange) => void;
  year: number;
  setYear: (y: number) => void;
}

const UiContext = createContext<UiContextType | null>(null);

export function UiProvider({ children }: { children: React.ReactNode }) {
  const [month, setMonth] = useState<string>(currentMonth());
  const [unit, setUnit] = useState<Unit>('yuan');
  const [range, setRange] = useState<TrendRange>('12m');
  const [year, setYear] = useState<number>(new Date().getFullYear());

  const value = useMemo(
    () => ({ month, setMonth, unit, setUnit, range, setRange, year, setYear }),
    [month, unit, range, year]
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiContextType {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used within UiProvider');
  return ctx;
}
