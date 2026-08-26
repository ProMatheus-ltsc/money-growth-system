/**
 * CPA 财务健康仪表盘页面：
 * - 综合健康评分（0-100）+ 状态指示
 * - 五大核心比率卡片（储蓄率、偿债比率、流动性覆盖、净资产增速、负债率）
 * - 资产集中度预警表格
 * - 流动性结构饼图
 * - 投资回报率对标（名义 vs 实际）
 * - 或有负债摘要
 * - 公允价值重估历史
 */
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, ArrowDown, ArrowUp, BarChart3, PieChart, Shield, TrendingUp } from 'lucide-react';
import { api } from '../lib/api';
import { LoadingSpinner } from '@shared/core/components/LoadingSpinner';

interface HealthRatio {
  label: string;
  value: number | null;
  benchmark: string;
  status: 'excellent' | 'good' | 'warning' | 'danger';
  description: string;
}

interface ConcentrationItem {
  module: string;
  amount: number;
  ratio: number;
  warning: boolean;
}

interface LiquidityBreakdown {
  level: 'high' | 'medium' | 'low';
  label: string;
  amount: number;
  ratio: number;
}

interface RoiItem {
  module: string;
  nominalRate: number | null;
  realRate: number | null;
  cpiRate: number;
}

interface HealthData {
  month: string;
  overallScore: number;
  overallStatus: 'excellent' | 'good' | 'warning' | 'danger';
  ratios: HealthRatio[];
  concentration: ConcentrationItem[];
  concentrationThreshold: number;
  liquidityBreakdown: LiquidityBreakdown[];
  roiComparison: RoiItem[];
  cpiRate: number;
  summary: {
    totalAssets: number;
    totalDebt: number;
    netWorth: number;
    totalIncome: number;
    totalExpense: number;
    balance: number;
    monthlyRepayment: number;
    highLiquidAssets: number;
  };
}

interface ContingentSummary {
  items: { id: number; name: string; liabilityType: string; estimatedAmount: number; probability: string; status: string }[];
  summary: { total: number; activeCount: number; totalEstimatedAmount: number };
}

interface RevaluationItem {
  id: number;
  nodeId: number;
  revaluationDate: string;
  previousValue: number;
  newValue: number;
  change: number;
  changeType: 'appreciation' | 'depreciation';
  reason: string | null;
}

const STATUS_CONFIG = {
  excellent: { color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200', label: '优秀' },
  good: { color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', label: '良好' },
  warning: { color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', label: '需关注' },
  danger: { color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200', label: '风险' },
};

function formatPct(v: number | null): string {
  if (v === null) return '--';
  return `${(v * 100).toFixed(1)}%`;
}

function formatYuan(v: number): string {
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(2)}万`;
  return `${v.toFixed(2)}`;
}

function ScoreRing({ score, status }: { score: number; status: keyof typeof STATUS_CONFIG }) {
  const cfg = STATUS_CONFIG[status];
  const circumference = 2 * Math.PI * 45;
  const offset = circumference - (score / 100) * circumference;
  const strokeColor = status === 'excellent' ? '#059669' : status === 'good' ? '#2563eb' : status === 'warning' ? '#d97706' : '#dc2626';
  return (
    <div className="relative w-32 h-32 mx-auto">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="45" fill="none" stroke="#e2e8f0" strokeWidth="8" />
        <circle cx="50" cy="50" r="45" fill="none" stroke={strokeColor} strokeWidth="8" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} className="transition-all duration-1000" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-2xl font-bold ${cfg.color}`}>{score}</span>
        <span className={`text-xs ${cfg.color}`}>{cfg.label}</span>
      </div>
    </div>
  );
}

function RatioCard({ ratio }: { ratio: HealthRatio }) {
  const cfg = STATUS_CONFIG[ratio.status];
  return (
    <div className={`card p-4 border-l-4 ${cfg.border}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-slate-700">{ratio.label}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
      </div>
      <div className={`text-2xl font-bold ${cfg.color} mb-1`}>
        {ratio.label === '流动性覆盖' ? (ratio.value !== null ? `${ratio.value.toFixed(1)}个月` : '--') : formatPct(ratio.value)}
      </div>
      <div className="text-xs text-slate-400">{ratio.benchmark}</div>
      <div className="text-xs text-slate-500 mt-1">{ratio.description}</div>
    </div>
  );
}

function getCurrentMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function getPrevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function HealthPage() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [contingent, setContingent] = useState<ContingentSummary | null>(null);
  const [revaluations, setRevaluations] = useState<RevaluationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState(getPrevMonth(getCurrentMonth()));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [h, cl, rv] = await Promise.all([
          api<HealthData>('/api/health', { query: { month } }).catch(() => null),
          api<ContingentSummary>('/api/contingent-liabilities').catch(() => null),
          api<{ items: RevaluationItem[] }>('/api/revaluation').catch(() => null),
        ]);
        if (cancelled) return;
        if (!h) {
          setError(`${month} 尚无资产快照数据，请先完成月末录入`);
          setHealth(null);
        } else {
          setHealth(h);
        }
        setContingent(cl);
        setRevaluations(rv?.items ?? []);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [month]);

  if (loading) return <LoadingSpinner message="加载财务健康数据…" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">财务健康仪表盘</h1>
          <p className="text-sm text-slate-500 mt-1">基于 CPA 准则的家庭财务健康评估</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600">分析月份</label>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="input text-sm px-3 py-1.5" />
        </div>
      </div>

      {error && (
        <div className="card p-6 text-center">
          <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto mb-2" />
          <p className="text-slate-600">{error}</p>
        </div>
      )}

      {health && (
        <>
          {/* 综合评分 + 摘要 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="card p-6 flex flex-col items-center justify-center">
              <ScoreRing score={health.overallScore} status={health.overallStatus} />
              <p className="text-sm text-slate-500 mt-3">综合健康评分</p>
            </div>
            <div className="card p-6 lg:col-span-2">
              <h3 className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2"><BarChart3 className="w-4 h-4" />财务概览（{health.month}）</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div><div className="text-xs text-slate-400">净资产</div><div className="text-lg font-bold text-slate-900">{formatYuan(health.summary.netWorth)}</div></div>
                <div><div className="text-xs text-slate-400">总资产</div><div className="text-lg font-bold text-emerald-600">{formatYuan(health.summary.totalAssets)}</div></div>
                <div><div className="text-xs text-slate-400">总负债</div><div className="text-lg font-bold text-red-600">{formatYuan(health.summary.totalDebt)}</div></div>
                <div><div className="text-xs text-slate-400">月结余</div><div className={`text-lg font-bold ${health.summary.balance >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatYuan(health.summary.balance)}</div></div>
                <div><div className="text-xs text-slate-400">月收入</div><div className="text-base font-semibold text-slate-700">{formatYuan(health.summary.totalIncome)}</div></div>
                <div><div className="text-xs text-slate-400">月支出</div><div className="text-base font-semibold text-slate-700">{formatYuan(health.summary.totalExpense)}</div></div>
                <div><div className="text-xs text-slate-400">月还款</div><div className="text-base font-semibold text-slate-700">{formatYuan(health.summary.monthlyRepayment)}</div></div>
                <div><div className="text-xs text-slate-400">高流动性资产</div><div className="text-base font-semibold text-blue-600">{formatYuan(health.summary.highLiquidAssets)}</div></div>
              </div>
            </div>
          </div>

          {/* 五大核心比率 */}
          <div>
            <h2 className="text-base font-semibold text-slate-800 mb-3 flex items-center gap-2"><Activity className="w-4 h-4" />核心财务比率</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
              {health.ratios.map((r) => <RatioCard key={r.label} ratio={r} />)}
            </div>
          </div>

          {/* 资产集中度预警 */}
          <div className="card p-5">
            <h3 className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />资产集中度分析
              <span className="text-xs text-slate-400">（阈值：{(health.concentrationThreshold * 100).toFixed(0)}%）</span>
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-slate-500 border-b"><th className="text-left py-2 font-medium">模块</th><th className="text-right py-2 font-medium">金额</th><th className="text-right py-2 font-medium">占比</th><th className="text-center py-2 font-medium">状态</th></tr></thead>
                <tbody>
                  {health.concentration.map((c) => (
                    <tr key={c.module} className={`border-b last:border-0 ${c.warning ? 'bg-red-50' : ''}`}>
                      <td className="py-2 text-slate-700">{c.module}</td>
                      <td className="py-2 text-right text-slate-600">{formatYuan(c.amount)}</td>
                      <td className="py-2 text-right font-medium">{(c.ratio * 100).toFixed(1)}%</td>
                      <td className="py-2 text-center">{c.warning ? <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-600">集中度过高</span> : <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-600">正常</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 流动性结构 + 投资回报率 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card p-5">
              <h3 className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2"><PieChart className="w-4 h-4" />流动性结构</h3>
              <div className="space-y-3">
                {health.liquidityBreakdown.map((lb) => {
                  const barColor = lb.level === 'high' ? 'bg-emerald-500' : lb.level === 'medium' ? 'bg-blue-500' : 'bg-slate-400';
                  return (
                    <div key={lb.level}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-slate-600">{lb.label}</span>
                        <span className="text-slate-700 font-medium">{formatYuan(lb.amount)}（{(lb.ratio * 100).toFixed(1)}%）</span>
                      </div>
                      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.min(lb.ratio * 100, 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card p-5">
              <h3 className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2"><TrendingUp className="w-4 h-4" />投资回报率对标（月度）</h3>
              <div className="text-xs text-slate-400 mb-2">CPI 月折算率：{(health.cpiRate / 12 * 100).toFixed(3)}%</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-slate-500 border-b"><th className="text-left py-2 font-medium">模块</th><th className="text-right py-2 font-medium">名义收益率</th><th className="text-right py-2 font-medium">实际收益率</th></tr></thead>
                  <tbody>
                    {health.roiComparison.map((r) => (
                      <tr key={r.module} className="border-b last:border-0">
                        <td className="py-2 text-slate-700">{r.module}</td>
                        <td className="py-2 text-right">{r.nominalRate !== null ? <span className={r.nominalRate >= 0 ? 'text-emerald-600' : 'text-red-600'}>{formatPct(r.nominalRate)}</span> : '--'}</td>
                        <td className="py-2 text-right">{r.realRate !== null ? <span className={r.realRate >= 0 ? 'text-emerald-600' : 'text-red-600'}>{formatPct(r.realRate)}</span> : '--'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* 或有负债披露 + 公允价值重估 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card p-5">
              <h3 className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2"><Shield className="w-4 h-4" />或有负债披露（报表附注）</h3>
              {contingent && contingent.summary.activeCount > 0 ? (
                <>
                  <div className="flex gap-4 mb-3 text-sm">
                    <div><span className="text-slate-400">活跃项：</span><span className="font-medium">{contingent.summary.activeCount}</span></div>
                    <div><span className="text-slate-400">预估总额：</span><span className="font-medium text-amber-600">{formatYuan(contingent.summary.totalEstimatedAmount)}</span></div>
                  </div>
                  <div className="space-y-2">
                    {contingent.items.filter((i) => i.status === 'active').slice(0, 5).map((item) => (
                      <div key={item.id} className="flex items-center justify-between text-sm p-2 bg-slate-50 rounded">
                        <div>
                          <span className="text-slate-700">{item.name}</span>
                          <span className="text-xs text-slate-400 ml-2">{item.liabilityType === 'guarantee' ? '担保' : item.liabilityType === 'litigation' ? '诉讼' : item.liabilityType === 'commitment' ? '承诺' : '其他'}</span>
                        </div>
                        <div className="text-right">
                          <span className="font-medium">{formatYuan(item.estimatedAmount)}</span>
                          <span className={`text-xs ml-2 ${item.probability === 'probable' ? 'text-red-500' : item.probability === 'possible' ? 'text-amber-500' : 'text-slate-400'}`}>
                            {item.probability === 'probable' ? '很可能' : item.probability === 'possible' ? '可能' : '极小可能'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-400 py-4 text-center">暂无或有负债记录</p>
              )}
            </div>

            <div className="card p-5">
              <h3 className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2">
                {revaluations.length > 0 && revaluations[0].changeType === 'appreciation' ? <ArrowUp className="w-4 h-4 text-emerald-500" /> : <ArrowDown className="w-4 h-4 text-red-500" />}
                公允价值重估记录
              </h3>
              {revaluations.length > 0 ? (
                <div className="space-y-2">
                  {revaluations.slice(0, 5).map((r) => (
                    <div key={r.id} className="flex items-center justify-between text-sm p-2 bg-slate-50 rounded">
                      <div>
                        <span className="text-slate-700">{r.revaluationDate}</span>
                        {r.reason && <span className="text-xs text-slate-400 ml-2">{r.reason}</span>}
                      </div>
                      <div className="text-right">
                        <span className={`font-medium ${r.changeType === 'appreciation' ? 'text-emerald-600' : 'text-red-600'}`}>
                          {r.changeType === 'appreciation' ? '+' : ''}{formatYuan(r.change)}
                        </span>
                        <span className="text-xs text-slate-400 ml-2">{formatYuan(r.previousValue)} → {formatYuan(r.newValue)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-400 py-4 text-center">暂无重估记录</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
