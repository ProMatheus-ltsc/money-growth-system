/**
 * TemplateCard — 模板卡片组件
 *
 * 提取自 personal_review_system/src/components/TemplateCard.tsx
 * 类型统一使用公共包 shared-core types 的 FormTemplate（含 timing）。
 *
 * 在仪表盘中展示单个复盘模板的信息卡片，包括：
 * - 模板图标、名称、描述
 * - 使用频率标签和建议时机
 * - 已有记录数和最近编辑时间
 * - 「新建」和「历史记录」操作按钮
 *
 * 频率标签颜色通过 frequencyColorMap 映射，与模板的 timing.frequency 对应。
 */
import type { FormTemplate } from '../types';

const frequencyColorMap: Record<string, string> = {
  '每天': 'bg-green-100 text-green-700',
  '每周': 'bg-blue-100 text-blue-700',
  '每月': 'bg-purple-100 text-purple-700',
  '随时': 'bg-amber-100 text-amber-700',
  '事件后': 'bg-orange-100 text-orange-700',
  '决策前后': 'bg-indigo-100 text-indigo-700',
  '交易时': 'bg-emerald-100 text-emerald-700',
};

interface TemplateCardProps {
  template: FormTemplate;
  recordCount: number;
  lastUpdated?: string;
  onNewRecord: () => void;
  onViewHistory: () => void;
}

export default function TemplateCard({
  template,
  recordCount,
  lastUpdated,
  onNewRecord,
  onViewHistory,
}: TemplateCardProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm hover:shadow-md transition-shadow border p-4 flex flex-col">
      <div className="text-3xl mb-2">{template.icon}</div>
      <h3 className="font-bold text-base text-gray-900">{template.name}</h3>
      <p className="text-sm text-gray-500 line-clamp-2 mt-1 flex-1">
        {template.description}
      </p>
      {template.timing && (
        <div className="flex items-center gap-2 mt-2">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${frequencyColorMap[template.timing.frequency] || 'bg-gray-100 text-gray-700'}`}>
            {template.timing.frequency}
          </span>
          <span className="text-xs text-gray-400">
            {template.timing.suggestion}
          </span>
        </div>
      )}
      <div className="mt-4 text-sm text-gray-400 space-y-1">
        <div>{recordCount} 条记录</div>
        <div>最近: {lastUpdated || '暂无'}</div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={onNewRecord}
          className="flex-1 px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          新建
        </button>
        <button
          onClick={onViewHistory}
          className="flex-1 px-3 py-1.5 border border-gray-300 text-gray-700 text-xs font-medium rounded-lg hover:bg-gray-50 transition-colors"
        >
          历史记录
        </button>
      </div>
    </div>
  );
}
