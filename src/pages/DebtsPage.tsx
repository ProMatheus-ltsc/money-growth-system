/**
 * 负债管理页（UI-08 / F-02c，06 T20）：
 * - KPI 四卡：总负债 / 负债率（附口径提示，决策 D2）/ 月还款合计（固定定额 + 非固定实录）/ 净资产
 * - 列表：还款方式标识列（固定定额徽标 / 非固定实录）、列表内编辑余额与本月实际还款
 * - 表单弹窗：新增/编辑 + 「固定还款」开关（默认固定，文案随动，CHG-02 改动二）
 * - 删除二次确认（有历史快照 → 409 提示改用停用）；启停
 * - 趋势：总负债 / 负债率两个独立小倍数折线图（禁双轴，02 §7.9）
 * 注：已入快照月份的余额/还款修改经「整月快照回写」（服务端权威校验，同月覆盖语义）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@shared/core/hooks/useToast';
import { ConfirmDialog } from '@shared/core/components/ConfirmDialog';
import { LoadingSpinner } from '@shared/core/components/LoadingSpinner';
import OptionalFieldsGroup from '@shared/core/components/form/OptionalFieldsGroup';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { compareMonth, currentMonth, fmtMoney, fmtRate } from '../lib/format';
import type { Debt, DebtTotals, DebtTerm, DebtType, SnapshotDetail, SnapshotsListData } from '../lib/types';
import { isValidAmount, isValidName } from '../lib/validate';
import { KpiCard } from '../components/common/KpiCard';
import { MonthPicker } from '../components/common/MonthPicker';
import { UnitSwitch } from '../components/common/UnitSwitch';
import { useUi } from '../context/UiContext';
import { ChartMiniLine } from '../components/charts/ChartMiniLine';

const DEBT_TYPE_LABEL: Record<DebtType, string> = { mortgage: '房贷', auto_loan: '车贷', credit_card: '信用卡', other: '其他' };

interface DebtFormState {
  id: number | null;
  name: string;
  debtType: DebtType;
  term: DebtTerm;
  balance: string;
  annualRate: string; // 百分比输入
  monthlyPayment: string;
  fixedRepayment: boolean;
  enabled: boolean;
}

const emptyDebtForm = (): DebtFormState => ({
  id: null,
  name: '',
  debtType: 'mortgage',
  term: 'long',
  balance: '',
  annualRate: '',
  monthlyPayment: '',
  fixedRepayment: true,
  enabled: true,
});

export default function DebtsPage() {
  const { showToast } = useToast();
  const { unit } = useUi();
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<{ debts: Debt[]; totals: DebtTotals } | null>(null);
  const [snapMonths, setSnapMonths] = useState<string[]>([]);
  const [trend, setTrend] = useState<SnapshotsListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<DebtFormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Debt | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [debtsRes, listRes] = await Promise.all([
        api<{ debts: Debt[]; totals: DebtTotals }>('/api/debts', { query: { month } }),
        api<SnapshotsListData>('/api/snapshots', { query: { range: 'all' } }),
      ]);
      setData(debtsRes);
      setSnapMonths(listRes.months.map((m) => m.month));
      setTrend(listRes);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [month, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasSnapshot = snapMonths.includes(month);
  const isCurrentEditable = hasSnapshot && compareMonth(month, currentMonth()) === 0;

  // ---------- 列表内编辑 ----------
  const commitMasterBalance = async (debt: Debt, val: number) => {
    setBusyId(debt.id);
    try {
      await api(`/api/debts/${debt.id}`, { method: 'PUT', body: { balance: val } });
      showToast(`「${debt.name}」当前余额已更新`, 'success');
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '更新失败', 'error');
    } finally {
      setBusyId(null);
    }
  };

  /** 当月快照内编辑（余额/非固定还款）：回读整月快照 → 局部替换 → PUT（服务端权威校验） */
  const commitSnapshotDebt = async (debt: Debt, patch: { balance?: number; repayment?: number }) => {
    setBusyId(debt.id);
    try {
      const snap = await api<SnapshotDetail>(`/api/snapshots/${month}`);
      if (!snap.exists || snap.locked) {
        showToast('该月份快照不可修改', 'warning');
        return;
      }
      const payload = {
        treeConfigId: snap.treeConfigId,
        catConfigId: snap.catConfigId,
        assets: snap.assets,
        moduleGains: snap.moduleGains,
        income: snap.income,
        expense: snap.expense,
        largeItems: (snap.largeItems ?? []).map(({ id: _id, ...rest }) => rest),
        debts: (snap.debts ?? []).map((d) =>
          d.debtId === debt.id
            ? { debtId: d.debtId, balance: patch.balance ?? d.balance, repayment: d.fixedRepayment ? null : patch.repayment ?? d.repayment }
            : { debtId: d.debtId, balance: d.balance, repayment: d.fixedRepayment ? null : d.repayment }
        ),
      };
      await api(`/api/snapshots/${month}`, { method: 'PUT', body: payload });
      showToast(`「${debt.name}」已更新（${month} 快照）`, 'success');
      await load();
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.details?.map((d) => d.message).join('；') ?? ae.message ?? '更新失败', 'error', 6000);
    } finally {
      setBusyId(null);
    }
  };

  // ---------- 表单弹窗 ----------
  const openCreate = () => setDialog(emptyDebtForm());
  const openEdit = (d: Debt) =>
    setDialog({
      id: d.id,
      name: d.name,
      debtType: d.debtType,
      term: d.term,
      balance: String(d.monthBalance),
      annualRate: String(d.annualRate * 100),
      monthlyPayment: String(d.monthlyPayment),
      fixedRepayment: d.fixedRepayment,
      enabled: d.enabled,
    });

  const submitForm = async () => {
    if (!dialog) return;
    if (!isValidName(dialog.name, 30)) return showToast('名称须为 1~30 字符', 'error');
    if (!isValidAmount(dialog.balance)) return showToast('当前余额须为非负数', 'error');
    const rate = Number(dialog.annualRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return showToast('年利率须为 0~100（%）', 'error');
    if (dialog.fixedRepayment && !isValidAmount(dialog.monthlyPayment)) return showToast('固定还款时月还款额须为非负数', 'error');
    const body = {
      name: dialog.name.trim(),
      debtType: dialog.debtType,
      term: dialog.term,
      balance: Number(dialog.balance),
      annualRate: rate / 100,
      monthlyPayment: dialog.fixedRepayment ? Number(dialog.monthlyPayment) : (dialog.monthlyPayment.trim() ? Number(dialog.monthlyPayment) : 0),
      fixedRepayment: dialog.fixedRepayment,
      enabled: dialog.enabled,
    };
    try {
      if (dialog.id === null) {
        await api('/api/debts', { method: 'POST', body });
        showToast(`已添加负债「${body.name}」`, 'success');
      } else {
        await api(`/api/debts/${dialog.id}`, { method: 'PUT', body });
        showToast(`已保存「${body.name}」`, 'success');
      }
      setDialog(null);
      await load();
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.details?.map((d) => d.message).join('；') ?? ae.message ?? '保存失败', 'error', 6000);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    try {
      await api(`/api/debts/${confirmDelete.id}`, { method: 'DELETE' });
      showToast(`已删除「${confirmDelete.name}」`, 'success');
      setConfirmDelete(null);
      await load();
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.message ?? '删除失败', 'error', 5000);
      setConfirmDelete(null);
    }
  };

  const toggleEnabled = async (d: Debt) => {
    try {
      await api(`/api/debts/${d.id}`, { method: 'PUT', body: { enabled: !d.enabled } });
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败', 'error');
    }
  };

  // ---------- 渲染 ----------
  if (loading && !data) return <LoadingSpinner message="加载负债…" />;
  const totals = data?.totals ?? null;
  const months = trend?.months ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">负债管理</h2>
          <p className="mt-0.5 text-xs text-slate-400">固定还款每月自动按定额计入，非固定还款需每月手动录入实际还款额</p>
        </div>
        <div className="flex items-center gap-2">
          <MonthPicker months={snapMonths.length > 0 ? snapMonths : [month]} value={month} onChange={setMonth} />
          <UnitSwitch />
          <button onClick={openCreate} className="btn-primary py-1.5">
            <Plus size={14} /> 新增负债
          </button>
        </div>
      </div>

      {/* KPI 四卡 */}
      {totals && (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard label="总负债" value={fmtMoney(totals.totalDebt, unit)} hint={`短期 ${fmtMoney(totals.shortTermDebt, unit)} / 长期 ${fmtMoney(totals.longTermDebt, unit)}`} />
          <KpiCard
            label="负债率（总负债/总资产）"
            value={totals.debtRatio === null ? '—' : fmtRate(totals.debtRatio, 4)}
            hint="唯一住房资产价值未计入资产，房贷负债计入"
            negative={totals.debtRatio !== null && totals.debtRatio > 1}
          />
          <KpiCard label={`月还款合计（${month}）`} value={fmtMoney(totals.monthlyRepayment, unit)} hint="固定按定额 + 非固定按当月实录" />
          <KpiCard
            label="净资产"
            value={totals.netWorth === null ? '—' : fmtMoney(totals.netWorth, unit)}
            hint="净资产 = 总资产 − 总负债"
            negative={totals.netWorth !== null && totals.netWorth < 0}
          />
        </div>
      )}

      {/* 列表 */}
      <div className="overflow-x-auto card !p-0">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-xs text-slate-500">
              <th className="px-4 py-3 font-medium">名称</th>
              <th className="px-4 py-3 font-medium">类型 / 期限</th>
              <th className="px-4 py-3 font-medium">还款方式</th>
              <th className="px-4 py-3 text-right font-medium">年利率</th>
              <th className="px-4 py-3 text-right font-medium">余额（{month}）</th>
              <th className="px-4 py-3 text-right font-medium">本月还款</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {(data?.debts ?? []).map((d, idx) => (
              <tr key={d.id} className={`border-b border-slate-50 last:border-0 transition-colors hover:bg-slate-50/60 ${idx % 2 === 1 ? 'bg-slate-25' : ''} ${!d.enabled ? 'opacity-50' : ''}`}>
                <td className="px-4 py-3 font-medium text-slate-800">{d.name}</td>
                <td className="px-4 py-3 text-xs text-slate-500">
                  {DEBT_TYPE_LABEL[d.debtType]} · {d.term === 'short' ? '短期(<1年)' : '长期(≥1年)'}
                </td>
                <td className="px-4 py-3">
                  {d.fixedRepayment ? (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">固定</span>
                  ) : (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-600">非固定</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtRate(d.annualRate)}</td>
                <td className="px-4 py-3 text-right">
                  <InlineAmount
                    key={`bal-${d.id}-${month}-${d.monthBalance}`}
                    value={d.monthBalance}
                    disabled={busyId === d.id || (!isCurrentEditable && hasSnapshot)}
                    onCommit={(v) => (hasSnapshot && isCurrentEditable ? commitSnapshotDebt(d, { balance: v }) : commitMasterBalance(d, v))}
                    hint={hasSnapshot && !isCurrentEditable ? '已入快照月份不可改' : hasSnapshot ? '修改将更新当月快照' : '修改主档当前余额'}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  {d.fixedRepayment ? (
                    <span className="rounded bg-blue-50 px-2 py-0.5 text-xs tabular-nums text-blue-600" title="固定还款按定额自动套用，不需每月填写">
                      定额 {fmtMoney(d.monthlyPayment, unit)}
                    </span>
                  ) : d.monthRepayment === null ? (
                    <span className="text-xs text-slate-300">无快照记录</span>
                  ) : (
                    <InlineAmount
                      key={`rep-${d.id}-${month}-${d.monthRepayment}`}
                      value={d.monthRepayment}
                      disabled={busyId === d.id || !isCurrentEditable}
                      onCommit={(v) => commitSnapshotDebt(d, { repayment: v })}
                      hint={isCurrentEditable ? '本月实际还款（非负）' : '仅当前月快照可修改实录还款'}
                    />
                  )}
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => void toggleEnabled(d)} className={`rounded-full px-2 py-0.5 text-[11px] ${d.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                    {d.enabled ? '启用' : '停用'}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => openEdit(d)} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="编辑">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => setConfirmDelete(d)} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500" title="删除">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {(data?.debts ?? []).length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-slate-400">
                  暂无负债项，点击「新增负债」添加（如房贷/信用卡）
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 趋势：两个独立小倍数图（禁双轴） */}
      {months.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <ChartMiniLine title="总负债趋势" months={months.map((m) => m.month)} values={months.map((m) => m.totalDebt)} kind="money" unit={unit} color="#4a3aa7" />
          <ChartMiniLine title="负债率趋势" months={months.map((m) => m.month)} values={months.map((m) => m.debtRatio)} kind="rate" color="#eb6834" />
        </div>
      )}

      {/* 表单弹窗 */}
      {dialog && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setDialog(null)} />
          <div className="animate-in zoom-in-95 relative max-h-[85vh] w-full max-w-md overflow-auto rounded-xl bg-white p-6 shadow-2xl duration-200">
            <h3 className="mb-4 font-semibold text-slate-900">{dialog.id === null ? '新增负债' : '编辑负债'}</h3>
            <div className="mb-3">
              <label className="mb-1 block text-xs text-slate-500">名称</label>
              <input value={dialog.name} onChange={(e) => setDialog({ ...dialog, name: e.target.value })} maxLength={30} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="如：首套房贷" />
            </div>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500">类型</label>
                <select value={dialog.debtType} onChange={(e) => setDialog({ ...dialog, debtType: e.target.value as DebtType })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
                  {Object.entries(DEBT_TYPE_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">期限</label>
                <select value={dialog.term} onChange={(e) => setDialog({ ...dialog, term: e.target.value as DebtTerm })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
                  <option value="short">短期（&lt;1年）</option>
                  <option value="long">长期（≥1年）</option>
                </select>
              </div>
            </div>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500">当前余额（元）</label>
                <input value={dialog.balance} onChange={(e) => setDialog({ ...dialog, balance: e.target.value })} inputMode="decimal" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">年利率（%）</label>
                <input value={dialog.annualRate} onChange={(e) => setDialog({ ...dialog, annualRate: e.target.value })} inputMode="decimal" placeholder="如 3.6" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
            </div>
            {/* 固定还款开关 */}
            <div className="mb-3 rounded-lg border border-slate-200 p-3">
              <label className="flex items-center justify-between">
                <span className="text-sm text-slate-700">固定还款</span>
                <input type="checkbox" checked={dialog.fixedRepayment} onChange={(e) => setDialog({ ...dialog, fixedRepayment: e.target.checked })} className="h-4 w-4 accent-blue-600" />
              </label>
              <p className="mt-1 text-xs text-slate-400">
                {dialog.fixedRepayment
                  ? '每月按定额自动计入还款，无需手动录入。'
                  : '非固定还款需每月在录入页填写实际还款金额。'}
              </p>
            </div>
            {dialog.fixedRepayment && (
              <div className="mb-3">
                <label className="mb-1 block text-xs text-slate-500">月还款额（元，固定还款的定额）</label>
                <input value={dialog.monthlyPayment} onChange={(e) => setDialog({ ...dialog, monthlyPayment: e.target.value })} inputMode="decimal" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
            )}

            {dialog.id !== null && (
              <OptionalFieldsGroup count={1}>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={dialog.enabled} onChange={(e) => setDialog({ ...dialog, enabled: e.target.checked })} className="accent-blue-600" />
                  启用该负债（停用后不参与合计与录入）
                </label>
              </OptionalFieldsGroup>
            )}

            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setDialog(null)} className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 hover:bg-slate-200">取消</button>
              <button onClick={() => void submitForm()} className="btn-primary">保存</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="删除负债"
        message={confirmDelete ? `确定删除「${confirmDelete.name}」吗？若存在历史快照记录将被拒绝，可改用停用。` : ''}
        confirmText="删除"
        variant="danger"
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

// ---------- 行内金额编辑 ----------
function InlineAmount({ value, disabled, onCommit, hint }: { value: number; disabled?: boolean; onCommit: (v: number) => void; hint?: string }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(String(value));
  useEffect(() => setRaw(String(value)), [value]);
  if (!editing) {
    return (
      <button
        disabled={disabled}
        onClick={() => setEditing(true)}
        title={disabled ? hint : `${hint ?? ''}（点击编辑）`}
        className="rounded px-1 py-0.5 tabular-nums text-slate-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        {fmtMoney(value)}
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (isValidAmount(raw) && Number(raw) !== value) onCommit(Number(raw));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setRaw(String(value));
          setEditing(false);
        }
      }}
      inputMode="decimal"
      className="w-28 rounded border border-blue-300 px-1 py-0.5 text-right text-sm tabular-nums outline-none"
      aria-label="金额编辑"
    />
  );
}
