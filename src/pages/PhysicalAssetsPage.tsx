/**
 * 实物资产管理页：
 * - 资产明细表（原值、累计折旧、每日折旧、每月折旧、当前残值、预计退休日期）
 * - 残值曲线图（SVG）
 * - 新增/编辑折旧配置入口
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useToast } from '@shared/core/hooks/useToast';
import { LoadingSpinner } from '@shared/core/components/LoadingSpinner';
import { TableScroll } from '@shared/core';
import { Calculator, ChevronDown, ChevronRight, Plus, TrendingDown } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { currentMonth, fmtMoney } from '../lib/format';
import type { TreeConfig, TreeNode } from '../lib/types';

type DepCategory = 'electronics' | 'furniture' | 'vehicle' | 'machinery' | 'building';
type DepMethod = 'straight' | 'sum_of_years';

const DEP_CATEGORIES: { value: DepCategory; label: string; minYears: number; maxYears: number; defaultYears: number; defaultRate: number; method: DepMethod; methodLabel: string }[] = [
  { value: 'electronics', label: '电子设备', minYears: 3, maxYears: 5, defaultYears: 3, defaultRate: 0.20, method: 'sum_of_years', methodLabel: '年数总和法' },
  { value: 'furniture', label: '器具/家具/家电', minYears: 5, maxYears: 10, defaultYears: 5, defaultRate: 0.30, method: 'straight', methodLabel: '直线法' },
  { value: 'vehicle', label: '运输工具', minYears: 4, maxYears: 10, defaultYears: 4, defaultRate: 0.40, method: 'straight', methodLabel: '直线法' },
  { value: 'machinery', label: '机械设备', minYears: 5, maxYears: 10, defaultYears: 5, defaultRate: 0.15, method: 'straight', methodLabel: '直线法' },
  { value: 'building', label: '房屋/建筑物', minYears: 20, maxYears: 40, defaultYears: 20, defaultRate: 0.70, method: 'straight', methodLabel: '直线法' },
];

interface DepreciationItem {
  id: number;
  nodeId: number;
  configId: number;
  depreciationCategory: DepCategory;
  originalValue: number;
  purchaseDate: string;
  usefulLifeMonths: number;
  salvageRate: number;
  salvageMode: 'rate' | 'market';
  marketSalvageValue: number | null;
  currentValue: number;
  monthlyDep: number;
  totalDepreciated: number;
  salvageValue: number;
  depreciatedMonths: number;
  isFullyDepreciated: boolean;
  method: DepMethod;
}

interface DepFormData {
  nodeId: number | null;
  depreciationCategory: DepCategory;
  originalValue: string;
  purchaseDate: string;
  usefulLifeYears: string;
  salvageMode: 'rate' | 'market';
  salvageRate: string;
  marketSalvageValue: string;
}

const emptyForm = (): DepFormData => ({
  nodeId: null,
  depreciationCategory: 'electronics',
  originalValue: '',
  purchaseDate: '',
  usefulLifeYears: '3',
  salvageMode: 'rate',
  salvageRate: '20',
  marketSalvageValue: '',
});

export default function PhysicalAssetsPage() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [tree, setTree] = useState<TreeConfig | null>(null);
  const [items, setItems] = useState<DepreciationItem[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<DepFormData>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [selectedItem, setSelectedItem] = useState<DepreciationItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const treeRes = await api<TreeConfig>('/api/tree');
      setTree(treeRes);
      const depRes = await api<{ items: DepreciationItem[] }>('/api/depreciation', {
        query: { configId: String(treeRes.configId), month: currentMonth() },
      });
      setItems(depRes.items);
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.message ?? '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  const physicalLeaves = useMemo(() => {
    if (!tree) return [];
    const nodes = tree.nodes;
    const hasChild = new Set(nodes.filter(n => n.parentId !== null).map(n => n.parentId));
    return nodes.filter(n => n.enabled && n.assetCategory === 'physical' && !hasChild.has(n.id));
  }, [tree]);

  const nodeNameMap = useMemo(() => {
    const map = new Map<number, string>();
    if (!tree) return map;
    for (const n of tree.nodes) map.set(n.id, n.name);
    return map;
  }, [tree]);

  const configuredNodeIds = useMemo(() => new Set(items.map(i => i.nodeId)), [items]);
  const unconfiguredLeaves = useMemo(
    () => physicalLeaves.filter(n => !configuredNodeIds.has(n.id)),
    [physicalLeaves, configuredNodeIds]
  );

  const totalOriginal = useMemo(() => items.reduce((s, i) => s + i.originalValue, 0), [items]);
  const totalCurrent = useMemo(() => items.reduce((s, i) => s + i.currentValue, 0), [items]);
  const totalDepreciated = useMemo(() => items.reduce((s, i) => s + i.totalDepreciated, 0), [items]);

  const openCreate = (nodeId?: number) => {
    const f = emptyForm();
    if (nodeId) f.nodeId = nodeId;
    setForm(f);
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (item: DepreciationItem) => {
    setForm({
      nodeId: item.nodeId,
      depreciationCategory: item.depreciationCategory,
      originalValue: String(item.originalValue),
      purchaseDate: item.purchaseDate.slice(0, 7),
      usefulLifeYears: String(Math.round(item.usefulLifeMonths / 12)),
      salvageMode: item.salvageMode,
      salvageRate: String(Math.round(item.salvageRate * 100)),
      marketSalvageValue: item.marketSalvageValue !== null ? String(item.marketSalvageValue) : '',
    });
    setEditingId(item.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.nodeId || !tree) {
      showToast('请选择资产项', 'error');
      return;
    }
    const originalValue = parseFloat(form.originalValue);
    if (!originalValue || originalValue <= 0) {
      showToast('购入原值需为正数', 'error');
      return;
    }
    if (!form.purchaseDate) {
      showToast('请填写购入年月', 'error');
      return;
    }
    setSaving(true);
    try {
      await api('/api/depreciation', {
        method: 'POST',
        body: {
          nodeId: form.nodeId,
          configId: tree.configId,
          depreciationCategory: form.depreciationCategory,
          originalValue,
          purchaseDate: form.purchaseDate,
          usefulLifeMonths: parseInt(form.usefulLifeYears) * 12,
          salvageRate: parseFloat(form.salvageRate) / 100,
          salvageMode: form.salvageMode,
          marketSalvageValue: form.salvageMode === 'market' ? parseFloat(form.marketSalvageValue) || null : null,
        },
      });
      showToast(editingId ? '折旧配置已更新' : '折旧配置已添加', 'success');
      setShowForm(false);
      await load();
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.message ?? '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除该折旧配置？删除后该资产将需要手动录入估值。')) return;
    try {
      await api(`/api/depreciation/${id}`, { method: 'DELETE' });
      showToast('已删除', 'success');
      await load();
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.message ?? '删除失败', 'error');
    }
  };

  const catInfo = (cat: DepCategory) => DEP_CATEGORIES.find(c => c.value === cat);

  const retirementDate = (item: DepreciationItem) => {
    const d = new Date(item.purchaseDate + (item.purchaseDate.length === 7 ? '-01' : ''));
    d.setMonth(d.getMonth() + item.usefulLifeMonths);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };

  const dailyDep = (item: DepreciationItem) => item.monthlyDep / 30;

  if (loading) return <LoadingSpinner message="加载实物资产数据…" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">实物资产管理</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            管理实物资产折旧配置，查看残值变化趋势
          </p>
        </div>
        <button onClick={() => openCreate()} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          <Plus size={14} /> 新增折旧配置
        </button>
      </div>

      {/* KPI 卡片（容器查询：窄容器两列，≥60rem 四列，与原 xl: 断点桌面列数一致） */}
      <div className="cq">
        <div className="cq-grid cq-cols-4-wide gap-3">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs text-slate-500">资产总数</p>
          <p className="mt-1 text-xl font-bold text-slate-800">{items.length} 项</p>
          {unconfiguredLeaves.length > 0 && <p className="mt-0.5 text-[11px] text-amber-600">{unconfiguredLeaves.length} 项未配置折旧</p>}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs text-slate-500">购入总原值</p>
          <p className="mt-1 text-xl font-bold text-slate-800">{fmtMoney(totalOriginal)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs text-slate-500">当前总残值</p>
          <p className="mt-1 text-xl font-bold text-emerald-700">{fmtMoney(totalCurrent)}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">保值率 {totalOriginal > 0 ? ((totalCurrent / totalOriginal) * 100).toFixed(1) : '0'}%</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs text-slate-500">累计折旧</p>
          <p className="mt-1 text-xl font-bold text-red-600">{fmtMoney(totalDepreciated)}</p>
        </div>
        </div>
      </div>

      {/* 残值曲线（选中资产时展示） */}
      {selectedItem && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">
              「{nodeNameMap.get(selectedItem.nodeId) ?? ''}」残值变化曲线
            </h3>
            <button onClick={() => setSelectedItem(null)} className="text-xs text-slate-400 hover:text-slate-600">收起 ✕</button>
          </div>
          <DepreciationChart item={selectedItem} />
        </div>
      )}

      {/* 资产明细表 */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
          <TrendingDown size={40} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm text-slate-500">尚未配置任何实物资产折旧</p>
          <p className="mt-1 text-xs text-slate-400">请先在「资产树管理」中添加实物资产节点，然后在此配置折旧参数</p>
          {unconfiguredLeaves.length > 0 && (
            <button onClick={() => openCreate(unconfiguredLeaves[0].id)} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
              为「{unconfiguredLeaves[0].name}」配置折旧
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <TableScroll label="实物资产明细">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-4 py-3 font-medium">资产名称</th>
                  <th className="px-4 py-3 font-medium">分类</th>
                  <th className="px-4 py-3 font-medium">折旧方法</th>
                  <th className="px-4 py-3 text-right font-medium">购入原值</th>
                  <th className="px-4 py-3 text-right font-medium">累计折旧</th>
                  <th className="px-4 py-3 text-right font-medium">每月折旧</th>
                  <th className="px-4 py-3 text-right font-medium">每日折旧</th>
                  <th className="px-4 py-3 text-right font-medium">当前残值</th>
                  <th className="px-4 py-3 font-medium">预计退休</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => {
                  const ci = catInfo(item.depreciationCategory);
                  const retired = retirementDate(item);
                  return (
                    <tr key={item.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                      <td className="px-4 py-3">
                        <button onClick={() => setSelectedItem(item)} className="text-left font-medium text-blue-600 hover:underline">
                          {nodeNameMap.get(item.nodeId) ?? `#${item.nodeId}`}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">{ci?.label ?? item.depreciationCategory}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{ci?.methodLabel ?? item.method}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(item.originalValue)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-red-600">{fmtMoney(item.totalDepreciated)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{fmtMoney(item.monthlyDep)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-500">{fmtMoney(dailyDep(item))}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium text-emerald-700">{fmtMoney(item.currentValue)}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{retired}</td>
                      <td className="px-4 py-3">
                        {item.isFullyDepreciated ? (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">已到期</span>
                        ) : (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">折旧中</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button onClick={() => openEdit(item)} className="text-xs text-blue-600 hover:underline">编辑</button>
                          <button onClick={() => void handleDelete(item.id)} className="text-xs text-red-500 hover:underline">删除</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </div>
      )}

      {/* 未配置折旧的实物资产提示 */}
      {unconfiguredLeaves.length > 0 && items.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-800">以下实物资产尚未配置折旧（需每月手动录入估值）：</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {unconfiguredLeaves.map(n => (
              <button key={n.id} onClick={() => openCreate(n.id)} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-100">
                <Calculator size={11} className="mr-1 inline" />{n.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 新增/编辑弹窗（modal-clamp 钳制：小屏不超视口） */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            className="modal-clamp max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-6 shadow-xl"
            style={{ '--modal-max': '32rem', '--modal-max-h': '85vh' } as CSSProperties}
          >
            <h3 className="mb-4 text-lg font-bold text-slate-900">{editingId ? '编辑折旧配置' : '新增折旧配置'}</h3>

            {/* 资产选择 */}
            <div className="mb-3">
              <label className="mb-1 block text-xs text-slate-500">资产项</label>
              <select
                value={form.nodeId ?? ''}
                onChange={e => setForm({ ...form, nodeId: Number(e.target.value) || null })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                disabled={!!editingId}
              >
                <option value="">请选择实物资产…</option>
                {physicalLeaves.map(n => (
                  <option key={n.id} value={n.id} disabled={configuredNodeIds.has(n.id) && items.find(i => i.nodeId === n.id)?.id !== editingId}>
                    {n.name}{configuredNodeIds.has(n.id) ? '（已配置）' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* 分类 */}
            <div className="mb-3">
              <label className="mb-1 block text-xs text-slate-500">资产分类</label>
              <select
                value={form.depreciationCategory}
                onChange={e => {
                  const cat = e.target.value as DepCategory;
                  const ci = DEP_CATEGORIES.find(c => c.value === cat)!;
                  setForm({
                    ...form,
                    depreciationCategory: cat,
                    usefulLifeYears: String(ci.defaultYears),
                    salvageRate: String(Math.round(ci.defaultRate * 100)),
                  });
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              >
                {DEP_CATEGORIES.map(c => (
                  <option key={c.value} value={c.value}>{c.label}（{c.methodLabel}，{c.minYears}~{c.maxYears}年）</option>
                ))}
              </select>
            </div>

            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500">购入原值（元）</label>
                <input value={form.originalValue} onChange={e => setForm({ ...form, originalValue: e.target.value })} inputMode="decimal" placeholder="如 6999" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">购入年月</label>
                <input type="month" value={form.purchaseDate} onChange={e => setForm({ ...form, purchaseDate: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
            </div>

            {/* 折旧年限 */}
            <div className="mb-3">
              <label className="mb-1 block text-xs text-slate-500">
                折旧年限：{form.usefulLifeYears} 年
                {(() => {
                  const ci = DEP_CATEGORIES.find(c => c.value === form.depreciationCategory);
                  return ci ? `（范围 ${ci.minYears}~${ci.maxYears} 年）` : '';
                })()}
              </label>
              <input
                type="range"
                min={DEP_CATEGORIES.find(c => c.value === form.depreciationCategory)?.minYears ?? 3}
                max={DEP_CATEGORIES.find(c => c.value === form.depreciationCategory)?.maxYears ?? 10}
                value={form.usefulLifeYears}
                onChange={e => setForm({ ...form, usefulLifeYears: e.target.value })}
                className="w-full accent-blue-600"
              />
            </div>

            {/* 残值模式 */}
            <div className="mb-3">
              <label className="mb-1 block text-xs text-slate-500">残值计算方式</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input type="radio" name="salvageMode" value="rate" checked={form.salvageMode === 'rate'} onChange={() => setForm({ ...form, salvageMode: 'rate' })} className="accent-blue-600" />
                  按残值率
                </label>
                <label className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input type="radio" name="salvageMode" value="market" checked={form.salvageMode === 'market'} onChange={() => setForm({ ...form, salvageMode: 'market' })} className="accent-blue-600" />
                  按市场价
                </label>
              </div>
            </div>

            {form.salvageMode === 'rate' ? (
              <div className="mb-4">
                <label className="mb-1 block text-xs text-slate-500">残值率（%）</label>
                <input value={form.salvageRate} onChange={e => setForm({ ...form, salvageRate: e.target.value })} inputMode="decimal" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
                {form.originalValue && (
                  <p className="mt-1 text-xs text-slate-400">
                    预估残值：{fmtMoney(parseFloat(form.originalValue) * parseFloat(form.salvageRate) / 100 || 0)}
                  </p>
                )}
              </div>
            ) : (
              <div className="mb-4">
                <label className="mb-1 block text-xs text-slate-500">市场残值（元）</label>
                <input value={form.marketSalvageValue} onChange={e => setForm({ ...form, marketSalvageValue: e.target.value })} inputMode="decimal" placeholder="参考二手市场价格" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button onClick={() => setShowForm(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">取消</button>
              <button onClick={() => void handleSave()} disabled={saving} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 残值曲线 SVG 组件
 */
function DepreciationChart({ item }: { item: DepreciationItem }) {
  const points = useMemo(() => {
    const result: { month: number; value: number; label: string }[] = [];
    const totalMonths = item.usefulLifeMonths;
    const salvageValue = item.salvageMode === 'market' && item.marketSalvageValue !== null
      ? item.marketSalvageValue
      : item.originalValue * item.salvageRate;
    const depreciableAmount = item.originalValue - salvageValue;

    const step = Math.max(1, Math.floor(totalMonths / 24));

    for (let m = 0; m <= totalMonths; m += step) {
      let value: number;
      if (item.method === 'sum_of_years') {
        const totalYears = totalMonths / 12;
        const sumOfYears = (totalYears * (totalYears + 1)) / 2;
        let totalDep = 0;
        for (let i = 0; i < m; i++) {
          const yearIndex = Math.floor(i / 12);
          const remainingYears = totalYears - yearIndex;
          totalDep += (depreciableAmount * (remainingYears / sumOfYears)) / 12;
        }
        value = Math.max(salvageValue, item.originalValue - totalDep);
      } else {
        const monthlyDep = depreciableAmount / totalMonths;
        value = Math.max(salvageValue, item.originalValue - monthlyDep * m);
      }

      const d = new Date(item.purchaseDate + (item.purchaseDate.length === 7 ? '-01' : ''));
      d.setMonth(d.getMonth() + m);
      result.push({ month: m, value, label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` });
    }

    if (result[result.length - 1]?.month !== totalMonths) {
      const d = new Date(item.purchaseDate + (item.purchaseDate.length === 7 ? '-01' : ''));
      d.setMonth(d.getMonth() + totalMonths);
      result.push({ month: totalMonths, value: salvageValue, label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` });
    }

    return result;
  }, [item]);

  const W = 600;
  const H = 200;
  const PAD = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const maxVal = item.originalValue;
  const minVal = 0;
  const xScale = (m: number) => PAD.left + (m / item.usefulLifeMonths) * chartW;
  const yScale = (v: number) => PAD.top + chartH - ((v - minVal) / (maxVal - minVal)) * chartH;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.month).toFixed(1)} ${yScale(p.value).toFixed(1)}`).join(' ');

  const currentX = xScale(Math.min(item.depreciatedMonths, item.usefulLifeMonths));
  const currentY = yScale(item.currentValue);

  return (
    <TableScroll label="残值曲线图">
      {/* viewBox 等比缩放：宽容器 ≤600px 自适应铺满；窄容器保 400px 最小宽（内部滚动 + 滚动阴影提示，标签保持可读） */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[400px] max-w-[600px]">
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(r => {
          const y = PAD.top + chartH * (1 - r);
          return (
            <g key={r}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="#e2e8f0" strokeWidth={0.5} />
              <text x={PAD.left - 8} y={y + 3} textAnchor="end" className="fill-slate-400" fontSize={9}>
                {fmtMoney(maxVal * r)}
              </text>
            </g>
          );
        })}

        {/* X axis labels */}
        {points.filter((_, i) => i % Math.max(1, Math.floor(points.length / 6)) === 0 || i === points.length - 1).map(p => (
          <text key={p.month} x={xScale(p.month)} y={H - 5} textAnchor="middle" className="fill-slate-400" fontSize={8}>
            {p.label}
          </text>
        ))}

        {/* Curve */}
        <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth={2} />

        {/* Fill area */}
        <path
          d={`${pathD} L ${xScale(points[points.length - 1].month).toFixed(1)} ${yScale(0).toFixed(1)} L ${xScale(0).toFixed(1)} ${yScale(0).toFixed(1)} Z`}
          fill="url(#depGradient)"
          opacity={0.15}
        />

        {/* Current position dot */}
        <circle cx={currentX} cy={currentY} r={5} fill="#10b981" stroke="white" strokeWidth={2} />
        <text x={currentX + 8} y={currentY - 8} className="fill-emerald-700 font-medium" fontSize={10}>
          当前 {fmtMoney(item.currentValue)}
        </text>

        {/* Salvage line */}
        <line
          x1={PAD.left} y1={yScale(item.salvageValue)} x2={W - PAD.right} y2={yScale(item.salvageValue)}
          stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 2"
        />
        <text x={W - PAD.right + 2} y={yScale(item.salvageValue) + 3} className="fill-amber-600" fontSize={8}>
          残值
        </text>

        <defs>
          <linearGradient id="depGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>
      </svg>
    </TableScroll>
  );
}
