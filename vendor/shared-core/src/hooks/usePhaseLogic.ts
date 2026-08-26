/**
 * 多阶段表单逻辑 Hook
 * 增强自 personal_review_system / root-cause-analysis
 *
 * 提供两个入口：
 * - `usePhaseLogic(template, record)`：简化版（保持公共包旧 API 兼容），
 *   基于记录数据计算阶段状态，内部已升级为增强版 getCurrentPhaseIndex
 *   （时间锁 / 重复段 / completesRecord 支持）。
 * - `useFormPhaseLogic(params)`：RHF 增强版（personal 版移植），
 *   实时监听表单值计算当前阶段、visitedMaxPhase 锁定、只读回看、
 *   canMarkComplete 完成判定、阶段点击导航，供 FormRenderer 使用。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWatch } from 'react-hook-form';
import type { Control } from 'react-hook-form';
import type { Dispatch, SetStateAction } from 'react';
import type { FormRecord, FormSection, FormTemplate, PhaseConfig } from '../types';
import {
  getCurrentPhaseIndex,
  getPhaseTimeLockInfo,
  getSectionPhaseIndex,
  isFieldEmpty,
  readRepeatableEntries,
} from '../utils/formValidation';

export interface PhaseState {
  currentPhaseIndex: number;
  totalPhases: number;
  isCompleted: boolean;
  canComplete: boolean;
  phaseLabels: string[];
  phaseSectionIndices: number[][];
  /** section 是否属于未来阶段（锁定，显示 🔒） */
  isSectionLocked: (sectionIndex: number) => boolean;
  /** section 是否只读（已完成阶段回看） */
  isSectionReadOnly: (sectionIndex: number) => boolean;
  /** 指定阶段的所有 completionFields 是否已满足 */
  isPhaseSatisfied: (phaseIndex: number) => boolean;
}

/**
 * 简化版：基于记录数据计算阶段状态（公共包旧 API，返回值已向后兼容扩展）。
 */
export function usePhaseLogic(
  template: FormTemplate | undefined,
  record: FormRecord | null
): PhaseState {
  return useMemo(() => {
    const noPhases: PhaseState = {
      currentPhaseIndex: 0,
      totalPhases: 0,
      isCompleted: record?.status === 'completed',
      canComplete: true,
      phaseLabels: [],
      phaseSectionIndices: [],
      isSectionLocked: () => false,
      isSectionReadOnly: () => record?.status === 'completed',
      isPhaseSatisfied: () => true,
    };
    if (!template?.phases || template.phases.length === 0) {
      return noPhases;
    }

    const phases = template.phases;
    const data = record?.data ?? {};

    // 增强：getCurrentPhaseIndex 支持重复段 entries、时间锁（unlockAfterDays）
    const currentPhaseIndex = getCurrentPhaseIndex(phases, data, template.sections, record?.createdAt);

    // 是否可标记完成（completesRecord 阶段及其之前所有 completionFields 满足）
    const completesPhaseIndex = phases.findIndex((p) => p.completesRecord);
    let canComplete = true;
    if (completesPhaseIndex < 0) {
      canComplete = true;
    } else {
      for (let i = 0; i <= completesPhaseIndex; i++) {
        const phase = phases[i];
        const repeatableSection = template.sections.find(
          (s, idx) => s.repeatable && phase.sectionIndices.includes(idx)
        );
        if (repeatableSection) {
          const entries = readRepeatableEntries(data, repeatableSection.id);
          if (entries.length === 0) { canComplete = false; break; }
          if (!entries.some((entry) => phase.completionFields.every((fid) => !isFieldEmpty(entry[fid])))) {
            canComplete = false;
            break;
          }
        } else {
          if (!phase.completionFields.every((fid) => !isFieldEmpty(data[fid]))) {
            canComplete = false;
            break;
          }
        }
      }
    }

    const sectionPhaseIndex = (sectionIndex: number) => getSectionPhaseIndex(phases, sectionIndex);

    return {
      currentPhaseIndex,
      totalPhases: phases.length,
      isCompleted: record?.status === 'completed',
      canComplete,
      phaseLabels: phases.map((p) => p.label),
      phaseSectionIndices: phases.map((p) => p.sectionIndices),
      isSectionLocked: (sectionIndex) => sectionPhaseIndex(sectionIndex) > currentPhaseIndex,
      isSectionReadOnly: (sectionIndex) => {
        const phaseIdx = sectionPhaseIndex(sectionIndex);
        if (record?.status === 'completed') {
          const completesIdx = phases.findIndex((p) => p.completesRecord);
          if (completesIdx >= 0 && phaseIdx <= completesIdx) return true;
        }
        return false;
      },
      isPhaseSatisfied: (phaseIndex) => {
        const phase = phases[phaseIndex];
        if (!phase) return true;
        return phase.completionFields.every((fid) => !isFieldEmpty(data[fid]));
      },
    };
  }, [template, record]);
}

/* ============================ RHF 增强版 ============================ */

export interface UseFormPhaseLogicParams {
  /** 阶段配置（无阶段模板为 undefined） */
  phases?: PhaseConfig[];
  /** 模板 sections（用于查 repeatable 标记与 section 标题） */
  templateSections: FormSection[];
  /** react-hook-form 的 control（供 useWatch 监听阶段相关字段） */
  control: Control<any>;
  /** 读取全部表单值（canMarkComplete 用） */
  getValues: () => Record<string, any>;
  /** 编辑记录时的初始数据（含 _createdAt/_status 等元信息） */
  initialData?: Record<string, any>;
  /** 记录完成状态（isSectionReadOnly 依据） */
  recordStatus: 'draft' | 'completed';
  /** 提示回调（可选，默认 no-op） */
  showToast?: (msg: string, type?: 'info' | 'success' | 'error') => void;
  /** 切换 tab / 阶段点击时的保存回调（performSave('draft')） */
  onNavigateSave?: () => void;
  /** 设置当前激活的 section tab */
  setActiveTab: (tab: number) => void;
}

export interface UseFormPhaseLogicResult {
  /** 当前所处阶段索引（0 起） */
  currentPhaseIndex: number;
  /** 用户实际进入过的最高阶段索引（用于回看只读锁定） */
  visitedMaxPhase: number;
  setVisitedMaxPhase: Dispatch<SetStateAction<number>>;
  /** section 是否属于未来阶段（不可进入，显示 🔒） */
  isSectionLocked: (sectionIndex: number) => boolean;
  /** section 是否只读（已完成阶段回看 / 记录完成后 completesRecord 前锁定） */
  isSectionReadOnly: (sectionIndex: number) => boolean;
  /** completesRecord 阶段及其之前的所有必填项是否满足（决定「✅ 完成」按钮是否可用） */
  canMarkComplete: () => boolean;
  /** 点击阶段指示器：导航到该阶段第一个 section（未来阶段拦截、只读回看提示） */
  handlePhaseClick: (phaseIndex: number) => void;
  /** 锁定 section 点击时的剩余冷静期提示文案（无锁/不可算时返回 null） */
  getLockedTabHint: (sectionIndex: number) => string | null;
}

/**
 * RHF 增强版：实时监听表单值计算阶段状态（personal 版移植，剥离投资业务逻辑）。
 */
export function useFormPhaseLogic({
  phases,
  templateSections,
  control,
  getValues,
  initialData,
  recordStatus,
  showToast,
  onNavigateSave,
  setActiveTab,
}: UseFormPhaseLogicParams): UseFormPhaseLogicResult {
  /** 用户实际进入过的最高阶段索引（进入更高阶段后，之前的阶段锁定只读） */
  const [visitedMaxPhase, setVisitedMaxPhase] = useState(0);
  /** 初始 tab 是否已定位（避免重复自动导航） */
  const initialTabSetRef = useRef(false);
  const notify = showToast ?? (() => {});

  // --- 阶段完成度监听：可重复段 entries key + 非重复段的 completionFields ---
  const repeatableEntriesKeys = useMemo(() => {
    if (!phases) return [] as string[];
    const keys: string[] = [];
    phases.forEach((phase) => {
      phase.sectionIndices.forEach((idx) => {
        const section = templateSections[idx];
        if (section?.repeatable) keys.push(`${section.id}_entries`);
      });
    });
    return keys;
  }, [phases, templateSections]);

  const phaseCompletionFields = useMemo(() => {
    if (!phases) return [] as string[];
    const fields: string[] = [];
    phases.forEach((phase) => {
      const isRepeatablePhase = phase.sectionIndices.some((idx) => templateSections[idx]?.repeatable);
      if (!isRepeatablePhase) {
        phase.completionFields.forEach((f) => {
          if (!fields.includes(f)) fields.push(f);
        });
      }
    });
    return fields;
  }, [phases, templateSections]);

  const watchedPhaseValues = useWatch({
    control,
    name: phaseCompletionFields.length > 0 ? phaseCompletionFields : ['__phase_placeholder__'],
    disabled: phaseCompletionFields.length === 0,
  });

  const watchedRepeatableEntries = useWatch({
    control,
    name: repeatableEntriesKeys.length > 0 ? repeatableEntriesKeys : ['__repeatable_placeholder__'],
    disabled: repeatableEntriesKeys.length === 0,
  });

  // --- 当前阶段计算 ---
  const currentPhaseIndex = useMemo(() => {
    if (!phases) return 0;
    const formData: Record<string, any> = {};
    phaseCompletionFields.forEach((field, i) => {
      formData[field] = (watchedPhaseValues as unknown[])[i];
    });
    repeatableEntriesKeys.forEach((key, i) => {
      formData[key] = (watchedRepeatableEntries as unknown[])[i];
    });
    const createdAt = initialData ? (initialData._createdAt as string) : undefined;
    return getCurrentPhaseIndex(phases, formData, templateSections, createdAt);
  }, [phases, phaseCompletionFields, watchedPhaseValues, repeatableEntriesKeys, watchedRepeatableEntries, templateSections, initialData]);

  // --- 初始加载：定位到当前阶段第一个 section，并初始化 visitedMaxPhase ---
  useEffect(() => {
    if (initialTabSetRef.current) return;
    initialTabSetRef.current = true;
    if (!phases || !initialData) return;
    const firstSectionIdx = phases[currentPhaseIndex]?.sectionIndices[0];
    if (firstSectionIdx !== undefined && firstSectionIdx > 0) setActiveTab(firstSectionIdx);
    setVisitedMaxPhase(currentPhaseIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phases, initialData, currentPhaseIndex, setActiveTab]);

  // --- 完成判定：completesRecord 阶段及其之前所有 completionFields 满足 ---
  const canMarkComplete = (): boolean => {
    if (!phases) return false;
    const formData = getValues();
    const completesPhaseIndex = phases.findIndex((p) => p.completesRecord);
    if (completesPhaseIndex < 0) return false;
    for (let i = 0; i <= completesPhaseIndex; i++) {
      const phase = phases[i];
      // completionFields 为空 → 该阶段无强制完成项，跳过
      if (phase.completionFields.length === 0) continue;
      const repeatableSection = templateSections.find((s, idx) => s.repeatable && phase.sectionIndices.includes(idx));
      if (repeatableSection) {
        const entries = readRepeatableEntries(formData, repeatableSection.id);
        if (entries.length === 0) return false;
        if (!entries.some((entry) => phase.completionFields.every((fieldId) => !isFieldEmpty(entry[fieldId])))) {
          return false;
        }
      } else {
        if (!phase.completionFields.every((fieldId) => !isFieldEmpty(formData[fieldId]))) {
          return false;
        }
      }
    }
    return true;
  };

  // --- 锁定判断 ---
  const isSectionLocked = (sectionIndex: number): boolean => {
    if (!phases) return false;
    return getSectionPhaseIndex(phases, sectionIndex) > currentPhaseIndex;
  };

  const isSectionReadOnly = (sectionIndex: number): boolean => {
    if (!phases) return recordStatus === 'completed';
    const sectionPhaseIdx = getSectionPhaseIndex(phases, sectionIndex);
    if (sectionPhaseIdx < visitedMaxPhase) return true;
    if (recordStatus === 'completed') {
      const completesIdx = phases.findIndex((p) => p.completesRecord);
      if (completesIdx >= 0 && sectionPhaseIdx <= completesIdx) return true;
    }
    return false;
  };

  // --- 阶段指示器点击：导航到该阶段第一个 section ---
  const handlePhaseClick = (phaseIndex: number) => {
    if (!phases) return;
    if (phaseIndex > currentPhaseIndex) return; // 未来阶段不可进入
    const firstSectionIdx = phases[phaseIndex]?.sectionIndices[0];
    if (firstSectionIdx === undefined) return;
    if (isSectionReadOnly(firstSectionIdx)) {
      notify('该阶段已完成，仅供查看、无法修改', 'info');
    }
    if (phaseIndex > visitedMaxPhase) setVisitedMaxPhase(phaseIndex);
    onNavigateSave?.();
    setActiveTab(firstSectionIdx);
  };

  /** 锁定 tab 点击时的剩余天数提示 */
  const getLockedTabHint = (sectionIndex: number): string | null => {
    if (!phases) return null;
    const sectionPhaseIdx = getSectionPhaseIndex(phases, sectionIndex);
    const phase = phases[sectionPhaseIdx];
    if (!phase?.unlockAfterDays) return null;
    const lockInfo = getPhaseTimeLockInfo(
      phase,
      getValues(),
      initialData ? (initialData._createdAt as string) : undefined
    );
    if (lockInfo.isLocked && lockInfo.unlockDate.getFullYear() < 9000) {
      return `「${templateSections[sectionIndex].title}」还需等待 ${lockInfo.daysRemaining} 天冷静期，之后即可复盘`;
    }
    return null;
  };

  return {
    currentPhaseIndex,
    visitedMaxPhase,
    setVisitedMaxPhase,
    isSectionLocked,
    isSectionReadOnly,
    canMarkComplete,
    handlePhaseClick,
    getLockedTabHint,
  };
}
