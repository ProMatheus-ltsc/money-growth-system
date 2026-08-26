/**
 * 阶段进度指示器 - 可点击导航
 * 增强自 personal_review_system / root-cause-analysis
 *
 * 以水平时间线形式展示模板的多个生命周期阶段（如「买入 → 持有 → 卖出 → 复盘」）。
 * 视觉状态：
 * - 已完成阶段：绿色圆圈 + 绿色连接线
 * - 当前阶段：蓝色圆圈 + 脉冲动画
 * - 未来阶段：灰色圆圈
 * - 时间锁（unlockAfterDays）：琥珀色圆圈 + 🔒 + 剩余天数
 * - 冷静期（activateAfterDays）：琥珀色圆圈 + ⏳ + 剩余天数
 *
 * 兼容旧 API：currentIndex / activeIndex / isCompleted 与新增 currentPhaseIndex 均可使用。
 */
import type { PhaseConfig } from '../../types';
import { getPhaseTimeLockInfo } from '../../utils/formValidation';

/** 兼容旧 API：只要求 label/icon，其余阶段配置可选 */
export type PhaseIndicatorPhase = Pick<PhaseConfig, 'label' | 'icon'> & Partial<PhaseConfig>;

interface PhaseIndicatorProps {
  phases: PhaseIndicatorPhase[];
  currentPhaseIndex?: number;
  /** 兼容旧 API */
  currentIndex?: number;
  /** 兼容旧 API */
  activeIndex?: number;
  /** 兼容旧 API */
  isCompleted?: boolean;
  onPhaseClick?: (phaseIndex: number) => void;
  /** 当前表单值（时间锁/冷静期计算用） */
  formData?: Record<string, unknown>;
  /** 记录创建时间（时间锁基准日期） */
  recordCreatedAt?: string;
}

export function PhaseIndicator({
  phases,
  currentPhaseIndex,
  currentIndex,
  activeIndex,
  isCompleted,
  onPhaseClick,
  formData,
  recordCreatedAt,
}: PhaseIndicatorProps) {
  if (phases.length === 0) return null;

  const current = currentPhaseIndex ?? currentIndex ?? 0;

  return (
    <div className="mb-5 px-2">
      <div className="flex items-center justify-between">
        {phases.map((phase, index) => {
          const isDone = isCompleted || index < current;
          const isActive = !isCompleted && index === (activeIndex ?? current);

          // 未来阶段时间锁（unlockAfterDays）
          let isTimeLocked = false;
          let timeLockLabel = '';
          if (index > current && phase.unlockAfterDays && formData) {
            const lockInfo = getPhaseTimeLockInfo(phase, formData, recordCreatedAt);
            if (lockInfo.isLocked) {
              isTimeLocked = true;
              if (lockInfo.unlockDate.getFullYear() < 9000) {
                timeLockLabel = `${lockInfo.daysRemaining}天后解锁`;
              } else {
                timeLockLabel = '待定';
              }
            }
          }

          // 未来阶段冷静期（activateAfterDays）
          let isDelayWaiting = false;
          let delayLabel = '';
          if (index > current && phase.activateAfterDays && phase.activateAfterField && formData) {
            const fieldValue = formData[phase.activateAfterField] as string | undefined;
            if (fieldValue && String(fieldValue).trim()) {
              const parsed = new Date(String(fieldValue));
              if (!isNaN(parsed.getTime())) {
                const today = new Date();
                const daysSince = Math.floor(
                  (today.getTime() - parsed.getTime()) / (1000 * 60 * 60 * 24)
                );
                if (daysSince < phase.activateAfterDays) {
                  isDelayWaiting = true;
                  delayLabel = `${phase.activateAfterDays - daysSince}天后`;
                }
              }
            }
          }

          return (
            <div key={phase.id ?? index} className="flex items-center flex-1 min-w-0">
              {/* 连接线 */}
              {index > 0 && (
                <div className="flex-1 mx-2 h-0.5 self-start mt-[18px] min-w-3">
                  <div
                    className={`h-full rounded-full transition-colors ${
                      index < current ? 'bg-emerald-300' : 'bg-slate-200'
                    }`}
                  />
                </div>
              )}
              {/* 阶段节点 */}
              <button
                type="button"
                onClick={() => {
                  if (index <= current) {
                    onPhaseClick?.(index);
                  }
                }}
                disabled={index > current}
                className={`flex flex-col items-center gap-1.5 group flex-shrink-0 ${index > current ? 'cursor-not-allowed opacity-80' : ''}`}
              >
                <div
                  className={`
                    w-9 h-9 rounded-full flex items-center justify-center text-base transition-all
                    ${isDone && !isActive ? 'bg-green-100 ring-2 ring-green-400' : ''}
                    ${isActive ? 'bg-blue-100 ring-2 ring-blue-500 shadow-md shadow-blue-100' : ''}
                    ${index > current && !isDelayWaiting && !isTimeLocked ? 'bg-slate-100 ring-1 ring-slate-300' : ''}
                    ${isTimeLocked ? 'bg-slate-100 ring-1 ring-amber-300' : ''}
                    ${isDelayWaiting && !isTimeLocked ? 'bg-slate-100 ring-1 ring-amber-300' : ''}
                    group-hover:scale-110
                  `}
                >
                  {isTimeLocked ? (
                    <span className="text-xs text-amber-500 font-medium">🔒</span>
                  ) : isDelayWaiting ? (
                    <span className="text-xs text-amber-500 font-medium">⏳</span>
                  ) : (
                    <span className={index > current ? 'opacity-50' : ''}>{phase.icon}</span>
                  )}
                </div>
                {/* 标签 */}
                <span
                  className={`text-xs font-medium whitespace-nowrap transition-colors ${
                    isDone && !isActive ? 'text-green-600' : ''
                  } ${isActive ? 'text-blue-600' : ''} ${index > current ? 'text-slate-400' : ''}`}
                >
                  {phase.label}
                </span>
                {/* 状态标签 */}
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                    isDone && !isActive ? 'bg-green-50 text-green-500' : ''
                  } ${isActive ? 'bg-blue-50 text-blue-500 animate-pulse' : ''} ${
                    index > current && !isDelayWaiting && !isTimeLocked ? 'bg-slate-50 text-slate-400' : ''
                  } ${isTimeLocked ? 'bg-amber-50 text-amber-500' : ''} ${
                    isDelayWaiting && !isTimeLocked ? 'bg-amber-50 text-amber-500' : ''
                  }`}
                >
                  {isDone && !isActive
                    ? '完成'
                    : isActive
                      ? '当前'
                      : isTimeLocked
                        ? timeLockLabel
                        : isDelayWaiting
                          ? delayLabel
                          : '稍后'}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
