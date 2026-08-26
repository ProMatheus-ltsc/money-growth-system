/**
 * PhaseNotice — 阶段状态提示条
 *
 * 提取自 personal_review_system/src/components/form/PhaseNotice.tsx
 * 类型与时间锁计算统一走公共包（shared-core types / utils/formValidation）。
 *
 * 从 FormRenderer 拆出的展示组件，渲染两种阶段提示：
 * 1. 未来阶段横幅（锁页面）：当前 section 属于未来阶段且被时间锁定时，
 *    显示 🔒 解锁日期与剩余天数；若 completesRecord 阶段已完成，提供「标记为已完成」按钮
 * 2. 冷静期延迟提示：activateAfterDays 阶段基于激活字段（如卖出日期）计算剩余天数，
 *    未到建议时间显示等待提示，已过显示「现在可以复盘了」
 */
import type { PhaseConfig } from '../../types';
import { getPhaseTimeLockInfo, getSectionPhaseIndex } from '../../utils/formValidation';

interface PhaseNoticeProps {
  phases?: PhaseConfig[];
  /** 当前激活的 section 索引 */
  activeTab: number;
  /** 当前所处阶段索引（未来阶段判定依据） */
  currentPhaseIndex: number;
  recordStatus: 'draft' | 'completed';
  canMarkComplete: () => boolean;
  onMarkComplete: () => void;
  getValues: () => Record<string, any>;
  /** 记录创建时间（时间锁基准日期） */
  recordCreatedAt?: string;
}

export default function PhaseNotice({
  phases,
  activeTab,
  currentPhaseIndex,
  recordStatus,
  canMarkComplete,
  onMarkComplete,
  getValues,
  recordCreatedAt,
}: PhaseNoticeProps) {
  if (!phases) return null;

  const sectionPhaseIdx = getSectionPhaseIndex(phases, activeTab);
  const sectionPhase = phases[sectionPhaseIdx];

  // --- 未来阶段横幅：该 section 属于未来阶段（时间锁定或未解锁） ---
  if (sectionPhaseIdx > currentPhaseIndex) {
    const lockInfo = sectionPhase ? getPhaseTimeLockInfo(sectionPhase, getValues(), recordCreatedAt) : null;
    if (lockInfo?.isLocked) {
      const unlockDateStr = lockInfo.unlockDate && lockInfo.unlockDate.getFullYear() < 9000
          ? lockInfo.unlockDate.toISOString().slice(0, 10)
          : '待确定';
      const showMarkCompleteBtn = recordStatus === 'draft' && canMarkComplete();
      return (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm p-4 rounded-lg mb-4">
          <div className="flex items-start gap-3">
            <span className="text-lg">🔒</span>
            <div>
              <p className="font-medium">该复盘暂未开放</p>
              <p className="mt-1">「{sectionPhase?.label}」将在 <strong>{unlockDateStr}</strong> 开放（还需等待 {lockInfo.daysRemaining} 天）</p>
              <p className="mt-1 text-xs text-amber-600">让时间帮你获得更客观的视角，再来复盘效果更佳</p>
            </div>
          </div>
          {showMarkCompleteBtn && (
            <div className="mt-3 ml-8">
              <button
                type="button"
                onClick={onMarkComplete}
                className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition"
              >
                ✅ 标记为已完成
              </button>
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="text-sm text-gray-400 italic bg-gray-50 p-2 rounded mb-4 flex items-center gap-2">
        <span>📌</span>
        <span>此部分将在「{phases[sectionPhaseIdx]?.label}」阶段填写</span>
      </div>
    );
  }

  // --- 冷静期延迟提示：activateAfterDays 阶段，基于激活字段日期计算剩余天数 ---
  if (!sectionPhase?.activateAfterDays || !sectionPhase?.activateAfterField) return null;
  const lockInfo = getPhaseTimeLockInfo(sectionPhase, getValues(), recordCreatedAt);
  if (lockInfo?.isCooldown) {
    return (
      <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm p-3 rounded-lg mb-4">
        ⏰ 建议等待 {sectionPhase.activateAfterDays} 天后再复盘（还需等待 {lockInfo.remainingDays} 天），让时间帮你获得更客观的视角
      </div>
    );
  }
  if (lockInfo && !lockInfo.isCooldown) {
    return (
      <div className="bg-green-50 border border-green-200 text-green-700 text-sm p-3 rounded-lg mb-4">
        ✅ 已过 {sectionPhase.activateAfterDays} 天冷静期，现在可以复盘了！
      </div>
    );
  }
  return null;
}
