/**
 * ⚙ 收支分类配置弹窗（F-02b 规则 4 / 05 §3.17）：
 * 一/二级分类增删改、排序与阈值修改；整体提交 → 版本递增（仅影响未来月份）。
 * 条目编辑以 tempId/parentTempId 组织（与契约一致）。
 */
import { useState } from 'react';
import { useToast } from '@shared/core/hooks/useToast';
import { api, ApiError } from '../../lib/api';
import type { CatConfig } from '../../lib/types';
import { isValidName } from '../../lib/validate';

interface EditItem {
  tempId: string;
  parentTempId: string | null;
  direction: 'income' | 'expense';
  name: string;
  sortOrder: number;
}

let seq = 0;
const nextId = () => `c${Date.now().toString(36)}-${++seq}`;

export function CatConfigDialog({ config, onClose, onSaved }: { config: CatConfig; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useToast();
  const [threshold, setThreshold] = useState(String(config.threshold));
  const [items, setItems] = useState<EditItem[]>(() => {
    const out: EditItem[] = [];
    for (const dir of ['income', 'expense'] as const) {
      for (const top of config[dir]) {
        const t = nextId();
        out.push({ tempId: t, parentTempId: null, direction: dir, name: top.name, sortOrder: top.sortOrder });
        for (const kid of top.children ?? []) {
          out.push({ tempId: nextId(), parentTempId: t, direction: dir, name: kid.name, sortOrder: kid.sortOrder });
        }
      }
    }
    return out;
  });
  const [saving, setSaving] = useState(false);

  const topsOf = (dir: 'income' | 'expense') =>
    items.filter((i) => i.direction === dir && i.parentTempId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  const kidsOf = (tempId: string) => items.filter((i) => i.parentTempId === tempId).sort((a, b) => a.sortOrder - b.sortOrder);

  const patch = (tempId: string, p: Partial<EditItem>) => setItems((list) => list.map((i) => (i.tempId === tempId ? { ...i, ...p } : i)));
  const remove = (tempId: string) => setItems((list) => list.filter((i) => i.tempId !== tempId && i.parentTempId !== tempId));
  const addTop = (dir: 'income' | 'expense') =>
    setItems((l) => [...l, { tempId: nextId(), parentTempId: null, direction: dir, name: '', sortOrder: topsOf(dir).length }]);
  const addKid = (parentTempId: string, dir: 'income' | 'expense') =>
    setItems((l) => [...l, { tempId: nextId(), parentTempId, direction: dir, name: '', sortOrder: kidsOf(parentTempId).length }]);
  const move = (tempId: string, delta: -1 | 1) => {
    setItems((list) => {
      const item = list.find((i) => i.tempId === tempId);
      if (!item) return list;
      const siblings = list
        .filter((i) => i.direction === item.direction && i.parentTempId === item.parentTempId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const idx = siblings.findIndex((s) => s.tempId === tempId);
      const swap = siblings[idx + delta];
      if (!swap) return list;
      return list.map((i) => {
        if (i.tempId === item.tempId) return { ...i, sortOrder: swap.sortOrder };
        if (i.tempId === swap.tempId) return { ...i, sortOrder: item.sortOrder };
        return i;
      });
    });
  };

  const submit = async () => {
    const thr = Number(threshold);
    if (!Number.isFinite(thr) || thr <= 0) {
      showToast('阈值须为正数', 'error');
      return;
    }
    for (const i of items) {
      if (!isValidName(i.name, 20)) {
        showToast('分类名须为 1~20 字符', 'error');
        return;
      }
    }
    if (topsOf('income').length === 0 || topsOf('expense').length === 0) {
      showToast('收入与支出各至少保留一个一级分类', 'error');
      return;
    }
    setSaving(true);
    try {
      await api('/api/cat-configs', {
        method: 'POST',
        body: {
          threshold: thr,
          items: items.map(({ tempId, parentTempId, direction, name, sortOrder }) => ({
            tempId,
            parentTempId,
            direction,
            name: name.trim(),
            sortOrder,
          })),
        },
      });
      onSaved();
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.details?.map((d) => d.message).join('；') ?? ae.message ?? '保存失败', 'error', 6000);
    } finally {
      setSaving(false);
    }
  };

  const renderDirection = (dir: 'income' | 'expense') => (
    <div className="flex-1">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-500">{dir === 'income' ? '收入分类' : '支出分类'}</span>
        <button onClick={() => addTop(dir)} className="text-xs text-blue-600 hover:underline">
          ＋一级
        </button>
      </div>
      {topsOf(dir).map((t) => (
        <div key={t.tempId} className="mb-1 rounded border border-slate-100 p-1.5">
          <div className="flex items-center gap-1">
            <input
              value={t.name}
              onChange={(e) => patch(t.tempId, { name: e.target.value })}
              maxLength={20}
              className="min-w-0 flex-1 rounded border border-slate-200 px-1.5 py-0.5 text-xs outline-none focus:border-blue-400"
            />
            <MiniBtn onClick={() => move(t.tempId, -1)}>↑</MiniBtn>
            <MiniBtn onClick={() => move(t.tempId, 1)}>↓</MiniBtn>
            <MiniBtn onClick={() => addKid(t.tempId, dir)}>＋</MiniBtn>
            <MiniBtn danger onClick={() => remove(t.tempId)}>✕</MiniBtn>
          </div>
          {kidsOf(t.tempId).map((k) => (
            <div key={k.tempId} className="mt-1 flex items-center gap-1 pl-4">
              <input
                value={k.name}
                onChange={(e) => patch(k.tempId, { name: e.target.value })}
                maxLength={20}
                className="min-w-0 flex-1 rounded border border-slate-200 px-1.5 py-0.5 text-xs outline-none focus:border-blue-400"
              />
              <MiniBtn onClick={() => move(k.tempId, -1)}>↑</MiniBtn>
              <MiniBtn onClick={() => move(k.tempId, 1)}>↓</MiniBtn>
              <MiniBtn danger onClick={() => remove(k.tempId)}>✕</MiniBtn>
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !saving && onClose()} />
      <div className="animate-in zoom-in-95 relative max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-6 shadow-2xl duration-200">
        <h3 className="mb-1 font-semibold text-slate-900">⚙ 收支分类配置（当前 catV{config.version}）</h3>
        <p className="mb-4 text-xs text-slate-400">保存后版本号递增，仅影响未来月份；历史月份保留当时分类（F-02b 规则 4/5）。</p>
        <div className="mb-4 flex items-center gap-2 text-sm">
          <label className="text-slate-600">大额明细阈值（元）</label>
          <input
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            inputMode="decimal"
            className="w-28 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex flex-col gap-4 sm:flex-row">
          {renderDirection('income')}
          {renderDirection('expense')}
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} disabled={saving} className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 hover:bg-slate-200">
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={saving}
            className="btn-primary"
          >
            {saving ? '保存中…' : '保存新版本'}
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniBtn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-1 py-0.5 text-[10px] ${danger ? 'text-slate-300 hover:bg-red-50 hover:text-red-500' : 'text-slate-400 hover:bg-slate-100'}`}
    >
      {children}
    </button>
  );
}
