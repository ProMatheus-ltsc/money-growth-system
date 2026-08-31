/**
 * 月末录入页（UI-02 + UI-09 + UI-05；F-02/F-02b/F-02c/F-03/F-06/F-12，06 T18/T19）
 * - 资产区：树折叠、仅末级录入、上级实时汇总、新增资金标记；有新增模块出现「收益金额」
 *   （模块级，可正可负可留空，右侧实时「→ 折算 x.xx%」= 收益金额 ÷ 上月模块余额，上月为 0 提示不折算）
 * - 沿用上期（carried）输入禁用 +「本期更新」一次性解锁（F-12/决策 D5）
 * - 收支区：二级分类（一级 = 二级之和）、≥阈值大额明细（└ 前缀、可删除）、⚙ 分类配置弹窗（版本化）
 * - 负债块：固定定额徽标 / 非固定实录输入
 * - 草稿：EntryDraftContext（localStorage，离开保留）；保存成功清除
 * - 历史月：锁定 + 纠错痕迹；「发起纠错」→ 编辑 → 对比表 + 勾选确认（05 §3.22）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@shared/core/hooks/useToast';
import { LoadingSpinner } from '@shared/core/components/LoadingSpinner';
import { ChevronDown, ChevronRight, Settings, Trash2, TrendingDown } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { addMonths, compareMonth, currentMonth, fmtMonth, fmtMoney, fmtRate } from '../lib/format';
import type { CatConfig, Debt, DebtTotals, SnapshotDetail, SnapshotsListData, TreeConfig, TreeNode } from '../lib/types';
import { isValidAmount, isValidName, isValidSignedAmount, parseAmount } from '../lib/validate';

interface DepreciationValue {
  nodeId: number;
  currentValue: number;
  method: 'straight' | 'sum_of_years';
  isFullyDepreciated: boolean;
}
import { useEntryDraft, type LargeItemDraft } from '../context/EntryDraftContext';
import { CatConfigDialog } from '../components/entry/CatConfigDialog';
import { CorrectDialog } from '../components/entry/CorrectDialog';
import { LargeItemDialog } from '../components/entry/LargeItemDialog';
import { useMonthlySnapshots } from '../adapters/useMonthlySnapshots';
import { VersionHistoryList } from '@shared/core/components/VersionHistoryList';
import type { Snapshot } from '@shared/core/types';

// ---------- 内部类型 ----------
interface AssetEntry {
  balance: string; // 原始输入
  hasNewFunds: boolean;
  updateSource: 'current' | 'carried';
}

interface DebtEntry {
  balance: string;
  repayment: string;
}

interface FormState {
  assets: Record<number, AssetEntry>;
  gains: Record<number, string>; // 模块收益金额原始输入（'' = 留空）
  income: Record<number, string>; // catItemId → 金额
  expense: Record<number, string>;
  largeItems: LargeItemDraft[];
  debts: Record<number, DebtEntry>;
}

const emptyForm = (): FormState => ({ assets: {}, gains: {}, income: {}, expense: {}, largeItems: [], debts: {} });

/** 纠错窗口（自然月数）：仅支持最近 20 个月；快照永久保存，更早数据仅供查看（05 §3.22 F-06） */
const CORRECT_WINDOW_MONTHS = 20;

type Mode = 'current-new' | 'current-overwrite' | 'history-locked' | 'history-correct' | 'no-snapshot-past' | 'future';

export default function EntryPage() {
  const { showToast } = useToast();
  const { getDraft, saveDraft, clearDraft } = useEntryDraft();

  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);
  const [tree, setTree] = useState<TreeConfig | null>(null);
  const [catConfig, setCatConfig] = useState<CatConfig | null>(null);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [debtTotals, setDebtTotals] = useState<DebtTotals | null>(null);
  const [detail, setDetail] = useState<SnapshotDetail | null>(null);
  const [snapList, setSnapList] = useState<SnapshotsListData | null>(null);
  const [mode, setMode] = useState<Mode>('current-new');
  const [form, setForm] = useState<FormState>(emptyForm());
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [expandedCats, setExpandedCats] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<Set<string>>(new Set());
  const [correcting, setCorrecting] = useState(false); // 纠错弹窗开
  const [catDialogOpen, setCatDialogOpen] = useState(false);
  const [largeDialog, setLargeDialog] = useState<{ direction: 'income' | 'expense'; catItemId: number } | null>(null);
  const [depValues, setDepValues] = useState<Map<number, DepreciationValue>>(new Map());

  // 已保存月份历史（useMonthlySnapshots REST 适配 + VersionHistoryList 展示，04 §3.9 行 9/10）
  // 列表仅展示最近 20 个月（纠错窗口）；快照永久保存，更早月份仍可经顶部月份切换查看
  const { months: historyMonths, loading: historyLoading, refresh: refreshHistory } = useMonthlySnapshots('all');
  const savedSnapshots: Snapshot[] = useMemo(() => {
    const cutoff = addMonths(currentMonth(), -(CORRECT_WINDOW_MONTHS - 1));
    return historyMonths
      .filter((m) => m.month >= cutoff)
      .map((m) => ({
        id: m.month,
        recordId: 'monthly-entry',
        label: `${fmtMonth(m.month)} · 总资产 ${fmtMoney(m.totalAssets)} · 结余 ${fmtMoney(m.balance)}${m.corrected ? ' · 已纠错' : ''}`,
        createdAt: `${m.month}-28T12:00:00`,
        data: {},
      }));
  }, [historyMonths]);

  // ---------- 数据加载 ----------
  const load = useCallback(async () => {
    setLoading(true);
    setSaved(false);
    try {
      const [treeRes, catRes, debtRes, detailRes, listRes] = await Promise.all([
        api<TreeConfig>('/api/tree'),
        api<CatConfig>('/api/cat-configs'),
        api<{ debts: Debt[]; totals: DebtTotals }>('/api/debts', { query: { month } }),
        api<SnapshotDetail>(`/api/snapshots/${month}`),
        api<SnapshotsListData>('/api/snapshots', { query: { range: 'all' } }).catch(() => null),
      ]);
      setTree(treeRes);
      setCatConfig(catRes);
      setDebts(debtRes.debts);
      setDebtTotals(debtRes.totals);
      setDetail(detailRes);
      setSnapList(listRes);

      // 加载折旧估值（实物资产叶子节点参考值）
      try {
        const depRes = await api<{ items: { nodeId: number; currentValue: number; method: string; isFullyDepreciated: boolean }[] }>(
          '/api/depreciation', { query: { configId: String(treeRes.configId), month } }
        );
        const map = new Map<number, DepreciationValue>();
        for (const d of depRes.items) {
          map.set(d.nodeId, { nodeId: d.nodeId, currentValue: d.currentValue, method: d.method as 'straight' | 'sum_of_years', isFullyDepreciated: d.isFullyDepreciated });
        }
        setDepValues(map);
      } catch { setDepValues(new Map()); }

      // 判定模式
      const cur = currentMonth();
      let m: Mode;
      if (compareMonth(month, cur) > 0) m = 'future';
      else if (detailRes.exists) m = detailRes.locked ? 'history-locked' : 'current-overwrite';
      else m = 'current-new';
      setMode(m);

      // 表单初始化（草稿 > 快照 > 模板）
      const draft = getDraft(month);
      if (draft && Object.keys(draft.assets).length > 0) {
        const base = detailRes.exists
          ? formFromSnapshot(detailRes, debtRes.debts)
          : formFromTemplate(detailRes, debtRes.debts, catRes);
        // 草稿节点ID可能与当前资产树不匹配（资产树更新后ID变化），按名称迁移
        let migratedAssets = draft.assets;
        let migratedGains = draft.gains;
        const currentNodeIds = new Set(treeRes.nodes.map((n) => n.id));
        const draftAssetIds = Object.keys(draft.assets).map(Number);
        const hasOrphanIds = draftAssetIds.some((id) => !currentNodeIds.has(id));
        if (hasOrphanIds) {
          const nameToNewId = new Map<string, number>();
          for (const n of treeRes.nodes) nameToNewId.set(n.name, n.id);
          const draftNames = draft.nodeNames;
          const newAssets: Record<number, AssetEntry> = {};
          for (const [oldIdStr, entry] of Object.entries(draft.assets)) {
            const oldId = Number(oldIdStr);
            if (currentNodeIds.has(oldId)) {
              newAssets[oldId] = entry;
            } else if (draftNames) {
              const nodeName: string | undefined = draftNames[oldId];
              const newId = nodeName ? nameToNewId.get(nodeName) : undefined;
              if (newId !== undefined) newAssets[newId] = entry;
            }
          }
          const newGains: Record<number, string> = {};
          for (const [oldIdStr, val] of Object.entries(draft.gains)) {
            const oldId = Number(oldIdStr);
            if (currentNodeIds.has(oldId)) {
              newGains[oldId] = val;
            } else if (draftNames) {
              const nodeName: string | undefined = draftNames[oldId];
              const newId = nodeName ? nameToNewId.get(nodeName) : undefined;
              if (newId !== undefined) newGains[newId] = val;
            }
          }
          migratedAssets = newAssets;
          migratedGains = newGains;
        }
        // 收支分类 ID 迁移（分类配置版本更新后 catItemId 变化）
        let migratedIncome = draft.income;
        let migratedExpense = draft.expense;
        let migratedLargeItems = draft.largeItems;
        const currentCatIds = new Set<number>();
        for (const dir of ['income', 'expense'] as const) {
          for (const top of catRes[dir]) {
            currentCatIds.add(top.id);
            for (const child of top.children ?? []) currentCatIds.add(child.id);
          }
        }
        const draftCatIds = [...Object.keys(draft.income), ...Object.keys(draft.expense)].map(Number);
        const hasOrphanCatIds = draftCatIds.some((id) => !currentCatIds.has(id));
        if (hasOrphanCatIds) {
          const catNameToNewId = new Map<string, number>();
          for (const dir of ['income', 'expense'] as const) {
            for (const top of catRes[dir]) {
              catNameToNewId.set(top.name, top.id);
              for (const child of top.children ?? []) catNameToNewId.set(`${top.name}>${child.name}`, child.id);
            }
          }
          const draftCatNames = draft.catItemNames;
          const migrateCatRecord = (rec: Record<number, string>): Record<number, string> => {
            const result: Record<number, string> = {};
            for (const [oldIdStr, val] of Object.entries(rec)) {
              const oldId = Number(oldIdStr);
              if (currentCatIds.has(oldId)) {
                result[oldId] = val;
              } else if (draftCatNames) {
                const catName: string | undefined = draftCatNames[oldId];
                const newId = catName ? catNameToNewId.get(catName) : undefined;
                if (newId !== undefined) result[newId] = val;
              }
            }
            return result;
          };
          migratedIncome = migrateCatRecord(draft.income);
          migratedExpense = migrateCatRecord(draft.expense);
          if (draft.largeItems.length > 0 && draftCatNames) {
            migratedLargeItems = draft.largeItems.map((li) => {
              if (currentCatIds.has(li.catItemId)) return li;
              const catName: string | undefined = draftCatNames[li.catItemId];
              const newId = catName ? catNameToNewId.get(catName) : undefined;
              return newId !== undefined ? { ...li, catItemId: newId } : li;
            }).filter((li) => currentCatIds.has(li.catItemId));
          }
        }
        setForm({
          assets: { ...base.assets, ...migratedAssets },
          gains: { ...base.gains, ...migratedGains },
          income: { ...base.income, ...migratedIncome },
          expense: { ...base.expense, ...migratedExpense },
          largeItems: migratedLargeItems.length > 0 ? migratedLargeItems : base.largeItems,
          debts: { ...base.debts, ...draft.debts },
        });
      } else if (detailRes.exists) {
        setForm(formFromSnapshot(detailRes, debtRes.debts));
      } else {
        setForm(formFromTemplate(detailRes, debtRes.debts, catRes));
      }
    } catch (e) {
      const ae = e as ApiError;
      if (ae.status === 400) {
        // 非法月份等
        setMode('future');
        showToast(ae.message, 'warning');
      } else {
        showToast(ae.message ?? '加载失败', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [month, getDraft, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const editable = mode === 'current-new' || mode === 'current-overwrite' || mode === 'history-correct';

  // 草稿持久化（仅可编辑模式；附带版本ID + 名称映射用于版本迁移）
  useEffect(() => {
    if (!editable || loading || !tree || !catConfig) return;
    const nodeNames: Record<number, string> = {};
    for (const n of tree.nodes) nodeNames[n.id] = n.name;
    const catItemNames: Record<number, string> = {};
    for (const dir of ['income', 'expense'] as const) {
      for (const top of catConfig[dir]) {
        catItemNames[top.id] = top.name;
        for (const child of top.children ?? []) catItemNames[child.id] = `${top.name}>${child.name}`;
      }
    }
    const t = setTimeout(() => saveDraft(month, {
      ...form,
      treeConfigId: tree.configId,
      nodeNames,
      catConfigId: catConfig.configId,
      catItemNames,
    }), 300);
    return () => clearTimeout(t);
  }, [form, editable, loading, month, saveDraft, tree, catConfig]);

  // ---------- 树工具 ----------
  const nodes = useMemo(() => tree?.nodes ?? [], [tree]);
  const childrenOf = useCallback(
    (parentId: number | null) => nodes.filter((n) => n.parentId === parentId && n.enabled).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [nodes]
  );
  const leafSet = useMemo(() => {
    const hasChild = new Set(nodes.filter((n) => n.parentId !== null).map((n) => n.parentId));
    return new Set(nodes.filter((n) => n.enabled && !hasChild.has(n.id)).map((n) => n.id));
  }, [nodes]);

  const balanceOf = useCallback(
    (nodeId: number): number => {
      const kids = nodes.filter((n) => n.parentId === nodeId && n.enabled);
      if (kids.length === 0 || leafSet.has(nodeId)) {
        return parseAmount(form.assets[nodeId]?.balance ?? '') ?? 0;
      }
      return kids.reduce((s, k) => s + balanceOf(k.id), 0);
    },
    [nodes, leafSet, form.assets]
  );

  // ---------- 字段更新 ----------
  const patchAsset = (nodeId: number, patch: Partial<AssetEntry>) => {
    setSaved(false);
    setForm((f) => {
      const cur: AssetEntry = f.assets[nodeId] ?? { balance: '', hasNewFunds: false, updateSource: 'current' };
      const assets = { ...f.assets, [nodeId]: { ...cur, ...patch } };
      // 取消「新增」后收益金额输入框隐藏：同步清掉残留值，避免隐藏字段仍被校验拦截
      let gains = f.gains;
      if (patch.hasNewFunds === false && gains[nodeId] !== undefined) {
        const g = { ...gains };
        delete g[nodeId];
        gains = g;
      }
      return { ...f, assets, gains };
    });
  };
  const patchGain = (moduleId: number, value: string) => {
    setSaved(false);
    setForm((f) => ({ ...f, gains: { ...f.gains, [moduleId]: value } }));
  };
  const patchCat = (direction: 'income' | 'expense', catItemId: number, value: string) => {
    setSaved(false);
    setForm((f) => ({ ...f, [direction]: { ...f[direction], [catItemId]: value } }));
  };
  const patchDebt = (debtId: number, patch: Partial<DebtEntry>) => {
    setSaved(false);
    setForm((f) => {
      const cur: DebtEntry = f.debts[debtId] ?? { balance: '', repayment: '' };
      return { ...f, debts: { ...f.debts, [debtId]: { ...cur, ...patch } } };
    });
  };
  const addLargeItem = (item: LargeItemDraft) => {
    setSaved(false);
    setForm((f) => ({ ...f, largeItems: [...f.largeItems, item] }));
  };
  const removeLargeItem = (idx: number) => {
    setForm((f) => ({ ...f, largeItems: f.largeItems.filter((_, i) => i !== idx) }));
  };

  // ---------- 汇总（实时勾稽预览，含自动折旧资产） ----------
  const totals = useMemo(() => {
    const totalAssets = [...leafSet].reduce((s, id) => {
      const node = nodes.find((n) => n.id === id);
      const isPhys = node?.assetCategory === 'physical';
      const dv = depValues.get(id);
      if (isPhys && dv && !dv.isFullyDepreciated) {
        return s + Math.round(dv.currentValue * 100) / 100;
      }
      return s + (parseAmount(form.assets[id]?.balance ?? '') ?? 0);
    }, 0);
    const totalIncome = Object.values(form.income).reduce((s, v) => s + (parseAmount(v) ?? 0), 0);
    const totalExpense = Object.values(form.expense).reduce((s, v) => s + (parseAmount(v) ?? 0), 0);
    const totalDebt = debts.filter((d) => d.enabled).reduce((s, d) => s + (parseAmount(form.debts[d.id]?.balance ?? '') ?? 0), 0);
    return {
      totalAssets,
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
      totalDebt,
      netWorth: totalAssets - totalDebt,
      debtRatio: totalAssets > 0 ? totalDebt / totalAssets : null,
    };
  }, [form, leafSet, debts, nodes, depValues]);

  // ---------- 保存 ----------
  const buildPayload = () => {
    if (!tree || !catConfig) return null;
    const assets = [...leafSet].map((nodeId) => {
      const a = form.assets[nodeId] ?? { balance: '0', hasNewFunds: false, updateSource: 'current' as const };
      const dv = depValues.get(nodeId);
      const node = nodes.find((n) => n.id === nodeId);
      const isPhys = node?.assetCategory === 'physical';
      let balance = parseAmount(a.balance) ?? 0;
      if (isPhys && dv && !dv.isFullyDepreciated) {
        balance = Math.round(dv.currentValue * 100) / 100;
      }
      return {
        nodeId,
        balance,
        hasNewFunds: isPhys ? false : a.hasNewFunds,
        updateSource: a.updateSource,
      };
    });
    const moduleGains = [...leafSet]
      .filter((id) => {
        const a = form.assets[id];
        const nd = nodes.find((n) => n.id === id);
        return a?.hasNewFunds && nd?.assetCategory !== 'physical';
      })
      .map((id) => ({ nodeId: id, gain: parseAmount(form.gains[id] ?? '') }));
    const catLeaves = (direction: 'income' | 'expense') =>
      (direction === 'income' ? catConfig.income : catConfig.expense).flatMap((top) => (top.children ?? []).map((c) => c.id));
    const income = catLeaves('income').map((catItemId) => ({ catItemId, amount: parseAmount(form.income[catItemId] ?? '') ?? 0 }));
    const expense = catLeaves('expense').map((catItemId) => ({ catItemId, amount: parseAmount(form.expense[catItemId] ?? '') ?? 0 }));
    const largeItems = form.largeItems.map((li) => ({
      direction: li.direction,
      catItemId: li.catItemId,
      name: li.name,
      amount: parseAmount(li.amount) ?? 0,
    }));
    const debtPayload = debts
      .filter((d) => d.enabled)
      .map((d) => ({
        debtId: d.id,
        balance: parseAmount(form.debts[d.id]?.balance ?? '') ?? 0,
        repayment: d.fixedRepayment ? null : parseAmount(form.debts[d.id]?.repayment ?? '') ?? 0,
      }));
    return {
      treeConfigId: tree.configId,
      catConfigId: catConfig.configId,
      assets,
      moduleGains,
      income,
      expense,
      largeItems,
      debts: debtPayload,
    };
  };

  const validateLocal = (): string[] => {
    const errs: string[] = [];
    const badFields = new Set<string>();
    const nodeName = (id: number) => nodes.find((n) => n.id === id)?.name ?? `资产项`;
    for (const id of leafSet) {
      const node = nodes.find((n) => n.id === id);
      const isPhys = node?.assetCategory === 'physical';
      const dv = depValues.get(id);
      if (isPhys && dv && !dv.isFullyDepreciated) continue;
      const a = form.assets[id];
      if (!a || a.balance.trim() === '') errs.push(`「${nodeName(id)}」尚未填写余额`);
      else if (!isValidAmount(a.balance)) errs.push(`「${nodeName(id)}」余额请填写非负数（最多两位小数）`);
    }
    for (const [k, v] of Object.entries(form.gains)) {
      const id = Number(k);
      const nd = nodes.find((n) => n.id === id);
      // 仅校验当前展示/提交的收益金额（叶子 + 非实物 + 已勾选「新增」），
      // 与 buildPayload 的 moduleGains 口径一致；取消「新增」后的残留值不再拦截保存
      const eligible = leafSet.has(id) && nd?.assetCategory !== 'physical' && form.assets[id]?.hasNewFunds === true;
      if (!eligible) continue;
      if (v.trim() !== '' && !isValidSignedAmount(v)) errs.push(`「${nodeName(id)}」收益金额格式有误，请填写数字（可正可负，最多两位小数）`);
    }
    const validCatIds = new Set<number>();
    const catNameMap = new Map<number, string>();
    if (catConfig) {
      for (const dir of ['income', 'expense'] as const) {
        for (const top of catConfig[dir]) {
          validCatIds.add(top.id);
          catNameMap.set(top.id, top.name);
          for (const child of top.children ?? []) {
            validCatIds.add(child.id);
            catNameMap.set(child.id, `${top.name}/${child.name}`);
          }
        }
      }
    }
    for (const [k, v] of Object.entries(form.income)) {
      const catId = Number(k);
      if (!validCatIds.has(catId)) continue;
      if (v.trim() !== '' && !isValidAmount(v)) {
        badFields.add(`income:${catId}`);
        errs.push(`收入「${catNameMap.get(catId) ?? catId}」金额格式有误（输入: "${v}"），请填写非负数`);
      }
    }
    for (const [k, v] of Object.entries(form.expense)) {
      const catId = Number(k);
      if (!validCatIds.has(catId)) continue;
      if (v.trim() !== '' && !isValidAmount(v)) {
        badFields.add(`expense:${catId}`);
        errs.push(`支出「${catNameMap.get(catId) ?? catId}」金额格式有误（输入: "${v}"），请填写非负数`);
      }
    }
    const threshold = catConfig?.threshold ?? 200;
    form.largeItems.forEach((li, i) => {
      if (!isValidName(li.name, 50)) errs.push(`第 ${i + 1} 条大额明细名称需在 1~50 字之间`);
      const amt = parseAmount(li.amount);
      if (amt === null || amt < threshold) errs.push(`「${li.name}」金额需 ≥ ${threshold} 元才算大额明细`);
    });
    for (const d of debts.filter((x) => x.enabled)) {
      const e = form.debts[d.id];
      if (!e || !isValidAmount(e.balance)) errs.push(`「${d.name}」当前余额请填写非负数`);
      if (!d.fixedRepayment && (!e || !isValidAmount(e.repayment))) errs.push(`「${d.name}」本月还款额请填写（非固定还款需每月录入）`);
    }
    setInvalidFields(badFields);
    return errs;
  };

  const handleSave = async () => {
    if (!editable) return;
    const errs = validateLocal();
    if (errs.length > 0) {
      setSaveError(errs[0]);
      showToast(errs[0], 'error', 5000);
      return;
    }
    setSaveError(null);
    setInvalidFields(new Set());
    if (mode === 'history-correct') {
      setCorrecting(true);
      return;
    }
    const payload = buildPayload();
    if (!payload) return;
    setSaving(true);
    try {
      const res = await api<{ totals: Record<string, number> }>(`/api/snapshots/${month}`, { method: 'PUT', body: payload });
      clearDraft(month);
      setSaved(true);
      showToast(`已保存 ${fmtMonth(month)} 快照 · 总资产 ${fmtMoney(res.totals.totalAssets)} / 结余 ${fmtMoney(res.totals.balance)}`, 'success', 5000);
      await Promise.all([load(), refreshHistory()]);
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.details?.map((d) => d.message).join('；') ?? ae.message ?? '保存失败', 'error', 6000);
    } finally {
      setSaving(false);
    }
  };

  const handleCorrectConfirm = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setSaving(true);
    try {
      const res = await api<{ correctedAt: string; diff: unknown[] }>(`/api/snapshots/${month}/correct`, {
        method: 'POST',
        body: { confirmed: true, snapshot: payload },
      });
      clearDraft(month);
      setCorrecting(false);
      showToast(`纠错已保存（${res.correctedAt}），痕迹已记录`, 'success', 5000);
      await Promise.all([load(), refreshHistory()]);
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.details?.map((d) => d.message).join('；') ?? ae.message ?? '纠错失败', 'error', 6000);
    } finally {
      setSaving(false);
    }
  };

  // ---------- 渲染 ----------
  if (loading) return <LoadingSpinner message="加载录入页…" />;
  const cur = currentMonth();

  return (
    <div className="space-y-4">
      {/* 头部：月份切换 + 状态 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">月末录入</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            {tree && `资产树 v${tree.version} · `}
            {catConfig && `分类 catV${catConfig.version}（阈值 ${catConfig.threshold} 元）`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMonth(addMonths(month, -1))}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            ← 上月
          </button>
          <input
            type="month"
            value={month}
            max={cur}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-blue-500"
            aria-label="录入月份"
          />
          <button
            onClick={() => setMonth(addMonths(month, 1))}
            disabled={compareMonth(month, cur) >= 0}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            下月 →
          </button>
        </div>
      </div>

      {/* 状态条 */}
      {mode === 'history-locked' && (() => {
        const inWindow = month >= addMonths(currentMonth(), -(CORRECT_WINDOW_MONTHS - 1));
        return (
          <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            <span>
              历史月份已锁定（只读）。{detail?.correctedAt ? `上次纠错：${detail.correctedAt}` : ''}
              {!inWindow && ` 该月已超过纠错窗口（最近 ${CORRECT_WINDOW_MONTHS} 个月），快照永久保存，仅供查看。`}
            </span>
            {inWindow && (
              <button
                onClick={() => {
                  setMode('history-correct');
                  showToast('已进入修改模式，提交时需确认变更内容', 'info');
                }}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
              >
                发起纠错
              </button>
            )}
          </div>
        );
      })()}
      {mode === 'history-correct' && (
        <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-800">
          <span>正在修改 {fmtMonth(month)} 的数据，提交时会展示修改前后的对比供您确认。</span>
          <button
            onClick={() => {
              setMode('history-locked');
              void load();
            }}
            className="rounded-lg bg-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-300"
          >
            取消修改
          </button>
        </div>
      )}
      {mode === 'no-snapshot-past' && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          该月份尚未录入数据，仅支持录入当月。您可以切换到当前月进行录入，或查看其他已有记录的月份。
        </div>
      )}
      {mode === 'future' && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">未来月份暂不支持提前录入，请在当月月末进行数据录入。</div>
      )}

      {/* 已保存月份历史（「恢复」=切换至该月；「创建快照」=保存当前月） */}
      {editable && (
        <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <p className="mb-1 px-1 text-[11px] text-slate-400">
            历史记录（最近 {CORRECT_WINDOW_MONTHS} 个月）：点击可切换到对应月份查看或继续编辑；快照永久保存，更早月份可用顶部月份选择查看
          </p>
          <VersionHistoryList
            snapshots={savedSnapshots}
            loading={historyLoading}
            onRestore={(s) => setMonth(s.id)}
            onDelete={() => showToast('历史记录不支持删除，如需修正数据请使用「发起纠错」功能', 'warning')}
            onCreateSnapshot={() => void handleSave()}
          />
        </div>
      )}

      {editable && tree && catConfig && (
        <>
          {/* 资产区 / 收支+负债双栏（容器查询：窄容器单列，≥60rem 双列，与原 xl: 断点桌面列数一致） */}
          <div className="cq">
            <div className="cq-grid cq-cols-2-wide gap-4">
            {/* ============ 资产区 ============ */}
            <section className="card">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">资产余额（仅末级录入，上级自动汇总）</h3>
                <span className="text-xs text-slate-400">合计 {fmtMoney(totals.totalAssets)}</span>
              </div>
              {(() => {
                const topModules = childrenOf(null);
                const financialModules = topModules.filter((n) => n.assetCategory === 'financial');
                const physicalModules = topModules.filter((n) => n.assetCategory === 'physical');
                const financialTotal = financialModules.reduce((s, n) => s + balanceOf(n.id), 0);
                const physicalTotal = physicalModules.reduce((s, n) => s + balanceOf(n.id), 0);
                const toggleFn = (id: number) =>
                  setCollapsed((s) => {
                    const n2 = new Set(s);
                    if (n2.has(id)) n2.delete(id);
                    else n2.add(id);
                    return n2;
                  });
                const commonProps = {
                  form,
                  nodes,
                  childrenOf,
                  leafSet,
                  balanceOf,
                  collapsed,
                  toggleCollapse: toggleFn,
                  patchAsset,
                  patchGain,
                  carriedInfo: detail?.exists ? undefined : detail?.carried,
                  depValues,
                };
                return (
                  <div className="space-y-3">
                    {financialModules.length > 0 && (
                      <div>
                        <div className="mb-1.5 flex items-center gap-2">
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600">💰 资金资产</span>
                          <span className="text-xs text-slate-400">{fmtMoney(financialTotal)}</span>
                        </div>
                        <div className="space-y-1">
                          {financialModules.map((n) => (
                            <TreeRow key={n.id} node={n} depth={0} {...commonProps} />
                          ))}
                        </div>
                      </div>
                    )}
                    {physicalModules.length > 0 && (
                      <div>
                        <div className="mb-1.5 flex items-center gap-2 border-t border-slate-100 pt-2">
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-600">📱 实物资产</span>
                          <span className="text-xs text-slate-400">{fmtMoney(physicalTotal)}</span>
                          <span className="text-[10px] text-slate-400">（已配置折旧的自动计算，其余按当前估值录入）</span>
                        </div>
                        <div className="space-y-1">
                          {physicalModules.map((n) => (
                            <TreeRow key={n.id} node={n} depth={0} {...commonProps} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </section>

            {/* ============ 收支 + 负债 ============ */}
            <div className="space-y-4">
              <section className="card">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-800">收入与支出（二级分类）</h3>
                  <button
                    onClick={() => setCatDialogOpen(true)}
                    className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    <Settings size={12} /> ⚙ 分类配置
                  </button>
                </div>
                {(['income', 'expense'] as const).map((dir) => (
                  <CategoryBlock
                    key={dir}
                    direction={dir}
                    catConfig={catConfig}
                    form={form}
                    expandedCats={expandedCats}
                    invalidFields={invalidFields}
                    toggleCat={(id) =>
                      setExpandedCats((s) => {
                        const n2 = new Set(s);
                        if (n2.has(id)) n2.delete(id);
                        else n2.add(id);
                        return n2;
                      })
                    }
                    patchCat={patchCat}
                    onAddLarge={(catItemId) => setLargeDialog({ direction: dir, catItemId })}
                    removeLargeItem={removeLargeItem}
                  />
                ))}
                {/* 结余卡片（规则 7：正绿/负红 + 公式） */}
                <div
                  className={`mt-3 rounded-lg px-4 py-3 text-sm ${
                    totals.balance >= 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
                  }`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium">当月结余</span>
                    <span className="text-xl font-bold">{fmtMoney(totals.balance)}</span>
                  </div>
                  <p className="mt-0.5 text-xs opacity-70">
                    结余 = 总收入 − 总支出 = {fmtMoney(totals.totalIncome)} − {fmtMoney(totals.totalExpense)}
                  </p>
                </div>
              </section>

              <section className="card">
                <h3 className="mb-3 text-sm font-semibold text-slate-800">负债余额与还款</h3>
                {debts.filter((d) => d.enabled).length === 0 ? (
                  <p className="text-xs text-slate-400">
                    暂无启用的负债项。<span className="text-slate-500">可先在「负债管理」页添加。</span>
                  </p>
                ) : (
                  <div className="space-y-2">
                    {debts
                      .filter((d) => d.enabled)
                      .map((d) => (
                        <DebtRow key={d.id} debt={d} entry={form.debts[d.id]} patchDebt={patchDebt} />
                      ))}
                  </div>
                )}
              </section>
            </div>
            </div>
          </div>

          {/* 底部汇总 + 保存 */}
          <div className="sticky bottom-0 z-30 rounded-lg border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span>
                总资产 <b>{fmtMoney(totals.totalAssets)}</b>
              </span>
              <span>
                总负债 <b>{fmtMoney(totals.totalDebt)}</b>
              </span>
              <span>
                净资产 <b className={totals.netWorth < 0 ? 'text-red-600' : 'text-emerald-700'}>{fmtMoney(totals.netWorth)}</b>
              </span>
              <span>
                负债率 <b>{totals.debtRatio === null ? '—' : fmtRate(totals.debtRatio, 4)}</b>
              </span>
              <span>
                结余 <b className={totals.balance >= 0 ? 'text-emerald-700' : 'text-red-600'}>{fmtMoney(totals.balance)}</b>
              </span>
              <button
                onClick={() => {
                  saveDraft(month, form);
                  setDraftSaved(true);
                  showToast('草稿已保存，下次打开该月份将自动恢复', 'success');
                  setTimeout(() => setDraftSaved(false), 2000);
                }}
                className={`ml-auto rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                  draftSaved ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {draftSaved ? '✓ 草稿已保存' : '保存草稿'}
              </button>
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className={`rounded-lg px-6 py-2 text-sm font-medium text-white transition-colors disabled:opacity-60 ${
                  saved ? 'bg-emerald-600' : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {saving ? '保存中…' : saved ? '✓ 已保存' : mode === 'history-correct' ? '提交纠错' : '保存本月快照'}
              </button>
            </div>
            {saveError && (
              <p className="mt-2 text-xs font-medium text-red-600">⚠ {saveError}</p>
            )}
          </div>
        </>
      )}

      {/* 只读历史快照回显 */}
      {mode === 'history-locked' && detail?.exists && tree && (
        <ReadonlySnapshot detail={detail} tree={tree} catConfig={catConfig} debts={debts} />
      )}

      {/* 弹窗们 */}
      {catDialogOpen && catConfig && (
        <CatConfigDialog
          config={catConfig}
          onClose={() => setCatDialogOpen(false)}
          onSaved={() => {
            setCatDialogOpen(false);
            showToast('分类配置已保存为新版本（仅影响未来月份）', 'success');
            void load();
          }}
        />
      )}
      {largeDialog && catConfig && (
        <LargeItemDialog
          direction={largeDialog.direction}
          defaultCatItemId={largeDialog.catItemId}
          catConfig={catConfig}
          onClose={() => setLargeDialog(null)}
          onAdd={(item) => {
            addLargeItem(item);
            setLargeDialog(null);
          }}
        />
      )}
      {correcting && detail && tree && catConfig && (
        <CorrectDialog
          month={month}
          before={detail}
          after={form}
          tree={tree}
          catConfig={catConfig}
          debts={debts}
          onCancel={() => setCorrecting(false)}
          onConfirm={() => void handleCorrectConfirm()}
          saving={saving}
        />
      )}
    </div>
  );
}

// ---------- 工具：从快照/模板构造表单 ----------
function formFromSnapshot(s: SnapshotDetail, debts: Debt[]): FormState {
  const f = emptyForm();
  for (const a of s.assets ?? []) {
    f.assets[a.nodeId] = { balance: String(a.balance), hasNewFunds: a.hasNewFunds, updateSource: a.updateSource };
  }
  for (const g of s.moduleGains ?? []) f.gains[g.nodeId] = g.gain === null ? '' : String(g.gain);
  for (const i of s.income ?? []) f.income[i.catItemId] = String(i.amount);
  for (const e of s.expense ?? []) f.expense[e.catItemId] = String(e.amount);
  f.largeItems = (s.largeItems ?? []).map((li) => ({
    direction: li.direction,
    catItemId: li.catItemId,
    name: li.name,
    amount: String(li.amount),
  }));
  for (const d of s.debts ?? []) {
    f.debts[d.debtId] = { balance: String(d.balance), repayment: d.fixedRepayment ? '' : String(d.repayment ?? '') };
  }
  // 补全快照中未出现的启用负债（防御）
  for (const d of debts.filter((x) => x.enabled)) {
    if (!f.debts[d.id]) f.debts[d.id] = { balance: String(d.monthBalance), repayment: '' };
  }
  return f;
}

function formFromTemplate(s: SnapshotDetail, debts: Debt[], cat: CatConfig): FormState {
  const f = emptyForm();
  // 资产：沿用上期清单禁用；其余空
  for (const c of s.carried ?? []) {
    f.assets[c.nodeId] = { balance: String(c.balance), hasNewFunds: false, updateSource: 'carried' };
  }
  // 负债：debtDefaults 优先，其次主档
  for (const dd of s.debtDefaults ?? []) {
    f.debts[dd.debtId] = { balance: String(dd.lastBalance), repayment: dd.fixedRepayment ? '' : '' };
  }
  for (const d of debts.filter((x) => x.enabled)) {
    if (!f.debts[d.id]) f.debts[d.id] = { balance: String(d.monthBalance), repayment: '' };
  }
  // 收支初始化为空（全部二级分类 0）
  for (const dir of ['income', 'expense'] as const) {
    for (const top of cat[dir]) {
      for (const c of top.children ?? []) {
        f[dir][c.id] = '';
      }
    }
  }
  return f;
}

// ============================================================
// 子组件：资产树行（递归）
// ============================================================
function TreeRow(props: {
  node: TreeNode;
  depth: number;
  form: FormState;
  nodes: TreeNode[];
  childrenOf: (parentId: number | null) => TreeNode[];
  leafSet: Set<number>;
  balanceOf: (nodeId: number) => number;
  collapsed: Set<number>;
  toggleCollapse: (id: number) => void;
  patchAsset: (nodeId: number, patch: Partial<AssetEntry>) => void;
  patchGain: (nodeId: number, v: string) => void;
  carriedInfo?: { nodeId: number; balance: number; lastUpdatedMonth: string }[];
  depValues: Map<number, DepreciationValue>;
}) {
  const { node, depth } = props;
  const kids = props.childrenOf(node.id);
  const isLeaf = props.leafSet.has(node.id);
  const entry = props.form.assets[node.id];
  const carried = props.carriedInfo?.find((c) => c.nodeId === node.id);
  const isCarried = (entry?.updateSource ?? 'current') === 'carried' && !!carried;
  const hasNew = entry?.hasNewFunds ?? false;
  const isPhysical = node.assetCategory === 'physical';
  const showGain = isLeaf && !isPhysical && hasNew;
  const gainRaw = props.form.gains[node.id] ?? '';

  return (
    <div>
      <div
        className={`flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 ${depth === 0 ? 'bg-slate-50 font-medium' : ''}`}
        style={{ marginLeft: Math.min(depth * 18, 36) }}
      >
        {!isLeaf && kids.length > 0 ? (
          <button onClick={() => props.toggleCollapse(node.id)} className="text-slate-400 hover:text-slate-600" aria-label="折叠/展开">
            {props.collapsed.has(node.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : (
          <span className="inline-block w-3.5" />
        )}

        <span className="min-w-0 flex-1 truncate text-sm text-slate-700" title={node.identityInfo ?? node.name}>
          {node.name}
          {isLeaf && node.identityInfo && <span className="ml-1 text-[11px] text-slate-400">({node.identityInfo})</span>}
          {node.isPlaceholder && <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-600">待拆分</span>}
        </span>

        {isLeaf ? (
          <>
            {isCarried ? (
              <span className="flex items-center gap-2">
                <input
                  value={entry?.balance ?? ''}
                  disabled
                  className="w-32 rounded border border-slate-200 bg-slate-100 px-2 py-1 text-right text-sm text-slate-500"
                />
                <span className="text-xs text-slate-400">沿用上期（{carried?.lastUpdatedMonth} 更新）</span>
                <button
                  onClick={() => props.patchAsset(node.id, { updateSource: 'current' })}
                  className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-600 hover:bg-blue-100"
                  title="解锁本次录入，不影响更新频率设置"
                >
                  本期更新
                </button>
              </span>
            ) : (
              <span className="flex items-center gap-2">
                {isPhysical && props.depValues.has(node.id) ? (
                  (() => {
                    const dv = props.depValues.get(node.id)!;
                    if (dv.isFullyDepreciated) {
                      return (
                        <>
                          <input
                            value={entry?.balance ?? String(Math.round(dv.currentValue * 100) / 100)}
                            onChange={(e) => props.patchAsset(node.id, { balance: e.target.value })}
                            placeholder="当前市场价"
                            inputMode="decimal"
                            className="w-32 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-right text-sm outline-none focus:border-amber-500"
                            aria-label={`${node.name} 当前市场估值`}
                          />
                          <span className="flex items-center gap-1 text-[11px] text-amber-600" title="折旧已到期，请按市场价更新">
                            <TrendingDown size={11} />
                            已到期·请更新
                          </span>
                        </>
                      );
                    }
                    return (
                      <>
                        <span className="w-32 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-right text-sm text-emerald-700">
                          {fmtMoney(dv.currentValue)}
                        </span>
                        <span className="flex items-center gap-1 text-[11px] text-emerald-600" title={`${dv.method === 'sum_of_years' ? '年数总和法' : '直线法'}自动计算`}>
                          <TrendingDown size={11} />
                          自动折旧
                        </span>
                      </>
                    );
                  })()
                ) : (
                  <>
                    <input
                      value={entry?.balance ?? ''}
                      onChange={(e) => props.patchAsset(node.id, { balance: e.target.value })}
                      placeholder={isPhysical ? '二手估值' : '0.00'}
                      inputMode="decimal"
                      className="w-32 rounded border border-slate-200 px-2 py-1 text-right text-sm outline-none focus:border-blue-400"
                      aria-label={`${node.name} ${isPhysical ? '当前二手估值' : '月末余额'}`}
                    />
                  </>
                )}
                {!isPhysical && (
                  <label className="flex items-center gap-1 text-xs text-slate-500">
                    <input
                      type="checkbox"
                      checked={hasNew}
                      onChange={(e) => props.patchAsset(node.id, { hasNewFunds: e.target.checked })}
                      className="accent-blue-600"
                    />
                    新增
                  </label>
                )}
              </span>
            )}
          </>
        ) : (
          <span className="text-sm tabular-nums text-slate-600">{fmtMoney(props.balanceOf(node.id))}</span>
        )}
      </div>

      {/* 叶子节点收益金额输入 */}
      {showGain && (
        <div className="my-1 flex flex-wrap items-center gap-2 rounded-md border border-blue-100 bg-blue-50/50 px-3 py-1.5" style={{ marginLeft: Math.min(depth * 18 + 26, 62) }}>
          <span className="text-xs text-slate-600">收益金额（元，不含新增本金，可正可负）</span>
          <input
            value={gainRaw}
            onChange={(e) => props.patchGain(node.id, e.target.value)}
            placeholder="留空则报表不展示收益率"
            inputMode="decimal"
            className="w-36 rounded border border-slate-200 px-2 py-1 text-right text-sm outline-none focus:border-blue-400"
          />
          {gainRaw.trim() === '' && (
            <span className="text-xs text-blue-600">→ 留空（报表标注「新增资金·留空」）</span>
          )}
        </div>
      )}

      {!props.collapsed.has(node.id) &&
        kids.map((k) => <TreeRow key={k.id} {...props} node={k} depth={depth + 1} />)}
    </div>
  );
}

// ============================================================
// 子组件：收支分类块
// ============================================================
function CategoryBlock(props: {
  direction: 'income' | 'expense';
  catConfig: CatConfig;
  form: FormState;
  expandedCats: Set<number>;
  invalidFields: Set<string>;
  toggleCat: (id: number) => void;
  patchCat: (direction: 'income' | 'expense', catItemId: number, value: string) => void;
  onAddLarge: (catItemId: number) => void;
  removeLargeItem: (idx: number) => void;
}) {
  const { direction, catConfig, form } = props;
  const tops = direction === 'income' ? catConfig.income : catConfig.expense;
  const amounts = direction === 'income' ? form.income : form.expense;
  const label = direction === 'income' ? '收入' : '支出';
  const total = Object.values(amounts).reduce((s, v) => s + (parseAmount(v) ?? 0), 0);

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <span className="text-xs tabular-nums text-slate-500">
          {label}合计 {fmtMoney(total)}
        </span>
      </div>
      {tops.map((top) => {
        const kids = top.children ?? [];
        const topSum = kids.reduce((s, k) => s + (parseAmount(amounts[k.id] ?? '') ?? 0), 0);
        const expanded = props.expandedCats.has(top.id);
        return (
          <div key={top.id} className="mb-1 rounded-md border border-slate-100">
            <button
              onClick={() => props.toggleCat(top.id)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown size={13} className="text-slate-400" /> : <ChevronRight size={13} className="text-slate-400" />}
              <span className="flex-1 text-sm text-slate-700">{top.name}</span>
              <span className="text-sm tabular-nums text-slate-600">{fmtMoney(topSum)}</span>
            </button>
            {expanded && (
              <div className="animate-fadeIn space-y-1 border-t border-slate-50 px-2 py-1.5">
                {kids.map((c) => {
                  const largeRows = form.largeItems
                    .map((li, idx) => ({ li, idx }))
                    .filter(({ li }) => li.direction === direction && li.catItemId === c.id);
                  const isInvalid = props.invalidFields.has(`${direction}:${c.id}`);
                  return (
                    <div key={c.id}>
                      <div className="flex items-center gap-2 pl-5">
                        <span className={`flex-1 text-xs ${isInvalid ? 'font-medium text-red-600' : 'text-slate-500'}`}>{c.name}</span>
                        <input
                          value={amounts[c.id] ?? ''}
                          onChange={(e) => props.patchCat(direction, c.id, e.target.value)}
                          placeholder="0.00"
                          inputMode="decimal"
                          className={`w-28 rounded border px-2 py-1 text-right text-xs outline-none ${isInvalid ? 'border-red-500 bg-red-50 ring-1 ring-red-300 focus:border-red-500' : 'border-slate-200 focus:border-blue-400'}`}
                          aria-label={`${top.name} ${c.name} 金额`}
                          aria-invalid={isInvalid}
                        />
                        <button
                          onClick={() => props.onAddLarge(c.id)}
                          className="rounded bg-slate-50 px-1.5 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50"
                          title={`添加大额明细（≥${catConfig.threshold} 元）`}
                        >
                          ＋明细
                        </button>
                      </div>
                      {largeRows.map(({ li, idx }) => (
                        <div key={idx} className="mt-0.5 flex items-center gap-2 pl-9 text-xs text-slate-400">
                          <span className="flex-1 truncate">└ {li.name}</span>
                          <span className="tabular-nums">{fmtMoney(parseAmount(li.amount) ?? 0)}</span>
                          <button onClick={() => props.removeLargeItem(idx)} className="text-slate-300 hover:text-red-500" title="删除明细">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// 子组件：负债行（录入页）
// ============================================================
function DebtRow({ debt, entry, patchDebt }: { debt: Debt; entry?: DebtEntry; patchDebt: (id: number, p: Partial<DebtEntry>) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate text-slate-700">{debt.name}</span>
      {debt.fixedRepayment ? (
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">
          固定还款 · 每月 {fmtMoney(debt.monthlyPayment)}
        </span>
      ) : (
        <label className="flex items-center gap-1 text-xs text-slate-500">
          本月实际还款
          <input
            value={entry?.repayment ?? ''}
            onChange={(e) => patchDebt(debt.id, { repayment: e.target.value })}
            placeholder="必填"
            inputMode="decimal"
            className="w-24 rounded border border-slate-200 px-2 py-1 text-right text-xs outline-none focus:border-blue-400"
          />
        </label>
      )}
      <label className="flex items-center gap-1 text-xs text-slate-500">
        余额
        <input
          value={entry?.balance ?? ''}
          onChange={(e) => patchDebt(debt.id, { balance: e.target.value })}
          inputMode="decimal"
          className="w-28 rounded border border-slate-200 px-2 py-1 text-right text-xs outline-none focus:border-blue-400"
        />
      </label>
    </div>
  );
}

// ============================================================
// 子组件：只读历史快照
// ============================================================
function ReadonlySnapshot({ detail, tree, catConfig, debts }: { detail: SnapshotDetail; tree: TreeConfig; catConfig: CatConfig | null; debts: Debt[] }) {
  const snapshotNodes = detail.treeNodes ?? tree.nodes;
  const nodeName = (id: number) => snapshotNodes.find((n) => n.id === id)?.name ?? `#${id}`;
  const catName = (id: number) => {
    for (const dir of ['income', 'expense'] as const) {
      for (const top of catConfig?.[dir] ?? []) {
        if (top.id === id) return top.name;
        const kid = top.children?.find((c) => c.id === id);
        if (kid) return `${top.name}>${kid.name}`;
      }
    }
    return `分类#${id}`;
  };
  const debtName = (id: number) => debts.find((d) => d.id === id)?.name ?? `负债#${id}`;

  return (
    <div className="space-y-3">
      <section className="card">
        <h3 className="mb-2 text-sm font-semibold text-slate-800">资产（{fmtMonth(detail.month)} · 只读）</h3>
        <div className="cq">
          <div className="cq-grid cq-cols-2 gap-1">
            {(detail.assets ?? []).map((a) => (
              <div key={a.nodeId} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-xs">
                <span className="truncate text-slate-600">
                  {nodeName(a.nodeId)}
                  {a.updateSource === 'carried' && <span className="ml-1 text-slate-400">（沿用上期）</span>}
                  {a.hasNewFunds && <span className="ml-1 text-blue-500">新增</span>}
                </span>
                <span className="tabular-nums">{fmtMoney(a.balance)}</span>
              </div>
            ))}
          </div>
        </div>
        {(detail.moduleGains ?? []).length > 0 && (
          <div className="mt-2 text-xs text-slate-500">
            收益金额：
            {(detail.moduleGains ?? []).map((g) => (
              <span key={g.nodeId} className="mr-3">
                {nodeName(g.nodeId)}：{g.gain === null ? '留空' : fmtMoney(g.gain)}
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="card">
        <h3 className="mb-2 text-sm font-semibold text-slate-800">收支与负债（只读）</h3>
        <div className="cq">
          <div className="cq-grid cq-cols-2 gap-x-6 gap-y-1 text-xs">
          <div>
            <p className="mb-1 font-medium text-slate-500">收入</p>
            {(detail.income ?? []).map((x) => (
              <div key={x.catItemId} className="flex justify-between text-slate-600">
                <span>{catName(x.catItemId)}</span>
                <span className="tabular-nums">{fmtMoney(x.amount)}</span>
              </div>
            ))}
            <p className="mb-1 mt-2 font-medium text-slate-500">支出</p>
            {(detail.expense ?? []).map((x) => (
              <div key={x.catItemId} className="flex justify-between text-slate-600">
                <span>{catName(x.catItemId)}</span>
                <span className="tabular-nums">{fmtMoney(x.amount)}</span>
              </div>
            ))}
            {(detail.largeItems ?? []).map((li, i) => (
              <div key={i} className="flex justify-between pl-3 text-slate-400">
                <span>└ {li.name}（{catName(li.catItemId)}）</span>
                <span className="tabular-nums">{fmtMoney(li.amount)}</span>
              </div>
            ))}
          </div>
          <div>
            <p className="mb-1 font-medium text-slate-500">负债</p>
            {(detail.debts ?? []).map((d) => (
              <div key={d.debtId} className="flex justify-between text-slate-600">
                <span>
                  {debtName(d.debtId)}
                  {d.fixedRepayment ? '（固定）' : '（非固定）'}
                </span>
                <span className="tabular-nums">
                  余额 {fmtMoney(d.balance)} / 还款 {fmtMoney(d.repayment)}
                </span>
              </div>
            ))}
            {detail.totals && (
              <div className="mt-3 rounded bg-slate-50 p-2 text-slate-600">
                <div className="flex justify-between"><span>总资产</span><span className="tabular-nums">{fmtMoney(detail.totals.totalAssets)}</span></div>
                <div className="flex justify-between"><span>总负债</span><span className="tabular-nums">{fmtMoney(detail.totals.totalDebt)}</span></div>
                <div className="flex justify-between"><span>净资产</span><span className="tabular-nums">{fmtMoney(detail.totals.netWorth)}</span></div>
                <div className="flex justify-between"><span>负债率</span><span className="tabular-nums">{fmtRate(detail.totals.debtRatio, 4)}</span></div>
                <div className="flex justify-between"><span>结余</span><span className="tabular-nums">{fmtMoney(detail.totals.balance)}</span></div>
              </div>
            )}
          </div>
          </div>
        </div>
      </section>
    </div>
  );
}
