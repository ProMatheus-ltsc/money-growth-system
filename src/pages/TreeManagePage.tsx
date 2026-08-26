/**
 * 资产树管理页（重构版）：
 * - 树形可视化展示，缩进+连接线清晰呈现层级
 * - 新建/编辑节点通过弹窗对话框完成，提供更好的指引
 * - 保留：拖拽排序、启停、删除、升级分组、保存新版本等核心功能
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@shared/core/hooks/useAuth';
import { ConfirmDialog } from '@shared/core/components/ConfirmDialog';
import { LoadingSpinner } from '@shared/core/components/LoadingSpinner';
import { useToast } from '@shared/core/hooks/useToast';
import { ChevronDown, ChevronRight, Edit2, FolderPlus, GripVertical, Plus, Trash2, ArrowUp, ArrowDown, Calculator } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { addMonths, currentMonth, fmtMonth, fmtRate, fmtMoney } from '../lib/format';
import type { AssetCategory, EditTreeNode, Liquidity, NodeType, SnapshotsListData, TreeConfig, UpdateFreq } from '../lib/types';
import { isValidName } from '../lib/validate';

const FREQ_OPTIONS: { value: UpdateFreq | ''; label: string }[] = [
  { value: '', label: '继承上级' },
  { value: 'monthly', label: '月度' },
  { value: 'quarterly', label: '季度' },
  { value: 'semiannual', label: '半年' },
  { value: 'annual', label: '年度' },
  { value: 'irregular', label: '不定期' },
];

const TYPE_LABEL: Record<NodeType, string> = { module: '资产模块', sub: '子模块', leaf: '末级·具体资产' };
const CATEGORY_LABEL: Record<AssetCategory, string> = { financial: '💰 资金资产', physical: '📱 实物资产' };

type DepCategory = 'electronics' | 'furniture' | 'vehicle' | 'machinery' | 'building';
type DepMethod = 'straight' | 'sum_of_years';
const DEP_CATEGORIES: { value: DepCategory; label: string; minYears: number; maxYears: number; defaultYears: number; defaultRate: number; method: DepMethod; methodLabel: string }[] = [
  { value: 'electronics', label: '电子设备', minYears: 3, maxYears: 5, defaultYears: 3, defaultRate: 0.20, method: 'sum_of_years', methodLabel: '年数总和法' },
  { value: 'furniture', label: '器具/家具/家电', minYears: 5, maxYears: 10, defaultYears: 5, defaultRate: 0.30, method: 'straight', methodLabel: '直线法' },
  { value: 'vehicle', label: '运输工具', minYears: 4, maxYears: 10, defaultYears: 4, defaultRate: 0.40, method: 'straight', methodLabel: '直线法' },
  { value: 'machinery', label: '机械设备', minYears: 5, maxYears: 10, defaultYears: 5, defaultRate: 0.15, method: 'straight', methodLabel: '直线法' },
  { value: 'building', label: '房屋/建筑物', minYears: 20, maxYears: 40, defaultYears: 20, defaultRate: 0.70, method: 'straight', methodLabel: '直线法' },
];

interface DepreciationConfig {
  id?: number;
  nodeId: number;
  configId: number;
  depreciationCategory: DepCategory;
  originalValue: number;
  purchaseDate: string;
  usefulLifeMonths: number;
  salvageRate: number;
  salvageMode: 'rate' | 'market';
  marketSalvageValue: number | null;
  currentValue?: number;
  monthlyDep?: number;
  isFullyDepreciated?: boolean;
}

interface DepFormData {
  depreciationCategory: DepCategory;
  originalValue: string;
  purchaseDate: string;
  usefulLifeYears: string;
  salvageMode: 'rate' | 'market';
  salvageRate: string;
  marketSalvageValue: string;
}

let tempSeq = 0;
function nextTempId(): string {
  tempSeq += 1;
  return `t${Date.now().toString(36)}-${tempSeq}`;
}

function fromServer(config: TreeConfig): EditTreeNode[] {
  const idToTemp = new Map<number, string>();
  const nodes = [...config.nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  for (const n of nodes) idToTemp.set(n.id, nextTempId());
  return nodes.map((n) => ({
    tempId: idToTemp.get(n.id)!,
    serverId: n.id,
    parentId: n.parentId === null ? null : idToTemp.get(n.parentId) ?? null,
    name: n.name,
    nodeType: n.nodeType,
    targetRateAnnual: n.targetRateAnnual,
    updateFreq: n.updateFreq,
    enabled: n.enabled,
    sortOrder: n.sortOrder,
    identityInfo: n.identityInfo,
    isPlaceholder: n.isPlaceholder,
    assetCategory: n.assetCategory ?? 'financial',
    liquidity: n.liquidity ?? 'medium',
  }));
}

interface NodeFormData {
  name: string;
  nodeType: NodeType;
  assetCategory: AssetCategory;
  targetRateAnnual: string;
  updateFreq: UpdateFreq | '';
  identityInfo: string;
  enabled: boolean;
  liquidity: Liquidity;
}

const LIQUIDITY_OPTIONS: { value: Liquidity; label: string; desc: string }[] = [
  { value: 'high', label: '高', desc: '随时可变现（活期、货基等）' },
  { value: 'medium', label: '中', desc: '短期可变现（定期、基金等）' },
  { value: 'low', label: '低', desc: '变现周期长（房产、车辆等）' },
];

const emptyForm = (defaults?: Partial<NodeFormData>): NodeFormData => ({
  name: '',
  nodeType: 'module',
  assetCategory: 'financial',
  targetRateAnnual: '',
  updateFreq: '',
  identityInfo: '',
  enabled: true,
  liquidity: 'medium',
  ...defaults,
});

export default function TreeManagePage() {
  const { role } = useAuth();
  const { showToast } = useToast();
  const [config, setConfig] = useState<TreeConfig | null>(null);
  const [nodes, setNodes] = useState<EditTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [confirmDel, setConfirmDel] = useState<EditTreeNode | null>(null);
  const [saveDialog, setSaveDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(currentMonth());

  // 新建/编辑弹窗状态
  const [nodeDialog, setNodeDialog] = useState<{
    mode: 'create' | 'edit';
    parentId: string | null;
    editingTempId?: string;
    form: NodeFormData;
  } | null>(null);

  // 折旧配置弹窗状态
  const [depDialog, setDepDialog] = useState<{
    node: EditTreeNode;
    existing: DepreciationConfig | null;
    form: DepFormData;
    loading: boolean;
    saving: boolean;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tree, snaps] = await Promise.all([
        api<TreeConfig>('/api/tree'),
        api<SnapshotsListData>('/api/snapshots', { query: { range: 'all' } }).catch(() => null),
      ]);
      setConfig(tree);
      setNodes(fromServer(tree));
      setDirty(false);
      const latest = snaps && snaps.months.length > 0 ? snaps.months[snaps.months.length - 1].month : null;
      setEffectiveFrom(latest ? addMonths(latest, 1) : currentMonth());
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (role === 'admin') void load();
  }, [role, load]);

  const childrenOf = useCallback(
    (tempId: string | null) => nodes.filter((n) => n.parentId === tempId).sort((a, b) => a.sortOrder - b.sortOrder),
    [nodes]
  );

  const effectiveRate = useCallback(
    (n: EditTreeNode): number | null => {
      let cur: EditTreeNode | undefined = n;
      while (cur) {
        if (cur.targetRateAnnual !== null) return cur.targetRateAnnual;
        cur = cur.parentId ? nodes.find((x) => x.tempId === cur!.parentId) : undefined;
      }
      return null;
    },
    [nodes]
  );

  const effectiveFreqLabel = useCallback(
    (n: EditTreeNode): string => {
      let cur: EditTreeNode | undefined = n;
      while (cur) {
        if (cur.updateFreq) return FREQ_OPTIONS.find((f) => f.value === cur!.updateFreq)?.label ?? cur.updateFreq;
        cur = cur.parentId ? nodes.find((x) => x.tempId === cur!.parentId) : undefined;
      }
      return '月度';
    },
    [nodes]
  );

  // ---------- 变更操作 ----------
  const mutate = (fn: (list: EditTreeNode[]) => EditTreeNode[]) => {
    setNodes((list) => fn(list));
    setDirty(true);
  };

  const patchNode = (tempId: string, patch: Partial<EditTreeNode>) =>
    mutate((list) => list.map((n) => (n.tempId === tempId ? { ...n, ...patch } : n)));

  const openCreateDialog = (parentId: string | null, category?: AssetCategory) => {
    const parent = parentId ? nodes.find((n) => n.tempId === parentId) : null;
    const nodeType: NodeType = parent ? (parent.nodeType === 'module' ? 'sub' : 'leaf') : 'module';
    setNodeDialog({
      mode: 'create',
      parentId,
      form: emptyForm({
        nodeType,
        assetCategory: category ?? parent?.assetCategory ?? 'financial',
      }),
    });
  };

  const openEditDialog = (n: EditTreeNode) => {
    setNodeDialog({
      mode: 'edit',
      parentId: n.parentId,
      editingTempId: n.tempId,
      form: {
        name: n.name,
        nodeType: n.nodeType,
        assetCategory: n.assetCategory,
        targetRateAnnual: n.targetRateAnnual === null ? '' : String(n.targetRateAnnual * 100),
        updateFreq: n.updateFreq ?? '',
        identityInfo: n.identityInfo ?? '',
        enabled: n.enabled,
        liquidity: n.liquidity,
      },
    });
  };

  const submitNodeDialog = () => {
    if (!nodeDialog) return;
    const { form, mode, parentId, editingTempId } = nodeDialog;
    if (!isValidName(form.name, 30)) {
      showToast('名称须为 1~30 字符', 'error');
      return;
    }
    const rateStr = form.targetRateAnnual.trim();
    let targetRateAnnual: number | null = null;
    if (rateStr !== '') {
      const num = Number(rateStr);
      if (!Number.isFinite(num) || num < 0 || num > 1000) {
        showToast('目标收益率须为 0~1000（%）', 'error');
        return;
      }
      targetRateAnnual = num / 100;
    }

    if (mode === 'create') {
      const child: EditTreeNode = {
        tempId: nextTempId(),
        parentId,
        name: form.name.trim(),
        nodeType: form.nodeType,
        targetRateAnnual,
        updateFreq: form.updateFreq || null,
        enabled: form.enabled,
        sortOrder: childrenOf(parentId).length,
        identityInfo: form.identityInfo.trim() || null,
        isPlaceholder: false,
        assetCategory: form.assetCategory,
        liquidity: form.liquidity,
      };
      mutate((list) => [...list, child]);
      if (parentId) {
        setCollapsed((s) => {
          const ns = new Set(s);
          ns.delete(parentId);
          return ns;
        });
      }
      showToast(`已添加「${form.name.trim()}」`, 'success');
    } else if (editingTempId) {
      const patch: Partial<EditTreeNode> = {
        name: form.name.trim(),
        targetRateAnnual,
        updateFreq: form.updateFreq || null,
        enabled: form.enabled,
        identityInfo: form.identityInfo.trim() || null,
        liquidity: form.liquidity,
      };
      if (!parentId) {
        patch.assetCategory = form.assetCategory;
        const collectIds = (id: string, list: EditTreeNode[]): Set<string> => {
          const ids = new Set<string>([id]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const x of list) {
              if (x.parentId && ids.has(x.parentId) && !ids.has(x.tempId)) {
                ids.add(x.tempId);
                grew = true;
              }
            }
          }
          return ids;
        };
        mutate((list) => {
          const ids = collectIds(editingTempId, list);
          return list.map((x) =>
            x.tempId === editingTempId
              ? { ...x, ...patch }
              : ids.has(x.tempId)
              ? { ...x, assetCategory: form.assetCategory }
              : x
          );
        });
      } else {
        patchNode(editingTempId, patch);
      }
    }
    setNodeDialog(null);
  };

  const move = (n: EditTreeNode, dir: -1 | 1) => {
    const siblings = childrenOf(n.parentId);
    const idx = siblings.findIndex((s) => s.tempId === n.tempId);
    const swap = siblings[idx + dir];
    if (!swap) return;
    mutate((list) =>
      list.map((x) => {
        if (x.tempId === n.tempId) return { ...x, sortOrder: swap.sortOrder };
        if (x.tempId === swap.tempId) return { ...x, sortOrder: n.sortOrder };
        return x;
      })
    );
  };

  const removeSubtree = (n: EditTreeNode) => {
    const doomed = new Set<string>([n.tempId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of nodes) {
        if (x.parentId && doomed.has(x.parentId) && !doomed.has(x.tempId)) {
          doomed.add(x.tempId);
          grew = true;
        }
      }
    }
    mutate((list) => list.filter((x) => !doomed.has(x.tempId)));
  };

  const upgradeLeaf = (n: EditTreeNode) => {
    const placeholder: EditTreeNode = {
      tempId: nextTempId(),
      parentId: n.tempId,
      name: '（待拆分）',
      nodeType: 'leaf',
      targetRateAnnual: null,
      updateFreq: null,
      enabled: true,
      sortOrder: 0,
      identityInfo: null,
      isPlaceholder: true,
      assetCategory: n.assetCategory,
      liquidity: n.liquidity,
    };
    mutate((list) => [...list.map((x) => (x.tempId === n.tempId ? { ...x, nodeType: 'sub' as NodeType } : x)), placeholder]);
    showToast('已升级为分组，原余额将由「（待拆分）」占位子项承载', 'info');
  };

  // ---------- 折旧配置 ----------
  const openDepDialog = async (n: EditTreeNode) => {
    if (!config) return;
    const catInfo = DEP_CATEGORIES[0];
    const defaultForm: DepFormData = {
      depreciationCategory: catInfo.value,
      originalValue: '',
      purchaseDate: '',
      usefulLifeYears: String(catInfo.defaultYears),
      salvageMode: 'rate',
      salvageRate: String(Math.round(catInfo.defaultRate * 100)),
      marketSalvageValue: '',
    };
    setDepDialog({ node: n, existing: null, form: defaultForm, loading: true, saving: false });

    if (n.serverId) {
      try {
        const res = await api<{ items: DepreciationConfig[] }>('/api/depreciation', {
          query: { configId: String(config.configId), month: currentMonth() },
        });
        const match = res.items.find((d) => d.nodeId === n.serverId);
        if (match) {
          const cat = DEP_CATEGORIES.find((c) => c.value === match.depreciationCategory) ?? DEP_CATEGORIES[0];
          setDepDialog((prev) => prev ? {
            ...prev,
            existing: match,
            form: {
              depreciationCategory: match.depreciationCategory,
              originalValue: String(match.originalValue),
              purchaseDate: match.purchaseDate.slice(0, 7),
              usefulLifeYears: String(Math.round(match.usefulLifeMonths / 12)),
              salvageMode: match.salvageMode as 'rate' | 'market',
              salvageRate: String(Math.round(match.salvageRate * 100)),
              marketSalvageValue: match.marketSalvageValue !== null ? String(match.marketSalvageValue) : '',
            },
            loading: false,
          } : null);
          return;
        }
      } catch { /* ignore */ }
    }
    setDepDialog((prev) => prev ? { ...prev, loading: false } : null);
  };

  const submitDepDialog = async () => {
    if (!depDialog || !config) return;
    const { node, form } = depDialog;
    const cat = DEP_CATEGORIES.find((c) => c.value === form.depreciationCategory);
    if (!cat) return;

    const originalValue = Number(form.originalValue);
    if (!originalValue || originalValue <= 0) {
      showToast('购入原值须为正数', 'error');
      return;
    }
    if (!form.purchaseDate || !/^\d{4}-\d{2}$/.test(form.purchaseDate)) {
      showToast('请填写购入年月（YYYY-MM）', 'error');
      return;
    }
    const years = Number(form.usefulLifeYears);
    if (!years || years < cat.minYears) {
      showToast(`${cat.label} 最低折旧年限为 ${cat.minYears} 年`, 'error');
      return;
    }
    const salvageRate = Number(form.salvageRate) / 100;
    if (Number.isNaN(salvageRate) || salvageRate < 0 || salvageRate > 1) {
      showToast('残值率须为 0~100（%）', 'error');
      return;
    }
    if (form.salvageMode === 'market') {
      const mv = Number(form.marketSalvageValue);
      if (!mv || mv < 0) {
        showToast('市场残值须为非负数', 'error');
        return;
      }
    }

    if (!node.serverId) {
      showToast('请先保存资产树版本后再配置折旧（需要节点 ID）', 'error');
      return;
    }

    setDepDialog((prev) => prev ? { ...prev, saving: true } : null);
    try {
      await api('/api/depreciation', {
        method: 'POST',
        body: {
          nodeId: node.serverId,
          configId: config.configId,
          depreciationCategory: form.depreciationCategory,
          originalValue,
          purchaseDate: form.purchaseDate,
          usefulLifeMonths: years * 12,
          salvageRate,
          salvageMode: form.salvageMode,
          marketSalvageValue: form.salvageMode === 'market' ? Number(form.marketSalvageValue) : null,
        },
      });
      showToast('折旧配置已保存', 'success');
      setDepDialog(null);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : '保存失败', 'error');
      setDepDialog((prev) => prev ? { ...prev, saving: false } : null);
    }
  };

  const deleteDepreciation = async () => {
    if (!depDialog?.existing?.id) return;
    setDepDialog((prev) => prev ? { ...prev, saving: true } : null);
    try {
      await api(`/api/depreciation/${depDialog.existing.id}`, { method: 'DELETE' });
      showToast('折旧配置已删除', 'success');
      setDepDialog(null);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : '删除失败', 'error');
      setDepDialog((prev) => prev ? { ...prev, saving: false } : null);
    }
  };

  // ---------- 保存新版本 ----------
  const validateLocal = (): string[] => {
    const errs: string[] = [];
    if (nodes.length === 0) errs.push('至少需要一个节点');
    for (const n of nodes.filter((x) => x.parentId === null)) {
      if (n.nodeType !== 'module') errs.push(`顶层节点「${n.name || '未命名'}」必须为资产模块`);
    }
    for (const n of nodes) {
      if (!isValidName(n.name, 30)) errs.push(`节点名称须为 1~30 字符：「${n.name}」`);
      if (n.identityInfo && n.identityInfo.length > 50) errs.push(`识别信息不超过 50 字符：「${n.name}」`);
    }
    const temps = new Set(nodes.map((n) => n.tempId));
    for (const n of nodes) {
      if (n.parentId && !temps.has(n.parentId)) errs.push(`悬空父节点引用：「${n.name}」`);
    }
    return errs;
  };

  const submit = async () => {
    const errs = validateLocal();
    if (errs.length > 0) {
      showToast(errs[0], 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        effectiveFromMonth: effectiveFrom,
        note: note.trim() || undefined,
        nodes: nodes.map((n) => ({
          tempId: n.tempId,
          parentId: n.parentId,
          name: n.name.trim(),
          nodeType: n.nodeType,
          targetRateAnnual: n.targetRateAnnual,
          updateFreq: n.updateFreq,
          enabled: n.enabled,
          sortOrder: n.sortOrder,
          identityInfo: n.identityInfo,
          isPlaceholder: n.isPlaceholder,
          assetCategory: n.assetCategory,
          liquidity: n.liquidity,
        })),
      };
      const res = await api<{ configId: number; version: number }>('/api/tree', { method: 'POST', body: payload });
      showToast(`已保存新版本 v${res.version}，仅影响未来月份`, 'success');
      setSaveDialog(false);
      setNote('');
      await load();
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.details?.map((d) => d.message).join('；') ?? ae.message ?? '保存失败', 'error', 6000);
    } finally {
      setSaving(false);
    }
  };

  // ---------- 统计 ----------
  const stats = useMemo(() => {
    const modules = nodes.filter((n) => n.parentId === null).length;
    const leaves = nodes.filter((n) => n.nodeType === 'leaf').length;
    const financial = nodes.filter((n) => n.parentId === null && n.assetCategory === 'financial').length;
    const physical = nodes.filter((n) => n.parentId === null && n.assetCategory === 'physical').length;
    return { modules, leaves, financial, physical, total: nodes.length };
  }, [nodes]);

  // ---------- 渲染 ----------
  if (loading) return <LoadingSpinner message="加载资产树…" />;

  const renderTreeNode = (n: EditTreeNode, depth: number, isLast: boolean): React.ReactNode => {
    const kids = childrenOf(n.tempId);
    const isCollapsed = collapsed.has(n.tempId);
    const hasChildren = kids.length > 0;
    const isModule = n.nodeType === 'module';
    const isSub = n.nodeType === 'sub';
    const isLeaf = n.nodeType === 'leaf';

    return (
      <div key={n.tempId} className="select-none">
        <div
          className={`group flex items-center gap-2 rounded-lg border px-3 py-2.5 transition-all hover:shadow-sm ${
            n.enabled
              ? isModule
                ? 'border-slate-200 bg-white hover:border-blue-200'
                : isSub
                ? 'border-slate-150 bg-slate-50/50 hover:border-blue-200'
                : 'border-slate-100 bg-white hover:border-blue-200'
              : 'border-slate-100 bg-slate-50 opacity-60'
          }`}
          style={{ marginLeft: depth * 28 }}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={() =>
                setCollapsed((s) => {
                  const ns = new Set(s);
                  if (ns.has(n.tempId)) ns.delete(n.tempId);
                  else ns.add(n.tempId);
                  return ns;
                })
              }
              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            </button>
          ) : (
            <span className="inline-block w-[22px]" />
          )}

          {/* 节点类型标识 */}
          <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
            isModule ? 'bg-blue-100 text-blue-700' : isSub ? 'bg-purple-50 text-purple-600' : 'bg-slate-100 text-slate-500'
          }`}>
            {TYPE_LABEL[n.nodeType]}
          </span>

          {/* 资产分类标签（仅顶层模块） */}
          {isModule && n.parentId === null && (
            <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              n.assetCategory === 'financial' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
            }`}>
              {CATEGORY_LABEL[n.assetCategory]}
            </span>
          )}

          {/* 节点名称 */}
          <span className={`flex-1 truncate text-sm font-medium ${
            !n.enabled ? 'text-slate-400 line-through' : isModule ? 'text-slate-900' : 'text-slate-700'
          }`}>
            {n.name || <span className="italic text-slate-300">未命名</span>}
          </span>

          {/* 收益率 */}
          <span className="hidden text-[11px] text-slate-400 sm:inline" title="目标年化收益率">
            {n.targetRateAnnual !== null ? fmtRate(n.targetRateAnnual) : `继承 ${fmtRate(effectiveRate(n))}`}
          </span>

          {/* 频率 */}
          <span className="hidden text-[11px] text-slate-400 lg:inline" title="更新频率">
            {effectiveFreqLabel(n)}
          </span>

          {/* 识别信息 */}
          {isLeaf && n.identityInfo && (
            <span className="hidden text-[11px] text-slate-300 xl:inline" title="识别信息">
              {n.identityInfo}
            </span>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <IconBtn title="编辑" onClick={() => openEditDialog(n)}>
              <Edit2 size={13} />
            </IconBtn>
            {!isLeaf && (
              <IconBtn title="添加子节点" onClick={() => openCreateDialog(n.tempId)}>
                <Plus size={13} />
              </IconBtn>
            )}
            {isLeaf && !n.isPlaceholder && n.assetCategory === 'physical' && (
              <IconBtn title="折旧配置" onClick={() => void openDepDialog(n)}>
                <Calculator size={13} />
              </IconBtn>
            )}
            {isLeaf && !n.isPlaceholder && (
              <IconBtn title="升级为分组" onClick={() => upgradeLeaf(n)}>
                <FolderPlus size={13} />
              </IconBtn>
            )}
            <IconBtn title="上移" onClick={() => move(n, -1)}>
              <ArrowUp size={13} />
            </IconBtn>
            <IconBtn title="下移" onClick={() => move(n, 1)}>
              <ArrowDown size={13} />
            </IconBtn>
            <IconBtn title="删除" danger onClick={() => setConfirmDel(n)}>
              <Trash2 size={13} />
            </IconBtn>
          </div>
        </div>

        {/* 子节点 */}
        {!isCollapsed && hasChildren && (
          <div className="relative">
            {/* 连接线 */}
            <div
              className="absolute left-[13px] top-0 bottom-2 border-l-2 border-slate-200"
              style={{ marginLeft: depth * 28 }}
            />
            {kids.map((k, i) => renderTreeNode(k, depth + 1, i === kids.length - 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">资产树管理</h2>
          {config && (
            <p className="mt-0.5 text-xs text-slate-400">
              当前版本 v{config.version} ｜ 生效起始 {fmtMonth(config.effectiveFromMonth)} ｜ 节点 {stats.total} 个
              （{stats.financial} 资金 · {stats.physical} 实物 · {stats.leaves} 末级）
              {dirty && <span className="ml-2 text-amber-600">● 有未保存修改</span>}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => openCreateDialog(null, 'financial')}
            className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm text-blue-700 transition-colors hover:bg-blue-100"
          >
            ＋ 资金资产模块
          </button>
          <button
            onClick={() => openCreateDialog(null, 'physical')}
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-700 transition-colors hover:bg-amber-100"
          >
            ＋ 实物资产模块
          </button>
          <button
            onClick={() => setSaveDialog(true)}
            disabled={!dirty || nodes.length === 0}
            className="btn-primary py-1.5"
          >
            保存新版本配置
          </button>
        </div>
      </div>

      {/* 树形展示 */}
      <div className="space-y-1">
        {childrenOf(null).map((n, i, arr) => renderTreeNode(n, 0, i === arr.length - 1))}
      </div>

      {nodes.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-slate-200 bg-white p-12 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
            <Plus size={24} className="text-slate-400" />
          </div>
          <p className="text-sm font-medium text-slate-600">还没有资产节点</p>
          <p className="mt-1 text-xs text-slate-400">点击上方「＋ 资金资产模块」或「＋ 实物资产模块」开始构建你的资产树</p>
        </div>
      )}

      {/* 规则提示 */}
      {nodes.length > 0 && (
        <div className="rounded-lg border border-slate-100 bg-slate-50/50 px-4 py-3">
          <p className="text-[11px] text-slate-400">
            提示：鼠标悬停节点可显示操作按钮 · 收益率/频率留空自动继承上级 · 保存生成新版本仅影响未来月份
          </p>
        </div>
      )}

      {/* 新建/编辑节点弹窗 */}
      {nodeDialog && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setNodeDialog(null)} />
          <div className="animate-in zoom-in-95 relative w-full max-w-md rounded-xl bg-white p-6 shadow-2xl duration-200">
            <h3 className="mb-1 font-semibold text-slate-900">
              {nodeDialog.mode === 'create' ? '添加节点' : '编辑节点'}
            </h3>
            <p className="mb-4 text-xs text-slate-400">
              {nodeDialog.mode === 'create'
                ? nodeDialog.parentId
                  ? '在当前节点下添加子节点'
                  : '创建一个新的顶层资产模块'
                : '修改节点属性'}
            </p>

            {/* 名称 */}
            <div className="mb-3">
              <label className="mb-1 block text-xs font-medium text-slate-600">名称 *</label>
              <input
                value={nodeDialog.form.name}
                onChange={(e) => setNodeDialog({ ...nodeDialog, form: { ...nodeDialog.form, name: e.target.value } })}
                placeholder="如：现金/存款/货币基金、房产、股票账户…"
                maxLength={30}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                autoFocus
              />
            </div>

            {/* 资产分类（仅顶层模块） */}
            {!nodeDialog.parentId && (
              <div className="mb-3">
                <label className="mb-1 block text-xs font-medium text-slate-600">资产分类</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setNodeDialog({ ...nodeDialog, form: { ...nodeDialog.form, assetCategory: 'financial' } })}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      nodeDialog.form.assetCategory === 'financial'
                        ? 'border-blue-300 bg-blue-50 text-blue-700'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    💰 资金资产
                  </button>
                  <button
                    type="button"
                    onClick={() => setNodeDialog({ ...nodeDialog, form: { ...nodeDialog.form, assetCategory: 'physical' } })}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      nodeDialog.form.assetCategory === 'physical'
                        ? 'border-amber-300 bg-amber-50 text-amber-700'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    📱 实物资产
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">资金资产：银行存款、基金、股票等；实物资产：房产、车辆、电子产品等</p>
              </div>
            )}

            {/* 目标收益率 + 更新频率 */}
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">目标年化收益率（%）</label>
                <input
                  value={nodeDialog.form.targetRateAnnual}
                  onChange={(e) => setNodeDialog({ ...nodeDialog, form: { ...nodeDialog.form, targetRateAnnual: e.target.value } })}
                  placeholder={nodeDialog.parentId ? '留空=继承上级' : '留空=不设定'}
                  inputMode="decimal"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">更新频率</label>
                <select
                  value={nodeDialog.form.updateFreq}
                  onChange={(e) => setNodeDialog({ ...nodeDialog, form: { ...nodeDialog.form, updateFreq: e.target.value as UpdateFreq | '' } })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                >
                  {FREQ_OPTIONS.filter((f) => nodeDialog.parentId || f.value !== '').map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                  {!nodeDialog.parentId && !nodeDialog.form.updateFreq && (
                    <option value="" disabled>请选择更新频率</option>
                  )}
                </select>
              </div>
            </div>

            {/* 流动性分级 */}
            <div className="mb-3">
              <label className="mb-1 block text-xs font-medium text-slate-600">流动性分级</label>
              <div className="flex gap-2">
                {LIQUIDITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setNodeDialog({ ...nodeDialog, form: { ...nodeDialog.form, liquidity: opt.value } })}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      nodeDialog.form.liquidity === opt.value
                        ? opt.value === 'high' ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                          : opt.value === 'medium' ? 'border-blue-300 bg-blue-50 text-blue-700'
                          : 'border-orange-300 bg-orange-50 text-orange-700'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                {LIQUIDITY_OPTIONS.find((o) => o.value === nodeDialog.form.liquidity)?.desc}
              </p>
            </div>

            {/* 识别信息（仅末级） */}
            {nodeDialog.form.nodeType === 'leaf' && (
              <div className="mb-3">
                <label className="mb-1 block text-xs font-medium text-slate-600">识别信息（可选）</label>
                <input
                  value={nodeDialog.form.identityInfo}
                  onChange={(e) => setNodeDialog({ ...nodeDialog, form: { ...nodeDialog.form, identityInfo: e.target.value } })}
                  placeholder="如：招商银行尾号1234、蚂蚁基金账户"
                  maxLength={50}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              </div>
            )}

            {/* 启用状态 */}
            <div className="mb-4">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={nodeDialog.form.enabled}
                  onChange={(e) => setNodeDialog({ ...nodeDialog, form: { ...nodeDialog.form, enabled: e.target.checked } })}
                  className="h-4 w-4 accent-blue-600"
                />
                启用该节点（停用后不参与录入和合计）
              </label>
            </div>

            {/* 按钮 */}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setNodeDialog(null)}
                className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 hover:bg-slate-200"
              >
                取消
              </button>
              <button
                onClick={submitNodeDialog}
                className="btn-primary"
              >
                {nodeDialog.mode === 'create' ? '添加' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 保存新版本弹窗 */}
      {saveDialog && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !saving && setSaveDialog(false)} />
          <div className="animate-in zoom-in-95 relative w-full max-w-md rounded-xl bg-white p-6 shadow-2xl duration-200">
            <h3 className="mb-1 font-semibold text-slate-900">保存新版本配置</h3>
            <p className="mb-4 text-xs text-slate-400">
              整树提交生成 v{(config?.version ?? 0) + 1}；新版本仅影响未来月份，历史快照口径不变。
            </p>
            <div className="mb-3">
              <label className="mb-1 block text-sm text-slate-600">生效起始月份</label>
              <input
                type="month"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </div>
            <div className="mb-4">
              <label className="mb-1 block text-sm text-slate-600">版本备注（可选）</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={100}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                placeholder="如：拆分消费基金海外账户"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setSaveDialog(false)}
                disabled={saving}
                className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 hover:bg-slate-200"
              >
                取消
              </button>
              <button
                onClick={() => void submit()}
                disabled={saving}
                className="btn-primary"
              >
                {saving ? '保存中…' : '确认保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 折旧配置弹窗 */}
      {depDialog && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !depDialog.saving && setDepDialog(null)} />
          <div className="animate-in zoom-in-95 relative w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl duration-200">
            <h3 className="mb-1 flex items-center gap-2 font-semibold text-slate-900">
              <Calculator size={18} className="text-amber-600" />
              折旧配置 — {depDialog.node.name}
            </h3>
            <p className="mb-4 text-xs text-slate-400">
              设置实物资产折旧参数，系统将按直线法自动计算当前估值
            </p>

            {depDialog.loading ? (
              <div className="py-8 text-center text-sm text-slate-400">加载中…</div>
            ) : (
              <>
                {/* 折旧分类 */}
                <div className="mb-3">
                  <label className="mb-1 block text-xs font-medium text-slate-600">折旧分类 *</label>
                  <select
                    value={depDialog.form.depreciationCategory}
                    onChange={(e) => {
                      const cat = DEP_CATEGORIES.find((c) => c.value === e.target.value) ?? DEP_CATEGORIES[0];
                      setDepDialog((prev) => prev ? {
                        ...prev,
                        form: {
                          ...prev.form,
                          depreciationCategory: cat.value,
                          usefulLifeYears: String(cat.defaultYears),
                          salvageRate: String(Math.round(cat.defaultRate * 100)),
                        },
                      } : null);
                    }}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                  >
                    {DEP_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}（{c.minYears}~{c.maxYears} 年 · {c.methodLabel}）
                      </option>
                    ))}
                  </select>
                  {(() => {
                    const cat = DEP_CATEGORIES.find((c) => c.value === depDialog.form.depreciationCategory);
                    return cat ? (
                      <p className="mt-1 text-[11px] text-slate-400">
                        折旧方法：<span className="font-medium text-slate-600">{cat.methodLabel}</span>
                        {cat.method === 'sum_of_years' && ' — 前期折旧多、后期递减，贴近电子产品实际贬值规律'}
                        {cat.method === 'straight' && ' — 每月均匀折旧'}
                        ，年限范围 {cat.minYears}~{cat.maxYears} 年
                      </p>
                    ) : null;
                  })()}
                </div>

                {/* 购入原值 + 购入年月 */}
                <div className="mb-3 grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">购入原值（元） *</label>
                    <input
                      value={depDialog.form.originalValue}
                      onChange={(e) => setDepDialog((prev) => prev ? { ...prev, form: { ...prev.form, originalValue: e.target.value } } : null)}
                      placeholder="如 6999"
                      inputMode="decimal"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">购入年月 *</label>
                    <input
                      type="month"
                      value={depDialog.form.purchaseDate}
                      onChange={(e) => setDepDialog((prev) => prev ? { ...prev, form: { ...prev.form, purchaseDate: e.target.value } } : null)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                {/* 折旧年限 */}
                <div className="mb-3">
                  {(() => {
                    const cat = DEP_CATEGORIES.find((c) => c.value === depDialog.form.depreciationCategory);
                    return (
                      <>
                        <label className="mb-1 block text-xs font-medium text-slate-600">
                          折旧年限（年） *
                          <span className="ml-2 font-normal text-slate-400">
                            范围 {cat?.minYears ?? 3}~{cat?.maxYears ?? 10} 年
                          </span>
                        </label>
                        <input
                          type="range"
                          min={cat?.minYears ?? 3}
                          max={cat?.maxYears ?? 10}
                          step={1}
                          value={depDialog.form.usefulLifeYears || cat?.defaultYears || 3}
                          onChange={(e) => setDepDialog((prev) => prev ? { ...prev, form: { ...prev.form, usefulLifeYears: e.target.value } } : null)}
                          className="w-full accent-blue-600"
                        />
                        <div className="mt-1 flex items-center justify-between">
                          <span className="text-[11px] text-slate-400">{cat?.minYears} 年</span>
                          <span className="rounded bg-blue-50 px-2 py-0.5 text-sm font-medium text-blue-700">
                            {depDialog.form.usefulLifeYears || cat?.defaultYears} 年
                          </span>
                          <span className="text-[11px] text-slate-400">{cat?.maxYears} 年</span>
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* 残值模式 */}
                <div className="mb-3">
                  <label className="mb-1 block text-xs font-medium text-slate-600">残值计算方式</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setDepDialog((prev) => prev ? { ...prev, form: { ...prev.form, salvageMode: 'rate' } } : null)}
                      className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        depDialog.form.salvageMode === 'rate'
                          ? 'border-blue-300 bg-blue-50 text-blue-700'
                          : 'border-slate-200 text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      按残值率
                    </button>
                    <button
                      type="button"
                      onClick={() => setDepDialog((prev) => prev ? { ...prev, form: { ...prev.form, salvageMode: 'market' } } : null)}
                      className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        depDialog.form.salvageMode === 'market'
                          ? 'border-amber-300 bg-amber-50 text-amber-700'
                          : 'border-slate-200 text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      按市场价
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">
                    {depDialog.form.salvageMode === 'rate'
                      ? '残值 = 原值 × 残值率，折旧到期后资产价值不低于残值'
                      : '根据品牌/型号的二手市场行情手动设定最终残值'}
                  </p>
                </div>

                {/* 残值率 或 市场残值 */}
                {depDialog.form.salvageMode === 'rate' ? (
                  <div className="mb-3">
                    <label className="mb-1 block text-xs font-medium text-slate-600">残值率（%）</label>
                    <input
                      value={depDialog.form.salvageRate}
                      onChange={(e) => setDepDialog((prev) => prev ? { ...prev, form: { ...prev.form, salvageRate: e.target.value } } : null)}
                      placeholder="如 20 表示 20%"
                      inputMode="decimal"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                    {depDialog.form.originalValue && depDialog.form.salvageRate && (
                      <p className="mt-1 text-[11px] text-slate-500">
                        残值 ≈ {fmtMoney(Number(depDialog.form.originalValue) * Number(depDialog.form.salvageRate) / 100)} 元
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="mb-3">
                    <label className="mb-1 block text-xs font-medium text-slate-600">市场残值（元）</label>
                    <input
                      value={depDialog.form.marketSalvageValue}
                      onChange={(e) => setDepDialog((prev) => prev ? { ...prev, form: { ...prev.form, marketSalvageValue: e.target.value } } : null)}
                      placeholder="根据二手市场行情估算"
                      inputMode="decimal"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                  </div>
                )}

                {/* 实时预览当前估值 */}
                {depDialog.form.originalValue && depDialog.form.purchaseDate && (
                  <div className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
                    {(() => {
                      const cat = DEP_CATEGORIES.find((c) => c.value === depDialog.form.depreciationCategory);
                      return <p className="text-xs font-medium text-emerald-700">当前估值预览（{cat?.methodLabel ?? '直线法'}）</p>;
                    })()}
                    {(() => {
                      const cat = DEP_CATEGORIES.find((c) => c.value === depDialog.form.depreciationCategory);
                      const method = cat?.method ?? 'straight';
                      const ov = Number(depDialog.form.originalValue);
                      const yrs = Number(depDialog.form.usefulLifeYears) || 1;
                      const months = yrs * 12;
                      const sv = depDialog.form.salvageMode === 'market'
                        ? Number(depDialog.form.marketSalvageValue) || 0
                        : ov * (Number(depDialog.form.salvageRate) / 100 || 0);
                      const depreciable = ov - sv;
                      const now = new Date();
                      const pd = new Date(depDialog.form.purchaseDate + '-01');
                      const elapsed = Math.max(0, (now.getFullYear() - pd.getFullYear()) * 12 + (now.getMonth() - pd.getMonth()));
                      const effective = Math.min(elapsed, months);

                      let current: number;
                      let currentMonthDep: number;

                      if (method === 'sum_of_years') {
                        const totalYears = yrs;
                        const sumOfYears = (totalYears * (totalYears + 1)) / 2;
                        let totalDep = 0;
                        currentMonthDep = 0;
                        for (let m = 0; m < effective; m++) {
                          const yearIndex = Math.floor(m / 12);
                          const remainingYears = totalYears - yearIndex;
                          const mDep = (depreciable * (remainingYears / sumOfYears)) / 12;
                          totalDep += mDep;
                          currentMonthDep = mDep;
                        }
                        current = Math.max(sv, ov - totalDep);
                      } else {
                        const depAmt = depreciable / months;
                        current = Math.max(sv, ov - depAmt * effective);
                        currentMonthDep = depAmt;
                      }

                      const pct = ov > 0 ? (current / ov * 100).toFixed(1) : '0';
                      return (
                        <div className="mt-1 flex flex-wrap items-center gap-4 text-sm">
                          <span className="text-emerald-800 font-medium">{fmtMoney(current)} 元</span>
                          <span className="text-emerald-600 text-xs">（原值的 {pct}%）</span>
                          <span className="text-emerald-600 text-xs">已折旧 {effective} 个月 / 共 {months} 个月</span>
                          <span className="text-emerald-600 text-xs">当月折旧 {fmtMoney(currentMonthDep)}</span>
                          {effective >= months && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">已折旧完毕</span>}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* 已有配置提示 */}
                {depDialog.existing && (
                  <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50/50 p-2 text-xs text-blue-600">
                    已有折旧配置（当前估值 {fmtMoney(depDialog.existing.currentValue ?? 0)}），提交将覆盖更新
                  </div>
                )}

                {/* 按钮 */}
                <div className="flex items-center justify-between">
                  <div>
                    {depDialog.existing && (
                      <button
                        onClick={() => void deleteDepreciation()}
                        disabled={depDialog.saving}
                        className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 hover:bg-red-100 disabled:opacity-50"
                      >
                        删除折旧
                      </button>
                    )}
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setDepDialog(null)}
                      disabled={depDialog.saving}
                      className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 hover:bg-slate-200"
                    >
                      取消
                    </button>
                    <button
                      onClick={() => void submitDepDialog()}
                      disabled={depDialog.saving}
                      className="btn-primary"
                    >
                      {depDialog.saving ? '保存中…' : '保存折旧配置'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title="删除节点"
        message={
          confirmDel ? `确定删除「${confirmDel.name || '未命名'}」及其全部子节点吗？保存后生效，保存前可撤销。` : ''
        }
        confirmText="删除"
        variant="danger"
        onConfirm={() => {
          if (confirmDel) removeSubtree(confirmDel);
          setConfirmDel(null);
        }}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded p-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        danger ? 'text-slate-400 hover:bg-red-50 hover:text-red-600' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  );
}
