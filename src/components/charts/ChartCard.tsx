/**
 * ChartCard — 图表卡片容器（06 T21）：标题 + 副标题 + 加载占位 + 失败重试（03-prd §5.2 报错态）。
 */
import React from 'react';

interface ChartCardProps {
  title: string;
  subtitle?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  children: React.ReactNode;
  /** 附加操作区（右侧） */
  actions?: React.ReactNode;
}

export function ChartCard({ title, subtitle, loading, error, onRetry, children, actions }: ChartCardProps) {
  return (
    <div className="card">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-semibold text-slate-800">{title}</h3>
          {subtitle && <p className="mt-1 text-xs text-slate-400 leading-relaxed">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {loading ? (
        <div className="flex h-[320px] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
        </div>
      ) : error ? (
        <div className="flex h-[320px] flex-col items-center justify-center gap-3 text-sm text-slate-500">
          <p>图表加载失败：{error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="btn-primary py-1.5 px-4 text-xs"
            >
              重试
            </button>
          )}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
