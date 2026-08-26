/**
 * 仪表盘统计卡片：展示单个指标的标签、数值与可选提示。
 * 提取自 root-cause-analysis 项目（公共统计组件，纯展示，直接复用）。
 */
interface StatCardProps {
  /** 指标名称（如"待分析"） */
  label: string;
  /** 指标数值 */
  value: number | string;
  /** 可选补充说明，显示在数值下方 */
  hint?: string;
  /** 数值的额外配色 class（如已完成用 emerald 绿色），缺省为深灰 */
  accentClassName?: string;
}

/**
 * 统计卡片组件。
 * @param label 指标名称
 * @param value 指标数值
 * @param hint 补充说明（可选）
 * @param accentClassName 数值文字配色（可选）
 */
export function StatCard({ label, value, hint, accentClassName }: StatCardProps) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${accentClassName ?? 'text-slate-900'}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
