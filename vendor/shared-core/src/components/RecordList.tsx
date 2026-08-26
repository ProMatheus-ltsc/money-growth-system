/**
 * RecordList — 记录列表通用骨架
 *
 * 展示记录列表，支持：
 * - 草稿 vs 已完成状态徽标
 * - 创建/更新时间显示（默认 date-fns 格式化 yyyy-MM-dd HH:mm，可通过 formatDate 自定义）
 * - 可选的阶段进度标签（phaseInfo 回调返回 null/undefined 则隐藏）
 * - 点击行进入编辑、删除操作
 *
 * 提取来源：personal_review_system/src/components/HistoryList.tsx
 * 剥离内容：isInvestmentTemplate 与全部投资徽标逻辑（buy/sell/position 相关函数）；
 * 阶段徽标配色改为 phaseBadgeColor props 注入（默认按阶段 id 哈希轮换三色，避免业务阶段名耦合）。
 */
import type { FormRecord } from '../types';
import { format } from 'date-fns';

/** 阶段进度信息：phaseInfo 回调的返回值 */
export interface PhaseInfo {
  phaseId: string;
  label: string;
  icon?: string;
}

/** 默认日期格式化：yyyy-MM-dd HH:mm，无法解析时原样返回 */
function defaultFormatDate(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  return format(date, 'yyyy-MM-dd HH:mm');
}

/** 默认阶段徽标配色：按阶段 id 哈希轮换三色，通用不依赖业务字段名 */
function defaultPhaseBadgeColor(phaseId: string): string {
  const colors = [
    'bg-blue-50 text-blue-600',
    'bg-amber-50 text-amber-600',
    'bg-green-50 text-green-600',
  ];
  let hash = 0;
  for (let i = 0; i < phaseId.length; i++) {
    hash = (hash * 31 + phaseId.charCodeAt(i)) >>> 0;
  }
  return colors[hash % colors.length];
}

interface RecordListProps {
  records: FormRecord[];
  /** 返回某条记录所处的阶段进度（null/undefined 表示不展示阶段标签） */
  phaseInfo?: (record: FormRecord) => PhaseInfo | null;
  /** 阶段徽标配色（返回 Tailwind 类名），默认按阶段 id 哈希轮换三色 */
  phaseBadgeColor?: (phaseId: string) => string;
  /** 点击行（编辑）回调 */
  onEdit?: (id: string) => void;
  /** 删除回调 */
  onDelete?: (id: string) => void;
  /** 日期格式化函数，默认 yyyy-MM-dd HH:mm */
  formatDate?: (iso: string) => string;
  /** 删除确认注入（PATCHES #2）：返回 true 直接执行 onDelete（外部弹窗确认）；
   *  缺省回退 window.confirm */
  confirmDelete?: (id: string) => Promise<boolean> | boolean;
}

export default function RecordList({
  records,
  phaseInfo,
  phaseBadgeColor = defaultPhaseBadgeColor,
  onEdit,
  onDelete,
  formatDate = defaultFormatDate,
  confirmDelete,
}: RecordListProps) {
  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirmDelete) {
      if (await confirmDelete(id)) {
        onDelete?.(id);
      }
      return;
    }
    if (window.confirm('确定删除这条记录吗？此操作不可撤销。')) {
      onDelete?.(id);
    }
  };

  return (
    <div className="space-y-2">
      {records.map((record) => {
        const phase = phaseInfo?.(record) ?? null;
        const isDraftWithPhase = record.status === 'draft' && phase;

        return (
          <div
            key={record.id}
            onClick={() => onEdit?.(record.id)}
            className="flex items-center gap-4 p-4 bg-white rounded-lg border cursor-pointer transition-colors hover:bg-gray-50"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">
                {record.title || '未命名记录'}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-xs text-gray-400">
                  创建 {formatDate(record.createdAt)}
                  {record.updatedAt && record.updatedAt !== record.createdAt
                    ? ` · 更新 ${formatDate(record.updatedAt)}`
                    : ''}
                </p>
                {phase && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap ${phaseBadgeColor(phase.phaseId)}`}
                  >
                    {phase.icon ? `${phase.icon} ` : ''}
                    {phase.label}
                  </span>
                )}
              </div>
            </div>
            {isDraftWithPhase ? (
              <span className="text-xs px-2 py-1 rounded-full font-medium whitespace-nowrap bg-indigo-50 text-indigo-600">
                继续填写 · {phase.label}
              </span>
            ) : (
              <span
                className={`text-xs px-2 py-1 rounded-full font-medium whitespace-nowrap ${
                  record.status === 'completed'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-yellow-100 text-yellow-700'
                }`}
              >
                {record.status === 'completed' ? '已完成' : '草稿'}
              </span>
            )}
            <button
              onClick={(e) => handleDelete(e, record.id)}
              className="p-2 text-gray-400 hover:text-red-500 transition-colors rounded-lg hover:bg-red-50"
              title="删除"
            >
              🗑️
            </button>
          </div>
        );
      })}
    </div>
  );
}
