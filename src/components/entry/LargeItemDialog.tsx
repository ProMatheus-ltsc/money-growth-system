/**
 * 大额单笔明细弹窗（F-02b 规则 2 / 决策 D9）：名称/金额/所属二级分类；< 阈值拒绝。
 */
import { useState } from 'react';
import { useToast } from '@shared/core/hooks/useToast';
import type { CatConfig } from '../../lib/types';
import { parseAmount } from '../../lib/validate';
import type { LargeItemDraft } from '../../context/EntryDraftContext';

export function LargeItemDialog({
  direction,
  defaultCatItemId,
  catConfig,
  onClose,
  onAdd,
}: {
  direction: 'income' | 'expense';
  defaultCatItemId: number;
  catConfig: CatConfig;
  onClose: () => void;
  onAdd: (item: LargeItemDraft) => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [catItemId, setCatItemId] = useState(defaultCatItemId);
  const tops = direction === 'income' ? catConfig.income : catConfig.expense;
  const leaves = tops.flatMap((t) => (t.children ?? []).map((c) => ({ ...c, topName: t.name })));

  const submit = () => {
    const n = name.trim();
    if (n.length < 1 || n.length > 50) {
      showToast('明细名称须为 1~50 字符', 'error');
      return;
    }
    const amt = parseAmount(amount);
    if (amt === null || amt < 0) {
      showToast('金额须为非负数', 'error');
      return;
    }
    if (amt < catConfig.threshold) {
      showToast(`单笔金额 ${amt} 元低于阈值 ${catConfig.threshold} 元，不予记录（F-02b 规则 2）`, 'error');
      return;
    }
    onAdd({ direction, catItemId, name: n, amount: String(amt) });
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-in zoom-in-95 relative w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl duration-200">
        <h3 className="mb-3 font-semibold text-slate-900">
          添加大额明细（{direction === 'income' ? '收入' : '支出'}，≥{catConfig.threshold} 元）
        </h3>
        <div className="mb-3">
          <label className="mb-1 block text-xs text-slate-500">名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={50}
            placeholder="如：扫地机器人"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </div>
        <div className="mb-3">
          <label className="mb-1 block text-xs text-slate-500">金额（元）</label>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder={`≥ ${catConfig.threshold}`}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </div>
        <div className="mb-4">
          <label className="mb-1 block text-xs text-slate-500">所属二级分类</label>
          <select
            value={catItemId}
            onChange={(e) => setCatItemId(Number(e.target.value))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          >
            {leaves.map((l) => (
              <option key={l.id} value={l.id}>
                {l.topName} &gt; {l.name}
              </option>
            ))}
          </select>
        </div>
        <p className="mb-4 text-[11px] text-slate-400">大额明细为备注性质，不并入二级分类合计（决策 D9）。</p>
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 hover:bg-slate-200">
            取消
          </button>
          <button onClick={submit} className="btn-primary">
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
