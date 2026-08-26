/**
 * 版本历史列表：展示当前分析记录的快照（Snapshot）。
 * 交互流程：加载中显示提示 → 空列表引导创建 → 有快照时逐条列出，
 * 每条提供"恢复"（把表单回滚到快照状态）与"删除"；右上角按钮创建新快照。
 * 核心概念：快照是用户在分析过程中的"手动存档点"，区别于自动保存的草稿。
 *
 * 提取来源：root-cause-analysis/src/components/history/SnapshotList.tsx
 * 适配说明：Snapshot 类型从公共包 types 引入；原 root-cause 自定义色板
 * （text-gray-900 / bg-gray-200 / bg-blue-50 等）改为标准 Tailwind 色板。
 */
import { format } from 'date-fns';
import type { Snapshot } from '../types';

interface VersionHistoryListProps {
  /** 快照列表（按时间倒序），最多保留 20 个 */
  snapshots: Snapshot[];
  /** 是否正在从 IndexedDB 加载快照 */
  loading: boolean;
  /** 点击"恢复"时回调（参数为完整快照，父组件负责 reset 表单） */
  onRestore: (snapshot: Snapshot) => void;
  /** 点击删除时回调（参数为快照 id） */
  onDelete: (id: string) => void;
  /** 点击"创建快照"时回调（父组件负责把当前表单值写入存储） */
  onCreateSnapshot: () => void;
}

export function VersionHistoryList({
  snapshots,
  loading,
  onRestore,
  onDelete,
  onCreateSnapshot,
}: VersionHistoryListProps) {
  if (loading) {
    return <p className="text-xs text-gray-400">加载版本历史…</p>;
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          版本历史
        </h4>
        <button
          type="button"
          onClick={onCreateSnapshot}
          className="rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition"
        >
          创建快照
        </button>
      </div>

      {snapshots.length === 0 ? (
        <p className="text-xs text-gray-400 py-2">暂无版本历史。点击"创建快照"保存当前状态。</p>
      ) : (
        <div className="max-h-48 overflow-y-auto space-y-2">
          {snapshots.map((snapshot) => (
            <div
              key={snapshot.id}
              className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-900 truncate">{snapshot.label}</p>
                <p className="text-[10px] text-gray-400">
                  {format(new Date(snapshot.createdAt), 'yyyy-MM-dd HH:mm:ss')}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <button
                  type="button"
                  onClick={() => onRestore(snapshot)}
                  className="rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-700 transition"
                >
                  恢复
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(snapshot.id)}
                  className="rounded-md text-[11px] text-gray-400 hover:text-red-600 transition"
                  aria-label="删除快照"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {snapshots.length > 0 && (
        <p className="text-[10px] text-gray-400">最多保留 20 个快照，超出后自动清理最早的记录。</p>
      )}
    </div>
  );
}
