/**
 * useSnapshots — 版本快照 hook（提取自 root-cause-analysis）
 *
 * 针对某条表单记录，提供"保存进度快照 / 查看历史快照 / 删除快照"能力。
 * - 快照按 recordId 分组存储，每次读写后重新拉取列表保证界面数据最新；
 * - 每条记录最多保留 MAX_SNAPSHOTS_PER_RECORD 条，超出删除最旧的，防止无限膨胀；
 * - 依赖公共包 services/db 的快照 CRUD（getSnapshotsByRecord/putSnapshot/deleteSnapshot）。
 */
import { useCallback, useEffect, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { format } from 'date-fns';
import type { Snapshot } from '../types';
import { getSnapshotsByRecord, putSnapshot, deleteSnapshot } from '../services/db';

// 每条记录最多保留的快照数：超过后删除最旧的，避免 IndexedDB 存储无限增长
const MAX_SNAPSHOTS_PER_RECORD = 20;

/**
 * 快照 hook。
 * @param recordId 目标记录的 id；为空时表示没有目标，快照列表清空
 * @returns { snapshots, loading, createSnapshot, removeSnapshot, refresh }
 *   - snapshots：该记录的所有快照，按创建时间从新到旧排序
 *   - createSnapshot：保存一份当前数据的快照（data 用 structuredClone 深拷贝）
 *   - removeSnapshot：按 id 删除某份快照
 *   - refresh：重新拉取快照列表（手动刷新入口）
 */
export function useSnapshots(recordId: string | undefined) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);

  /**
   * 重新从 IndexedDB 拉取快照列表并更新 state。
   * useCallback 包裹 + 依赖 [recordId]：recordId 不变时 refresh 引用稳定，
   * 下面的 useEffect 不会因每次渲染拿到新引用而重复触发。
   */
  const refresh = useCallback(async () => {
    if (!recordId) {
      setSnapshots([]);
      return;
    }
    setLoading(true);
    try {
      const all = await getSnapshotsByRecord(recordId);
      // 按 createdAt 字符串倒序排序（ISO 时间字符串可直接按字典序比较），新的排前面
      all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setSnapshots(all);
    } finally {
      setLoading(false);
    }
  }, [recordId]);

  // 挂载时（或 recordId 变化时）自动拉取一次
  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * 把当前表单数据保存为一份新快照。
   * @param data 要保存的表单数据（structuredClone 深拷贝，避免后续修改串改快照）
   * @param label 快照备注，缺省时自动生成"快照 时间"
   */
  const createSnapshot = useCallback(
    async (data: Record<string, unknown>, label?: string) => {
      if (!recordId) return;
      const snapshot: Snapshot = {
        id: uuid(),
        recordId,
        data: structuredClone(data),
        label: label || `快照 ${format(new Date(), 'MM-dd HH:mm:ss')}`,
        createdAt: new Date().toISOString(),
      };
      await putSnapshot(snapshot);

      // 重新读取最新列表，超出上限时删除最旧的
      const updated = await getSnapshotsByRecord(recordId);
      updated.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (updated.length > MAX_SNAPSHOTS_PER_RECORD) {
        const toDelete = updated.slice(MAX_SNAPSHOTS_PER_RECORD);
        for (const s of toDelete) {
          await deleteSnapshot(s.id);
        }
      }
      await refresh();
    },
    [recordId, refresh],
  );

  /** 按 id 删除一份快照，删除后刷新列表 */
  const removeSnapshot = useCallback(
    async (id: string) => {
      await deleteSnapshot(id);
      await refresh();
    },
    [refresh],
  );

  return { snapshots, loading, createSnapshot, removeSnapshot, refresh };
}

export default useSnapshots;
