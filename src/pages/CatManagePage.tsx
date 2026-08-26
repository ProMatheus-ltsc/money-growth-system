/**
 * 收支分类管理页：
 * - 树形展示收入/支出分类结构（一级分类 → 二级分类）
 * - 新增/编辑/删除分类
 * - 调整排序
 * - 大额明细阈值设置
 * - 保存新版本配置
 */
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@shared/core/hooks/useToast';
import { LoadingSpinner } from '@shared/core/components/LoadingSpinner';
import { ConfirmDialog } from '@shared/core/components/ConfirmDialog';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Edit2, FolderPlus, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { CatConfig, CatItem } from '../lib/types';

interface EditCatItem {
  tempId: string;
  serverId?: number;
  name: string;
  sortOrder: number;
  children: EditCatItem[];
}

let seq = 0;
function nextId() { return `cat_${Date.now().toString(36)}_${++seq}`; }

function fromServer(items: CatItem[]): EditCatItem[] {
  return items.map(item => ({
    tempId: nextId(),
    serverId: item.id,
    name: item.name,
    sortOrder: item.sortOrder,
    children: (item.children ?? []).map(c => ({
      tempId: nextId(),
      serverId: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      children: [],
    })),
  }));
}

export default function CatManagePage() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<CatConfig | null>(null);
  const [income, setIncome] = useState<EditCatItem[]>([]);
  const [expense, setExpense] = useState<EditCatItem[]>([]);
  const [threshold, setThreshold] = useState('200');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [editDialog, setEditDialog] = useState<{ direction: 'income' | 'expense'; parentTempId: string | null; item: EditCatItem | null } | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{ direction: 'income' | 'expense'; parentTempId: string | null; tempId: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<CatConfig>('/api/cat-configs');
      setConfig(res);
      setIncome(fromServer(res.income));
      setExpense(fromServer(res.expense));
      setThreshold(String(res.threshold));
      setDirty(false);
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.message ?? '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  const getList = (dir: 'income' | 'expense') => dir === 'income' ? income : expense;
  const setList = (dir: 'income' | 'expense', items: EditCatItem[]) => {
    if (dir === 'income') setIncome(items);
    else setExpense(items);
    setDirty(true);
  };

  const addTopLevel = (dir: 'income' | 'expense') => {
    setEditDialog({ direction: dir, parentTempId: null, item: null });
    setEditName('');
  };

  const addChild = (dir: 'income' | 'expense', parentTempId: string) => {
    setEditDialog({ direction: dir, parentTempId, item: null });
    setEditName('');
  };

  const editItem = (dir: 'income' | 'expense', parentTempId: string | null, item: EditCatItem) => {
    setEditDialog({ direction: dir, parentTempId, item });
    setEditName(item.name);
  };

  const handleEditSave = () => {
    if (!editDialog) return;
    const name = editName.trim();
    if (!name || name.length > 30) {
      showToast('分类名称需在 1~30 字之间', 'error');
      return;
    }
    const { direction, parentTempId, item } = editDialog;
    const list = [...getList(direction)];

    if (parentTempId === null) {
      if (item) {
        const idx = list.findIndex(i => i.tempId === item.tempId);
        if (idx >= 0) list[idx] = { ...list[idx], name };
      } else {
        list.push({ tempId: nextId(), name, sortOrder: list.length, children: [] });
      }
    } else {
      const parent = list.find(i => i.tempId === parentTempId);
      if (parent) {
        if (item) {
          const idx = parent.children.findIndex(c => c.tempId === item.tempId);
          if (idx >= 0) parent.children[idx] = { ...parent.children[idx], name };
        } else {
          parent.children.push({ tempId: nextId(), name, sortOrder: parent.children.length, children: [] });
        }
      }
    }

    setList(direction, list);
    setEditDialog(null);
  };

  const handleDelete = () => {
    if (!confirmDelete) return;
    const { direction, parentTempId, tempId } = confirmDelete;
    const list = [...getList(direction)];

    if (parentTempId === null) {
      const idx = list.findIndex(i => i.tempId === tempId);
      if (idx >= 0) list.splice(idx, 1);
    } else {
      const parent = list.find(i => i.tempId === parentTempId);
      if (parent) {
        const idx = parent.children.findIndex(c => c.tempId === tempId);
        if (idx >= 0) parent.children.splice(idx, 1);
      }
    }

    setList(direction, list);
    setConfirmDelete(null);
  };

  const moveItem = (dir: 'income' | 'expense', parentTempId: string | null, tempId: string, delta: -1 | 1) => {
    const list = [...getList(dir)];
    if (parentTempId === null) {
      const idx = list.findIndex(i => i.tempId === tempId);
      const target = idx + delta;
      if (target < 0 || target >= list.length) return;
      [list[idx], list[target]] = [list[target], list[idx]];
    } else {
      const parent = list.find(i => i.tempId === parentTempId);
      if (!parent) return;
      const idx = parent.children.findIndex(c => c.tempId === tempId);
      const target = idx + delta;
      if (target < 0 || target >= parent.children.length) return;
      [parent.children[idx], parent.children[target]] = [parent.children[target], parent.children[idx]];
    }
    setList(dir, list);
  };

  const handleSave = async () => {
    const th = parseInt(threshold);
    if (!th || th < 0) {
      showToast('大额明细阈值需为正整数', 'error');
      return;
    }
    setSaving(true);
    try {
      const flatItems: { tempId: string; parentTempId: string | null; direction: 'income' | 'expense'; name: string; sortOrder: number }[] = [];
      const buildFlat = (list: EditCatItem[], direction: 'income' | 'expense') => {
        list.forEach((item, idx) => {
          flatItems.push({ tempId: item.tempId, parentTempId: null, direction, name: item.name, sortOrder: idx });
          item.children.forEach((child, cidx) => {
            flatItems.push({ tempId: child.tempId, parentTempId: item.tempId, direction, name: child.name, sortOrder: cidx });
          });
        });
      };
      buildFlat(income, 'income');
      buildFlat(expense, 'expense');

      await api('/api/cat-configs', {
        method: 'POST',
        body: { threshold: th, items: flatItems },
      });
      showToast('收支分类配置已保存为新版本', 'success');
      setDirty(false);
      await load();
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.message ?? '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner message="加载分类配置…" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">收支分类管理</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            {config && `当前版本 v${config.version}`}
            {config && ` · 配置 ID ${config.configId}`}
            {dirty && <span className="ml-2 text-amber-600">（有未保存的修改）</span>}
          </p>
        </div>
        <button
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存新版本'}
        </button>
      </div>

      {/* 阈值设置 */}
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <label className="flex items-center gap-3 text-sm text-slate-700">
          大额明细阈值（元）：单笔收入/支出超过此金额时，建议录入明细说明
          <input
            value={threshold}
            onChange={e => { setThreshold(e.target.value); setDirty(true); }}
            inputMode="numeric"
            className="w-24 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
          />
        </label>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* 收入分类 */}
        <CategorySection
          title="收入分类"
          items={income}
          direction="income"
          onAddTop={() => addTopLevel('income')}
          onAddChild={(pid) => addChild('income', pid)}
          onEdit={(pid, item) => editItem('income', pid, item)}
          onDelete={(pid, item) => setConfirmDelete({ direction: 'income', parentTempId: pid, tempId: item.tempId, name: item.name })}
          onMove={(pid, tid, d) => moveItem('income', pid, tid, d)}
        />

        {/* 支出分类 */}
        <CategorySection
          title="支出分类"
          items={expense}
          direction="expense"
          onAddTop={() => addTopLevel('expense')}
          onAddChild={(pid) => addChild('expense', pid)}
          onEdit={(pid, item) => editItem('expense', pid, item)}
          onDelete={(pid, item) => setConfirmDelete({ direction: 'expense', parentTempId: pid, tempId: item.tempId, name: item.name })}
          onMove={(pid, tid, d) => moveItem('expense', pid, tid, d)}
        />
      </div>

      {/* 编辑弹窗 */}
      {editDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-bold text-slate-900">
              {editDialog.item ? '编辑分类' : editDialog.parentTempId ? '新增二级分类' : '新增一级分类'}
            </h3>
            <div className="mb-4">
              <label className="mb-1 block text-xs text-slate-500">分类名称</label>
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                placeholder="如：工资收入、日常消费"
                maxLength={30}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleEditSave(); }}
              />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setEditDialog(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">取消</button>
              <button onClick={handleEditSave} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700">确定</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {confirmDelete && (
        <ConfirmDialog
          open={true}
          title="删除分类"
          message={`确定删除「${confirmDelete.name}」？删除后该分类下的历史数据不受影响，仅影响未来月份的录入选项。`}
          confirmText="删除"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function CategorySection(props: {
  title: string;
  items: EditCatItem[];
  direction: 'income' | 'expense';
  onAddTop: () => void;
  onAddChild: (parentTempId: string) => void;
  onEdit: (parentTempId: string | null, item: EditCatItem) => void;
  onDelete: (parentTempId: string | null, item: EditCatItem) => void;
  onMove: (parentTempId: string | null, tempId: string, delta: -1 | 1) => void;
}) {
  const { title, items, onAddTop, onAddChild, onEdit, onDelete, onMove } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setCollapsed(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <button onClick={onAddTop} className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
          <FolderPlus size={13} /> 新增一级分类
        </button>
      </div>
      <div className="p-3">
        {items.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">暂无分类，点击上方按钮添加</p>
        ) : (
          <div className="space-y-1">
            {items.map((item, idx) => (
              <div key={item.tempId}>
                <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
                  <button onClick={() => toggle(item.tempId)} className="text-slate-400 hover:text-slate-600">
                    {collapsed.has(item.tempId) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <span className="flex-1 text-sm font-medium text-slate-700">{item.name}</span>
                  <span className="text-[11px] text-slate-400">{item.children.length} 个子分类</span>
                  <button onClick={() => onAddChild(item.tempId)} className="rounded p-1 text-slate-400 hover:bg-white hover:text-blue-600" title="添加子分类">
                    <Plus size={13} />
                  </button>
                  <button onClick={() => onEdit(null, item)} className="rounded p-1 text-slate-400 hover:bg-white hover:text-blue-600" title="编辑">
                    <Edit2 size={13} />
                  </button>
                  <button onClick={() => onMove(null, item.tempId, -1)} disabled={idx === 0} className="rounded p-1 text-slate-400 hover:bg-white hover:text-blue-600 disabled:opacity-30" title="上移">
                    <ArrowUp size={13} />
                  </button>
                  <button onClick={() => onMove(null, item.tempId, 1)} disabled={idx === items.length - 1} className="rounded p-1 text-slate-400 hover:bg-white hover:text-blue-600 disabled:opacity-30" title="下移">
                    <ArrowDown size={13} />
                  </button>
                  <button onClick={() => onDelete(null, item)} className="rounded p-1 text-slate-400 hover:bg-white hover:text-red-500" title="删除">
                    <Trash2 size={13} />
                  </button>
                </div>
                {!collapsed.has(item.tempId) && item.children.length > 0 && (
                  <div className="ml-7 mt-1 space-y-1">
                    {item.children.map((child, cidx) => (
                      <div key={child.tempId} className="flex items-center gap-2 rounded-md border border-slate-100 px-3 py-1.5">
                        <span className="flex-1 text-sm text-slate-600">{child.name}</span>
                        <button onClick={() => onEdit(item.tempId, child)} className="rounded p-1 text-slate-400 hover:text-blue-600" title="编辑">
                          <Edit2 size={12} />
                        </button>
                        <button onClick={() => onMove(item.tempId, child.tempId, -1)} disabled={cidx === 0} className="rounded p-1 text-slate-400 hover:text-blue-600 disabled:opacity-30" title="上移">
                          <ArrowUp size={12} />
                        </button>
                        <button onClick={() => onMove(item.tempId, child.tempId, 1)} disabled={cidx === item.children.length - 1} className="rounded p-1 text-slate-400 hover:text-blue-600 disabled:opacity-30" title="下移">
                          <ArrowDown size={12} />
                        </button>
                        <button onClick={() => onDelete(item.tempId, child)} className="rounded p-1 text-slate-400 hover:text-red-500" title="删除">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
