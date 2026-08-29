/**
 * 仪表盘首页（UI-03）：管理员登录后的默认页面。
 *
 * 展示内容：
 *   - 四大核心指标卡片：净资产、总资产、总负债、月结余（含环比变化）
 *   - 近 6 个月净资产/总资产 SVG 迷你趋势图
 *   - 快捷操作入口（月末录入、负债管理、报表、AI 分析等）
 *   - 近期月度摘要表格（最近 6 个月的关键数据）
 *
 * 数据来源：GET /api/snapshots（全量月度汇总列表）
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, Wallet, PiggyBank, CreditCard, PencilLine, FileBarChart2, Landmark, ArrowRight, CalendarDays, Sparkles } from 'lucide-react';
import { TableScroll } from '@shared/core';
import { api } from '../lib/api';
import type { MonthSummary } from '../lib/types';

interface DashboardData {
  months: MonthSummary[];
  latestMonth: MonthSummary | null;
  prevMonth: MonthSummary | null;
}

/** 核心指标卡片组件：支持可选链接跳转、色调主题和副标题 */
function MetricCard({ icon, label, value, subValue, tone, to }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  tone: 'blue' | 'emerald' | 'orange' | 'purple' | 'red';
  to?: string;
}) {
  const toneClass: Record<string, { bg: string; text: string }> = {
    blue: { bg: 'bg-blue-50', text: 'text-blue-600' },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-600' },
    orange: { bg: 'bg-orange-50', text: 'text-orange-600' },
    purple: { bg: 'bg-purple-50', text: 'text-purple-600' },
    red: { bg: 'bg-red-50', text: 'text-red-600' },
  };
  const t = toneClass[tone];
  const content = (
    <div className="flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${t.bg} ${t.text}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs text-slate-500 mb-0.5">{label}</div>
        <div className="text-xl font-bold text-slate-900 truncate">{value}</div>
        {subValue && <div className="text-xs text-slate-400 mt-0.5">{subValue}</div>}
      </div>
    </div>
  );
  if (to) {
    return <Link to={to} className="card p-4 hover:shadow-md transition-shadow block">{content}</Link>;
  }
  return <div className="card p-4">{content}</div>;
}

/** 迷你趋势折线图（纯 SVG，无依赖）：自动归一化数据范围 */
function MiniTrendChart({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const h = 48;
  const w = 200;
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${h - ((v - min) / range) * (h - 8) - 4}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-12" preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}

/** 快捷操作入口卡片：带图标、标题和描述，hover 时显示箭头指引 */
function QuickAction({ icon, label, to, description }: { icon: React.ReactNode; label: string; to: string; description: string }) {
  return (
    <Link to={to} className="card p-4 hover:shadow-md transition-all hover:border-blue-200 group flex items-start gap-3">
      <div className="w-10 h-10 rounded-lg bg-slate-50 flex items-center justify-center text-slate-600 group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors flex-shrink-0">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-800 group-hover:text-blue-700 flex items-center gap-1">
          {label} <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        <div className="text-xs text-slate-500 mt-0.5">{description}</div>
      </div>
    </Link>
  );
}

/** 金额格式化：≥1万时显示为 x.xx万，否则千分位格式 */
function formatAmount(n: number): string {
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(2)}万`;
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 百分比格式化：带正负号前缀（如 +3.28%） */
function formatPercent(n: number | null): string {
  if (n === null || n === undefined) return '--';
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData>({ months: [], latestMonth: null, prevMonth: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api<{ range: string; months: MonthSummary[] }>('/api/snapshots');
        const months = res.months || [];
        const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
        const latestMonth = sorted.length > 0 ? sorted[sorted.length - 1] : null;
        const prevMonth = sorted.length > 1 ? sorted[sorted.length - 2] : null;
        setData({ months: sorted, latestMonth, prevMonth });
      } catch {
        setData({ months: [], latestMonth: null, prevMonth: null });
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const { latestMonth, prevMonth, months } = data;

  const netWorthChange = latestMonth && prevMonth
    ? latestMonth.netWorth - prevMonth.netWorth
    : null;
  const netWorthChangeRate = latestMonth && prevMonth && prevMonth.netWorth !== 0
    ? (latestMonth.netWorth - prevMonth.netWorth) / Math.abs(prevMonth.netWorth)
    : null;

  const netWorthTrend = months.slice(-6).map(m => m.netWorth);
  const assetTrend = months.slice(-6).map(m => m.totalAssets);

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const hasCurrentMonthData = months.some(m => m.month === currentMonth);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-slate-200 rounded w-48" />
        <div className="cq">
          <div className="cq-grid cq-cols-cards gap-4">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-24 bg-slate-100 rounded-xl" />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">资产概览</h1>
          <p className="text-sm text-slate-500 mt-1">
            {latestMonth ? `最新数据：${latestMonth.month}` : '暂无快照数据，请先录入月末数据'}
          </p>
        </div>
        {!hasCurrentMonthData && (
          <Link to="/entry" className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm">
            <PencilLine size={16} /> 录入本月数据
          </Link>
        )}
      </div>

      {/* 核心指标 */}
      {latestMonth ? (
        <>
          {/* 核心指标（容器查询流式网格：手机单列 → ≥30rem 两列 → ≥45rem 四列） */}
          <div className="cq">
            <div className="cq-grid cq-cols-cards gap-4">
            <MetricCard
              icon={<Wallet size={22} />}
              label="净资产"
              value={`¥${formatAmount(latestMonth.netWorth)}`}
              subValue={netWorthChange !== null ? `较上月 ${netWorthChange >= 0 ? '+' : ''}${formatAmount(netWorthChange)}` : undefined}
              tone={latestMonth.netWorth >= 0 ? 'emerald' : 'red'}
              to="/reports/assets"
            />
            <MetricCard
              icon={<PiggyBank size={22} />}
              label="总资产"
              value={`¥${formatAmount(latestMonth.totalAssets)}`}
              subValue={`${latestMonth.month}`}
              tone="blue"
              to="/reports/assets"
            />
            <MetricCard
              icon={<CreditCard size={22} />}
              label="总负债"
              value={`¥${formatAmount(latestMonth.totalDebt)}`}
              subValue={`负债率 ${(latestMonth.debtRatio * 100).toFixed(1)}%`}
              tone="orange"
              to="/debts"
            />
            <MetricCard
              icon={latestMonth.balance >= 0 ? <TrendingUp size={22} /> : <TrendingDown size={22} />}
              label="月结余"
              value={`¥${formatAmount(latestMonth.balance)}`}
              subValue={netWorthChangeRate !== null ? `净资产增速 ${formatPercent(netWorthChangeRate)}` : undefined}
              tone={latestMonth.balance >= 0 ? 'purple' : 'red'}
              to="/reports/finance"
            />
            </div>
          </div>

          {/* 趋势图 */}
          {months.length >= 2 && (
            <div className="cq">
              <div className="cq-grid cq-cols-2 gap-4">
                <div className="card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold text-slate-700">净资产趋势</h2>
                    <Link to="/reports/assets" className="text-xs text-blue-600 hover:underline">查看详情 →</Link>
                  </div>
                  <MiniTrendChart data={netWorthTrend} color="#10b981" />
                  <div className="flex justify-between text-[10px] text-slate-400 mt-1 px-0.5">
                    <span>{months[Math.max(0, months.length - 6)]?.month}</span>
                    <span>{months[months.length - 1]?.month}</span>
                  </div>
                </div>
                <div className="card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold text-slate-700">总资产趋势</h2>
                    <Link to="/reports/assets" className="text-xs text-blue-600 hover:underline">查看详情 →</Link>
                  </div>
                  <MiniTrendChart data={assetTrend} color="#3b82f6" />
                  <div className="flex justify-between text-[10px] text-slate-400 mt-1 px-0.5">
                    <span>{months[Math.max(0, months.length - 6)]?.month}</span>
                    <span>{months[months.length - 1]?.month}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="card p-8 flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-4">
            <CalendarDays size={28} className="text-blue-500" />
          </div>
          <h3 className="text-base font-semibold text-slate-800">还没有月度快照数据</h3>
          <p className="text-sm text-slate-500 mt-2 max-w-md">完成第一次月末录入后，资产概览、趋势图和分析数据将在这里展示</p>
          <Link to="/entry" className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
            <PencilLine size={16} /> 去录入第一笔数据
          </Link>
        </div>
      )}

      {/* 快捷入口 */}
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-3">快捷操作</h2>
        <div className="cq">
          <div className="cq-grid cq-cols-3 gap-3">
            <QuickAction icon={<PencilLine size={18} />} label="月末录入" to="/entry" description="录入本月资产余额与收支" />
            <QuickAction icon={<Landmark size={18} />} label="负债管理" to="/debts" description="管理房贷、信用卡等负债" />
            <QuickAction icon={<FileBarChart2 size={18} />} label="资产报表" to="/reports/assets" description="查看资产配置与增长分析" />
            <QuickAction icon={<Sparkles size={18} />} label="AI 分析" to="/ai" description="AI 生成资产配置建议" />
            <QuickAction icon={<CalendarDays size={18} />} label="报告快照" to="/reports/snapshots" description="季度/年度报告汇总" />
            <QuickAction icon={<Wallet size={18} />} label="备份恢复" to="/settings/backup" description="云端备份与本地导出" />
          </div>
        </div>
      </div>

      {/* 月度摘要表 */}
      {months.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700">近期月度摘要</h2>
            <Link to="/reports/snapshots" className="text-xs text-blue-600 hover:underline">全部快照 →</Link>
          </div>
          <TableScroll label="近期月度摘要">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-xs">
                  <th className="px-4 py-2.5 text-left font-medium">月份</th>
                  <th className="px-4 py-2.5 text-right font-medium">总资产</th>
                  <th className="px-4 py-2.5 text-right font-medium">净资产</th>
                  <th className="px-4 py-2.5 text-right font-medium">结余</th>
                  <th className="px-4 py-2.5 text-right font-medium">负债率</th>
                </tr>
              </thead>
              <tbody>
                {months.slice(-6).reverse().map(m => (
                  <tr key={m.month} className="border-t border-slate-50 hover:bg-slate-50/50">
                    <td className="px-4 py-2.5 font-medium text-slate-700">{m.month}</td>
                    <td className="px-4 py-2.5 text-right text-slate-600">¥{formatAmount(m.totalAssets)}</td>
                    <td className={`px-4 py-2.5 text-right font-medium ${m.netWorth >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      ¥{formatAmount(m.netWorth)}
                    </td>
                    <td className={`px-4 py-2.5 text-right ${m.balance >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {m.balance >= 0 ? '+' : ''}{formatAmount(m.balance)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-500">{(m.debtRatio * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </div>
      )}
    </div>
  );
}
