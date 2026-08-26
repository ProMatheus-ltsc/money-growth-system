/**
 * useMonthlySnapshots — shared-core useSnapshots 的 REST 适配层（04 §3.9 行 10 / 06 T16）。
 * 上游实现依赖 IndexedDB 快照 CRUD；本项目月度快照在服务端 D1，
 * 按同形态接口（列表/加载态/刷新）适配为 GET /api/snapshots。
 * 展示层沿用 VersionHistoryList（行 9：月度历史导航，「恢复」=切换至该月）。
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { MonthSummary, SnapshotsListData } from '../lib/types';

interface UseMonthlySnapshotsResult {
  months: MonthSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useMonthlySnapshots(range: '12m' | 'year' | 'all' = 'all'): UseMonthlySnapshotsResult {
  const [months, setMonths] = useState<MonthSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<SnapshotsListData>('/api/snapshots', { query: { range } });
      setMonths(data.months);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { months, loading, error, refresh };
}
