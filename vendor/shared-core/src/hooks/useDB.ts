/**
 * 数据操作 Hooks：封装 IndexedDB CRUD 为 React Hooks
 * 复用自 root-cause-analysis / personal_review_system
 */
import { useState, useEffect, useCallback } from 'react';
import type { FormRecord } from '../types';
import {
  getAllRecords,
  getRecord,
  putRecord,
  deleteRecord,
  deleteRecords,
  getRecordsByTemplate,
  getRecordsByModule,
  searchRecords,
} from '../services/db';

export function useRecords(templateId?: string, module?: string) {
  const [records, setRecords] = useState<FormRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      let data: FormRecord[];
      if (templateId) {
        data = await getRecordsByTemplate(templateId);
      } else if (module) {
        data = await getRecordsByModule(module);
      } else {
        data = await getAllRecords();
      }
      // 按更新时间倒序
      data.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setRecords(data);
    } catch (e) {
      console.error('加载记录失败:', e);
    } finally {
      setLoading(false);
    }
  }, [templateId, module]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { records, loading, refresh };
}

export function useRecord(id: string | undefined) {
  const [record, setRecord] = useState<FormRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      setRecord(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    getRecord(id)
      .then((r) => setRecord(r ?? null))
      .catch(() => setRecord(null))
      .finally(() => setLoading(false));
  }, [id]);

  return { record, loading };
}

export function useSaveRecord() {
  const [saving, setSaving] = useState(false);

  const save = useCallback(async (record: FormRecord): Promise<boolean> => {
    setSaving(true);
    try {
      await putRecord(record);
      return true;
    } catch (e) {
      console.error('保存失败:', e);
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { save, saving };
}

export function useDeleteRecord() {
  const [deleting, setDeleting] = useState(false);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    setDeleting(true);
    try {
      await deleteRecord(id);
      return true;
    } catch (e) {
      console.error('删除失败:', e);
      return false;
    } finally {
      setDeleting(false);
    }
  }, []);

  const removeMany = useCallback(async (ids: string[]): Promise<boolean> => {
    setDeleting(true);
    try {
      await deleteRecords(ids);
      return true;
    } catch (e) {
      console.error('批量删除失败:', e);
      return false;
    } finally {
      setDeleting(false);
    }
  }, []);

  return { remove, removeMany, deleting };
}

export function useSearchRecords() {
  const [results, setResults] = useState<FormRecord[]>([]);
  const [searching, setSearching] = useState(false);

  const search = useCallback(async (query: string) => {
    setSearching(true);
    try {
      const data = await searchRecords(query);
      data.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setResults(data);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  return { results, searching, search };
}
