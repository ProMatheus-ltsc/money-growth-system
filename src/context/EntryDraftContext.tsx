/**
 * EntryDraftContext（04 §6.2 / 06 T16）：月末录入页草稿。
 * localStorage 持久化（按月份分键），离开页面保留；保存成功后清除当月草稿。
 * 草稿一律为字符串原始输入（保留用户键入形态），提交时再做数值解析。
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface AssetDraftEntry {
  balance: string;
  hasNewFunds: boolean;
  updateSource: 'current' | 'carried';
}

export interface LargeItemDraft {
  direction: 'income' | 'expense';
  catItemId: number;
  name: string;
  amount: string;
}

export interface DebtDraftEntry {
  balance: string;
  /** 非固定还款实录；固定还款无意义（服务端按定额） */
  repayment: string;
}

export interface EntryDraft {
  assets: Record<number, AssetDraftEntry>;
  /** 模块收益金额（原始输入；'' = 留空） */
  gains: Record<number, string>;
  income: Record<number, string>;
  expense: Record<number, string>;
  largeItems: LargeItemDraft[];
  debts: Record<number, DebtDraftEntry>;
  updatedAt: string;
  /** 保存时对应的资产树版本 ID */
  treeConfigId?: number;
  /** nodeId → 节点名称映射，用于资产树版本变更后按名称迁移草稿数据 */
  nodeNames?: Record<number, string>;
  /** 保存时对应的收支分类版本 ID */
  catConfigId?: number;
  /** catItemId → 分类名称映射，用于分类配置版本变更后按名称迁移草稿数据 */
  catItemNames?: Record<number, string>;
}

export function emptyDraft(): EntryDraft {
  return { assets: {}, gains: {}, income: {}, expense: {}, largeItems: [], debts: {}, updatedAt: new Date().toISOString() };
}

const STORAGE_PREFIX = 'fam-entry-draft:';

function readDraft(month: string): EntryDraft | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + month);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EntryDraft;
    if (!parsed || typeof parsed !== 'object' || !parsed.assets) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDraft(month: string, draft: EntryDraft): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + month, JSON.stringify(draft));
  } catch {
    // 存储满等异常静默（草稿为辅助能力）
  }
}

interface EntryDraftContextType {
  getDraft: (month: string) => EntryDraft | null;
  /** updatedAt 由存储层补写，调用方可省略 */
  saveDraft: (month: string, draft: Omit<EntryDraft, 'updatedAt'>) => void;
  clearDraft: (month: string) => void;
}

const EntryDraftContext = createContext<EntryDraftContextType | null>(null);

export function EntryDraftProvider({ children }: { children: React.ReactNode }) {
  const [, bump] = useState(0);

  const getDraft = useCallback((month: string) => readDraft(month), []);
  const saveDraft = useCallback((month: string, draft: Omit<EntryDraft, 'updatedAt'>) => {
    writeDraft(month, { ...draft, updatedAt: new Date().toISOString() });
    bump((n) => n + 1);
  }, []);
  const clearDraft = useCallback((month: string) => {
    localStorage.removeItem(STORAGE_PREFIX + month);
    bump((n) => n + 1);
  }, []);

  const value = useMemo(() => ({ getDraft, saveDraft, clearDraft }), [getDraft, saveDraft, clearDraft]);
  return <EntryDraftContext.Provider value={value}>{children}</EntryDraftContext.Provider>;
}

export function useEntryDraft(): EntryDraftContextType {
  const ctx = useContext(EntryDraftContext);
  if (!ctx) throw new Error('useEntryDraft must be used within EntryDraftProvider');
  return ctx;
}
