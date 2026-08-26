/**
 * 历史纠错弹窗（UI-05 / F-06 / 05 §3.22）：
 * 更正前后对比表 + 勾选确认项，未勾选不放行（前端拦截 + 服务端 confirmed 兜底）。
 */
import { useMemo, useState } from 'react';
import { fmtMoney, fmtMonth } from '../../lib/format';
import type { CatConfig, Debt, SnapshotDetail, TreeConfig } from '../../lib/types';
import { parseAmount } from '../../lib/validate';

/** 录入页表单形态（结构化子集，避免与页面循环依赖） */
interface FormLike {
  assets: Record<number, { balance: string; hasNewFunds: boolean; updateSource: string }>;
  gains: Record<number, string>;
  income: Record<number, string>;
  expense: Record<number, string>;
  debts: Record<number, { balance: string; repayment: string }>;
}

export function CorrectDialog({
  month,
  before,
  after,
  tree,
  catConfig,
  debts,
  onCancel,
  onConfirm,
  saving,
}: {
  month: string;
  before: SnapshotDetail;
  after: FormLike;
  tree: TreeConfig;
  catConfig: CatConfig | null;
  debts: Debt[];
  onCancel: () => void;
  onConfirm: () => void;
  saving: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);

  const nodeName = (id: number) => tree.nodes.find((n) => n.id === id)?.name ?? `节点#${id}`;
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

  const diffs = useMemo(() => {
    const rows: { field: string; before: string; after: string }[] = [];
    for (const a of before.assets ?? []) {
      const cur = after.assets[a.nodeId];
      const curBal = parseAmount(cur?.balance ?? '') ?? 0;
      if (curBal !== a.balance) rows.push({ field: `资产 · ${nodeName(a.nodeId)} · 余额`, before: fmtMoney(a.balance), after: fmtMoney(curBal) });
      if (!!cur?.hasNewFunds !== a.hasNewFunds) {
        rows.push({ field: `资产 · ${nodeName(a.nodeId)} · 新增资金`, before: a.hasNewFunds ? '有' : '无', after: cur?.hasNewFunds ? '有' : '无' });
      }
      if ((cur?.updateSource ?? 'current') !== a.updateSource) {
        rows.push({
          field: `资产 · ${nodeName(a.nodeId)} · 更新状态`,
          before: a.updateSource === 'carried' ? '沿用上期' : '本期更新',
          after: cur?.updateSource === 'carried' ? '沿用上期' : '本期更新',
        });
      }
    }
    for (const g of before.moduleGains ?? []) {
      const curRaw = after.gains[g.nodeId] ?? '';
      const curVal = parseAmount(curRaw);
      const b = g.gain === null ? '留空' : fmtMoney(g.gain);
      const af = curVal === null ? '留空' : fmtMoney(curVal);
      if (b !== af) rows.push({ field: `收益金额 · ${nodeName(g.nodeId)}`, before: b, after: af });
    }
    for (const c of before.income ?? []) {
      const curVal = parseAmount(after.income[c.catItemId] ?? '') ?? 0;
      if (curVal !== c.amount) rows.push({ field: `收入 · ${catName(c.catItemId)}`, before: fmtMoney(c.amount), after: fmtMoney(curVal) });
    }
    for (const c of before.expense ?? []) {
      const curVal = parseAmount(after.expense[c.catItemId] ?? '') ?? 0;
      if (curVal !== c.amount) rows.push({ field: `支出 · ${catName(c.catItemId)}`, before: fmtMoney(c.amount), after: fmtMoney(curVal) });
    }
    for (const d of before.debts ?? []) {
      const cur = after.debts[d.debtId];
      const curBal = parseAmount(cur?.balance ?? '') ?? 0;
      if (curBal !== d.balance) rows.push({ field: `负债 · ${debtName(d.debtId)} · 余额`, before: fmtMoney(d.balance), after: fmtMoney(curBal) });
      if (!d.fixedRepayment) {
        const curRep = parseAmount(cur?.repayment ?? '') ?? 0;
        if (curRep !== d.repayment) rows.push({ field: `负债 · ${debtName(d.debtId)} · 还款`, before: fmtMoney(d.repayment), after: fmtMoney(curRep) });
      }
    }
    if (rows.length === 0) rows.push({ field: '（无字段变更）', before: '—', after: '—' });
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [before, after, tree, catConfig, debts]);

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !saving && onCancel()} />
      <div className="animate-in zoom-in-95 relative w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl duration-200">
        <h3 className="mb-1 font-semibold text-slate-900">历史纠错 · 二次确认（{fmtMonth(month)}）</h3>
        <p className="mb-3 text-xs text-slate-400">请核对更正前后差异；确认后写入纠错日志（更正时间留痕），其他月份不受影响。</p>
        <div className="mb-4 max-h-64 overflow-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-slate-500">字段</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">更正前</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">更正后</th>
              </tr>
            </thead>
            <tbody>
              {diffs.map((d, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-600">{d.field}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-400">{d.before}</td>
                  <td className="px-3 py-1.5 text-right font-medium tabular-nums text-blue-700">{d.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <label className="mb-4 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="accent-blue-600" />
          我已核对以上更正内容，确认提交纠错
        </label>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} disabled={saving} className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 hover:bg-slate-200">
            取消
          </button>
          <button
            onClick={() => confirmed && onConfirm()}
            disabled={!confirmed || saving}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? '提交中…' : '确认纠错'}
          </button>
        </div>
      </div>
    </div>
  );
}
