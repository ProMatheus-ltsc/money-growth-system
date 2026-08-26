/**
 * 核心表单引擎：模板驱动，多Tab，自动保存，阶段管理
 * 增强自 personal_review_system / root-cause-analysis（剥离投资/决策/周复盘等业务插件）
 *
 * 核心能力：
 * - 基于 react-hook-form（useForm + FormProvider）重写，受控/非受控双模式字段渲染
 * - computed 计算字段：监听依赖字段实时计算并写回
 * - optionsFrom 动态选项：从 table 字段列取值去重，供 select 使用
 * - 条件字段：ConditionalField 支持 basePath 与 '*' 通配
 * - 跨 tab 校验定位 + 角标：完成时全模板校验，跳转首个错误 tab
 * - 自动保存（可选配置）：默认 30s，支持毫秒数 / 关闭
 * - 阶段锁定 / 只读：未来阶段不可进入（🔒），已完成阶段只读（✓）
 * - 分阶段校验工具：getScopedMissingFields / isPhaseCompletionSatisfied（见 utils/formValidation）
 * - OptionalFieldsGroup / CollapsibleSection（由同包其他文件提供）
 * - slots / renderField 扩展点：业务插件（投资/决策/周复盘面板）通过 props 注入
 *
 * 兼容性：对外 props 保持公共包 v1 兼容（template/record/onSave/onComplete/disabled），
 * 新增 autoSave / slots / renderField / notify / externalContext / recordCreatedAt 等可选扩展。
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useForm, FormProvider, useWatch } from 'react-hook-form';
import { v4 as uuidv4 } from 'uuid';
import { Save, CheckCircle2, ArrowRight, ArrowLeft } from 'lucide-react';
import type { FormTemplate, FormRecord, FormField, FormSection } from '../../types';
import {
  validateRequiredFields,
  getCurrentPhaseIndex,
  getSectionPhaseIndex,
  getPhaseTimeLockInfo,
  isFieldEmpty,
  buildInitialValues,
} from '../../utils/formValidation';
import type { ValidationError } from '../../utils/formValidation';
import { useFormPhaseLogic } from '../../hooks/usePhaseLogic';
import { ConditionalField } from './ConditionalField';
import OptionalFieldsGroup from './OptionalFieldsGroup';
import CollapsibleSection from './CollapsibleSection';
import { FieldRenderer } from './FieldRenderer';
import { FormTabs } from './FormTabs';
import { RepeatableSection } from './RepeatableSection';
import { PhaseIndicator } from './PhaseIndicator';

/** 业务插件扩展点上下文：向 slots / renderField 提供表单方法 */
export interface FormRendererSlotContext {
  formData: Record<string, unknown>;
  getValues: () => Record<string, unknown>;
  setValue: (name: string, value: unknown, options?: { shouldDirty?: boolean }) => void;
  watch: (name?: string) => unknown;
  activeTab: number;
  currentPhaseIndex: number;
  isSectionLocked: (index: number) => boolean;
  isSectionReadOnly: (index: number) => boolean;
}

/** 业务插件注入点（原投资/决策/周复盘面板在此扩展） */
export interface FormRendererSlots {
  /** 表单顶部（标题下方） */
  header?: (ctx: FormRendererSlotContext) => ReactNode;
  /** 分区字段前 */
  beforeSection?: (section: FormSection, ctx: FormRendererSlotContext) => ReactNode;
  /** 分区字段后 */
  afterSection?: (section: FormSection, ctx: FormRendererSlotContext) => ReactNode;
}

interface FormRendererProps {
  template: FormTemplate;
  record?: FormRecord | null;
  onSave?: (record: FormRecord) => Promise<void> | void;
  onComplete?: (record: FormRecord) => Promise<void> | void;
  disabled?: boolean;
  /** 自动保存：true（默认 30 秒）/ 毫秒数 / false 关闭 */
  autoSave?: boolean | number;
  /** 保存状态回调 */
  onSaveStateChange?: (state: 'idle' | 'saving' | 'saved') => void;
  /** 业务插件扩展点（投资/决策/周复盘面板注入） */
  slots?: FormRendererSlots;
  /** 自定义字段渲染器（默认内置 FieldRenderer） */
  renderField?: (field: FormField, ctx: FormRendererSlotContext) => ReactNode;
  /** 提示回调（锁阶段点击/校验失败等），默认 no-op */
  notify?: (message: string, type?: 'info' | 'success' | 'error') => void;
  /** 重复段 computed 字段 externalDeps 的数据源（props 注入，剥离业务耦合） */
  externalContext?: Record<string, unknown>;
  /** 记录创建时间基准（阶段时间锁用），默认取 record?.createdAt */
  recordCreatedAt?: string;
}

export function FormRenderer({
  template,
  record,
  onSave,
  onComplete,
  disabled = false,
  autoSave = true,
  onSaveStateChange,
  slots,
  renderField,
  notify,
  externalContext,
  recordCreatedAt,
}: FormRendererProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [readonlyToastShown, setReadonlyToastShown] = useState(false);
  const [recordStatus, setRecordStatus] = useState<'draft' | 'completed'>(record?.status ?? 'draft');
  const currentRecordId = useRef(record?.id ?? uuidv4());
  const autoSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifyMsg = notify ?? (() => {});

  const phases = template.phases;
  const hasPhases = !!phases && phases.length > 0;

  // 编辑记录时的初始数据（含元信息，供阶段逻辑与时间锁使用）
  const initialData = useMemo(
    () => ({
      ...(record?.data ?? {}),
      _createdAt: record?.createdAt,
      _status: record?.status,
    }),
    [record]
  );

  // 构建默认值：模板默认值 + 已有记录数据（兼容旧 `_repeat_<sectionId>` 存储键迁移）
  const defaultValues = useMemo(() => {
    const base = buildInitialValues(template);
    if (!record?.data) return base;
    const merged: Record<string, unknown> = { ...base, ...record.data };
    template.sections.forEach((s) => {
      if (!s.repeatable) return;
      const newKey = `${s.id}_entries`;
      const oldKey = `_repeat_${s.id}`;
      if (merged[newKey] === undefined && Array.isArray(merged[oldKey])) {
        merged[newKey] = merged[oldKey];
        delete merged[oldKey];
      }
    });
    return merged;
  }, [template, record]);

  const form = useForm({ defaultValues, mode: 'onTouched' });
  const { register, watch, setValue, getValues, control, reset, formState: { errors, isDirty } } = form;

  // 关闭/刷新页面前提示未保存内容
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty && saveStatus !== 'saved') {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty, saveStatus]);

  // === computed 计算字段逻辑 ===
  const computedFields = useMemo(() => {
    const fields: { id: string; dependsOn: string[]; formula: (v: Record<string, unknown>) => string | unknown; placeholder?: string; errorText?: string }[] = [];
    template.sections.forEach((s) => {
      if (s.repeatable) return; // 重复段条目的 computed 由 RepeatableSection 处理
      s.fields.forEach((f) => {
        if (f.computed) {
          fields.push({ id: f.id, ...f.computed });
        }
      });
    });
    return fields;
  }, [template]);

  const computedDependencyFields = useMemo(
    () => [...new Set(computedFields.flatMap((c) => c.dependsOn))],
    [computedFields]
  );

  const watchedComputedDeps = useWatch({
    control,
    name: computedDependencyFields.length > 0 ? computedDependencyFields : ['__computed_placeholder__'],
    disabled: computedDependencyFields.length === 0,
  });

  useEffect(() => {
    if (computedFields.length === 0) return;
    const depValues: Record<string, unknown> = {};
    computedDependencyFields.forEach((field, i) => {
      depValues[field] = (watchedComputedDeps as unknown[])[i];
    });
    computedFields.forEach((cf) => {
      let result: unknown;
      try {
        result = cf.formula(depValues);
      } catch {
        result = '__ERROR__';
      }
      const display = typeof result === 'string'
        ? result
        : result === undefined || result === null
          ? ''
          : typeof result === 'object'
            ? JSON.stringify(result)
            : String(result);
      setValue(cf.id, display, { shouldDirty: false });
    });
  }, [watchedComputedDeps, computedFields, computedDependencyFields, setValue]);

  // === 阶段逻辑（RHF 增强版） ===
  const {
    currentPhaseIndex,
    visitedMaxPhase,
    setVisitedMaxPhase,
    isSectionLocked,
    isSectionReadOnly,
    canMarkComplete,
    handlePhaseClick,
    getLockedTabHint,
  } = useFormPhaseLogic({
    phases,
    templateSections: template.sections,
    control,
    getValues,
    initialData,
    recordStatus,
    showToast: notifyMsg,
    onNavigateSave: () => {
      performSave('draft');
    },
    setActiveTab,
  });

  // 记录同步：外部加载（异步 useRecord）后重置表单，并定位到当前阶段第一个 section
  const loadedRecordIdRef = useRef<string | null>(null);
  useEffect(() => {
    const rid = record?.id ?? '';
    if (loadedRecordIdRef.current === rid) return;
    loadedRecordIdRef.current = rid;
    setRecordStatus(record?.status ?? 'draft');
    if (!record) return;
    reset(defaultValues, { keepDirty: false, keepErrors: false, keepIsSubmitted: false });
    if (hasPhases) {
      // 用刚重置的数据计算当前阶段（时间锁/重复段感知）
      const idx = getCurrentPhaseIndex(phases!, defaultValues, template.sections, record.createdAt);
      const firstSectionIdx = phases![idx]?.sectionIndices[0];
      if (firstSectionIdx !== undefined && firstSectionIdx > 0) {
        setActiveTab(firstSectionIdx);
        setVisitedMaxPhase(idx);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, defaultValues, reset, hasPhases]);

  // === 保存逻辑 ===
  const buildRecord = useCallback(
    (status: 'draft' | 'completed'): FormRecord => {
      const now = new Date().toISOString();
      const data = getValues();
      const title = (data.title as string) || `${template.name} - ${new Date().toLocaleDateString('zh-CN')}`;
      return {
        id: currentRecordId.current,
        templateId: template.id,
        title,
        data,
        status,
        createdAt: record?.createdAt ?? now,
        updatedAt: now,
        module: (data.module as string) || template.id.split('-')[0],
      };
    },
    [getValues, template, record]
  );

  const performSave = useCallback(
    async (status: 'draft' | 'completed') => {
      try {
        setSaveStatus('saving');
        onSaveStateChange?.('saving');
        // 首次标记完成时写入完成日期，作为复盘阶段解锁的基准
        if (status === 'completed' && isFieldEmpty(getValues('_completedAt'))) {
          setValue('_completedAt', new Date().toISOString().slice(0, 10), { shouldDirty: false });
        }
        // 已完成记录被重新编辑并自动保存时保持 completed 状态
        const finalStatus: 'draft' | 'completed' =
          status === 'completed' || recordStatus === 'completed' ? 'completed' : 'draft';
        const rec = buildRecord(finalStatus);
        await onSave?.(rec);
        setLastSaved(new Date());
        setSaveStatus('saved');
        onSaveStateChange?.('saved');
        if (finalStatus === 'completed') {
          setRecordStatus('completed');
        }
        return rec;
      } catch {
        setSaveStatus('idle');
        onSaveStateChange?.('idle');
        return null;
      }
    },
    [buildRecord, recordStatus, getValues, setValue, onSave, onSaveStateChange]
  );

  // 自动保存
  useEffect(() => {
    if (disabled) return;
    const intervalMs = autoSave === true ? 30000 : typeof autoSave === 'number' ? autoSave : 0;
    if (!intervalMs) return;
    autoSaveRef.current = setInterval(() => {
      performSave('draft');
    }, intervalMs);
    return () => {
      if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    };
  }, [disabled, autoSave, performSave]);

  // 切换 tab：锁定拦截 + 只读回看提示 + 保存
  const handleTabChange = useCallback(
    (index: number) => {
      if (isSectionLocked(index)) {
        const hint = getLockedTabHint(index);
        if (hint) {
          notifyMsg(hint, 'info');
          return;
        }
        return;
      }
      if (phases && isSectionReadOnly(index) && !isSectionReadOnly(activeTab) && !readonlyToastShown) {
        setReadonlyToastShown(true);
        notifyMsg('该阶段已完成，仅供查看、无法修改', 'info');
      }
      if (phases) {
        const targetPhase = getSectionPhaseIndex(phases, index);
        if (targetPhase > visitedMaxPhase) setVisitedMaxPhase(targetPhase);
      }
      performSave('draft');
      setActiveTab(index);
    },
    [performSave, isSectionLocked, phases, isSectionReadOnly, activeTab, visitedMaxPhase, readonlyToastShown, getLockedTabHint]
  );

  /** 手动保存草稿 */
  const handleDraftSave = async () => {
    const rec = await performSave('draft');
    if (rec) notifyMsg('草稿已保存', 'info');
  };

  /** 完成提交：先校验全模板必填字段，失败跳转首个错误 section */
  const handleComplete = async () => {
    const formData = getValues();
    const { valid, errors: errs } = validateRequiredFields(template, formData);
    if (!valid) {
      setValidationErrors(errs);
      const firstError = errs[0];
      if (firstError && firstError.sectionIndex !== undefined) {
        setActiveTab(firstError.sectionIndex);
      }
      notifyMsg(`有 ${errs.length} 个字段未通过校验，请检查`, 'error');
      return;
    }
    setValidationErrors([]);
    const rec = await performSave('completed');
    if (rec) {
      notifyMsg('复盘已完成并保存', 'success');
      onComplete?.(rec);
    }
  };

  /** 标记记录为已完成（completesRecord 阶段，下一阶段被时间锁定） */
  const handleMarkComplete = useCallback(async () => {
    if (!canMarkComplete()) {
      notifyMsg('请先完成本阶段的必填项', 'error');
      return;
    }
    const rec = await performSave('completed');
    if (rec) {
      const completesIdx = phases ? phases.findIndex((p) => p.completesRecord) : -1;
      const nextPhase = phases && completesIdx >= 0 ? phases[completesIdx + 1] : undefined;
      let msg = `「${template.name}」已完成`;
      if (nextPhase?.unlockAfterDays) {
        const lockInfo = getPhaseTimeLockInfo(nextPhase, getValues(), recordCreatedAt ?? record?.createdAt);
        if (lockInfo.isLocked && lockInfo.unlockDate.getFullYear() < 9000) {
          msg = `已标记为完成，「${nextPhase.label}」将在 ${lockInfo.daysRemaining} 天后开放`;
        }
      }
      notifyMsg(msg, 'success');
      onComplete?.(rec);
    }
  }, [canMarkComplete, performSave, phases, template.name, getValues, recordCreatedAt, record?.createdAt, notifyMsg, onComplete]);

  const goNext = () => {
    if (activeTab < template.sections.length - 1) handleTabChange(activeTab + 1);
  };
  const goPrev = () => {
    if (activeTab > 0) handleTabChange(activeTab - 1);
  };

  const activeSection = template.sections[activeTab];
  const isLastTab = activeTab === template.sections.length - 1;

  // === 校验错误 → tab 角标 ===
  const sectionsWithErrors = useMemo(() => {
    const set = new Set<number>();
    validationErrors.forEach((err) => {
      if (err.sectionIndex !== undefined) set.add(err.sectionIndex);
    });
    return set;
  }, [validationErrors]);

  // 字段值变化后自动清除已修复的校验错误
  const errorFieldIds = validationErrors.map((e) => e.fieldId);
  const watchedErrorValues = useWatch({
    control,
    name: errorFieldIds.length > 0 ? errorFieldIds : ['__placeholder__'],
    disabled: errorFieldIds.length === 0,
  });

  useEffect(() => {
    if (validationErrors.length > 0 && errorFieldIds.length > 0) {
      const remaining = validationErrors.filter((_err, index) => {
        const val = (watchedErrorValues as unknown[])[index];
        return isFieldEmpty(val);
      });
      if (remaining.length !== validationErrors.length) {
        setValidationErrors(remaining);
      }
    }
  }, [watchedErrorValues, validationErrors]);

  // === 可选字段分组（计数与条件显隐对齐） ===
  const mainFields = activeSection.fields.filter((f) => f.priority !== 'optional');

  const optionalConditionDeps = useMemo(() => {
    const deps: string[] = [];
    activeSection.fields.forEach((f) => {
      if (f.priority === 'optional' && f.condition?.dependsOn && !deps.includes(f.condition.dependsOn)) {
        deps.push(f.condition.dependsOn);
      }
    });
    return deps;
  }, [activeSection]);

  const watchedOptionalDeps = useWatch({
    control,
    name: optionalConditionDeps.length > 0 ? optionalConditionDeps : ['__optional_placeholder__'],
    disabled: optionalConditionDeps.length === 0,
  });

  const optionalFields = useMemo(
    () =>
      activeSection.fields.filter((f) => {
        if (f.priority !== 'optional') return false;
        if (!f.condition) return true;
        const idx = optionalConditionDeps.indexOf(f.condition.dependsOn);
        const depValue = idx >= 0 ? (watchedOptionalDeps as unknown[])[idx] : undefined;
        const showWhen = f.condition.showWhen;
        if (Array.isArray(showWhen)) {
          return showWhen.includes('*') ? !!depValue : showWhen.includes(String(depValue));
        }
        return depValue === showWhen;
      }),
    [activeSection, watchedOptionalDeps, optionalConditionDeps]
  );

  // === 字段渲染 ===
  const computeFieldError = (field: FormField): string | undefined => {
    const validationError = validationErrors.find((err) => err.fieldId === field.id);
    const fieldError = errors[field.id];
    return validationError
      ? validationError.message || '此字段为必填项'
      : fieldError
        ? typeof fieldError.message === 'string'
          ? fieldError.message
          : '此字段为必填项'
        : undefined;
  };

  /** 计算 optionsFrom 动态选项（从表格列取值去重） */
  const computeDynamicOptions = (field: FormField): { value: string; label: string }[] | undefined => {
    if (!field.optionsFrom) return undefined;
    const tableData = watch(field.optionsFrom.fieldId) as Record<string, string>[] | undefined;
    if (!Array.isArray(tableData)) return undefined;
    return tableData
      .map((row) => row[field.optionsFrom!.columnId])
      .filter((v): v is string => !!v && v.trim() !== '')
      .map((v) => ({ value: v, label: v }));
  };

  const slotCtx: FormRendererSlotContext = {
    formData: getValues(),
    getValues,
    setValue,
    watch,
    activeTab,
    currentPhaseIndex,
    isSectionLocked,
    isSectionReadOnly,
  };

  const renderFieldItem = (field: FormField) => {
    const errorMessage = computeFieldError(field);
    const watchedHintValue = field.hintDependsOn ? (watch(field.hintDependsOn) as string | undefined) : undefined;
    const computedValue = field.computed ? (watch(field.id) as string | undefined) : undefined;
    const dynamicOptions = computeDynamicOptions(field);
    const isControlledType =
      field.type === 'checkbox' ||
      field.type === 'rating' ||
      field.type === 'table' ||
      field.type === 'quadrant' ||
      field.type === 'dragMatrix';

    const fieldComponent = renderField
      ? renderField(field, slotCtx)
      : (
        <FieldRenderer
          key={field.id}
          field={field}
          register={register}
          error={errorMessage}
          watchedHintValue={watchedHintValue}
          computedValue={computedValue}
          dynamicOptions={dynamicOptions}
          disabled={disabled || isSectionReadOnly(activeTab)}
          {...(isControlledType
            ? {
                controlled: true,
                value: watch(field.id),
                onChange: (val: unknown) => setValue(field.id, val, { shouldDirty: true }),
              }
            : {})}
        />
      );

    return (
      <ConditionalField key={field.id} condition={field.condition} control={control}>
        {fieldComponent}
      </ConditionalField>
    );
  };

  // === 阶段提示（未来阶段锁页面 + 冷静期 + 只读横幅） ===
  const renderPhaseNotice = () => {
    if (!phases) return null;
    const sectionPhaseIdx = getSectionPhaseIndex(phases, activeTab);
    const sectionPhase = phases[sectionPhaseIdx];

    // 未来阶段：时间锁 / 未解锁
    if (sectionPhaseIdx > currentPhaseIndex) {
      const lockInfo = sectionPhase
        ? getPhaseTimeLockInfo(sectionPhase, getValues(), recordCreatedAt ?? record?.createdAt)
        : null;
      if (lockInfo && lockInfo.isLocked) {
        const unlockDateStr = lockInfo.unlockDate.getFullYear() < 9000
          ? lockInfo.unlockDate.toISOString().slice(0, 10)
          : '待确定';
        return (
          <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm p-4 rounded-lg mb-4">
            <p className="font-medium">🔒 该部分暂未开放</p>
            <p className="mt-1">
              「{sectionPhase?.label}」将在 <strong>{unlockDateStr}</strong> 开放（还需等待 {lockInfo.daysRemaining} 天）
            </p>
          </div>
        );
      }
      return (
        <div className="text-sm text-slate-400 italic bg-slate-50 p-2 rounded mb-4 flex items-center gap-2">
          <span>📌</span>
          <span>此部分将在「{phases[sectionPhaseIdx]?.label}」阶段填写</span>
        </div>
      );
    }

    // 冷静期（activateAfterDays）提示
    if (!sectionPhase?.activateAfterDays || !sectionPhase?.activateAfterField) return null;
    const fieldValue = getValues()[sectionPhase.activateAfterField] as string;
    if (!fieldValue || !fieldValue.trim()) return null;
    const parsedDate = new Date(fieldValue);
    if (isNaN(parsedDate.getTime())) return null;
    const daysSince = Math.floor((Date.now() - parsedDate.getTime()) / (1000 * 60 * 60 * 24));
    const daysRemaining = sectionPhase.activateAfterDays - daysSince;
    if (daysRemaining > 0) {
      return (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm p-3 rounded-lg mb-4">
          ⏰ 建议等待 {sectionPhase.activateAfterDays} 天后再复盘（还需等待 {daysRemaining} 天），让时间帮你获得更客观的视角
        </div>
      );
    }
    return (
      <div className="bg-green-50 border border-green-200 text-green-700 text-sm p-3 rounded-lg mb-4">
        ✅ 已过 {sectionPhase.activateAfterDays} 天冷静期，现在可以复盘了！
      </div>
    );
  };

  // === 底部主按钮 ===
  const renderPrimaryButton = () => {
    if (disabled) return null;
    // 无阶段且已完成 → 只读展示
    if (recordStatus === 'completed' && !hasPhases) {
      return (
        <button type="button" disabled className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-green-600 bg-green-50 border border-green-200 rounded-lg cursor-default">
          ✅ 已完成
        </button>
      );
    }
    // 最后一个 section → 完成记录
    if (isLastTab) {
      if (recordStatus === 'completed') {
        return (
          <button type="button" disabled className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-green-600 bg-green-50 border border-green-200 rounded-lg cursor-default">
            ✅ 已完成
          </button>
        );
      }
      return (
        <button
          type="button"
          onClick={handleComplete}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-all shadow-sm"
        >
          <CheckCircle2 size={14} />
          完成记录
        </button>
      );
    }
    // 下一阶段锁定且已完成 → 已完成
    if (hasPhases && isSectionLocked(activeTab + 1) && recordStatus === 'completed') {
      return (
        <button type="button" disabled className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-green-600 bg-green-50 border border-green-200 rounded-lg cursor-default">
          ✅ 已完成
        </button>
      );
    }
    // 下一阶段锁定且可标记完成 → 标记完成
    if (hasPhases && isSectionLocked(activeTab + 1) && canMarkComplete()) {
      return (
        <button
          type="button"
          onClick={handleMarkComplete}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition shadow-sm"
        >
          ✅ 完成本阶段
        </button>
      );
    }
    // 默认：下一步
    return (
      <button
        type="button"
        onClick={goNext}
        disabled={hasPhases && isSectionLocked(activeTab + 1)}
        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm"
      >
        下一步
        <ArrowRight size={14} />
      </button>
    );
  };

  return (
    <div className="max-w-3xl mx-auto">
      <FormProvider {...form}>
        {slots?.header?.(slotCtx)}

        {/* 状态栏 */}
        <div className="flex items-center justify-between mb-4 px-1">
          <h1 className="text-lg font-semibold text-slate-900">{template.name}</h1>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            {saveStatus === 'saving' && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                保存中...
              </span>
            )}
            {saveStatus === 'saved' && lastSaved && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 bg-green-400 rounded-full" />
                已保存 {lastSaved.toLocaleTimeString('zh-CN')}
              </span>
            )}
            {isDirty && saveStatus !== 'saving' && (
              <span className="text-amber-500">● 未保存</span>
            )}
          </div>
        </div>

        {/* 阶段指示器（有 phases 时作为主导航） */}
        {hasPhases && (
          <PhaseIndicator
            phases={phases!}
            currentPhaseIndex={currentPhaseIndex}
            onPhaseClick={handlePhaseClick}
            formData={getValues()}
            recordCreatedAt={recordCreatedAt ?? record?.createdAt}
          />
        )}

        {/* Tab 导航（含锁定/只读/错误角标/键盘切换） */}
        <FormTabs
          sections={template.sections}
          activeTab={activeTab}
          isLocked={isSectionLocked}
          isReadOnly={isSectionReadOnly}
          hasErrors={(index) => sectionsWithErrors.has(index)}
          onTabChange={handleTabChange}
        />

        <form onSubmit={(e) => e.preventDefault()}>
          {/* 阶段提示 */}
          {renderPhaseNotice()}

          {/* 仅当 section 未被锁定才渲染字段 */}
          {!isSectionLocked(activeTab) && (
            <fieldset disabled={isSectionReadOnly(activeTab)} className="min-w-0 border-0 p-0 m-0">
              {/* 只读横幅 */}
              {isSectionReadOnly(activeTab) && (
                <div className="text-sm p-3 rounded-lg mb-4 border bg-amber-50 border-amber-200 text-amber-700">
                  🔒 「{activeSection.title}」已完成，内容仅供查看，无法修改
                </div>
              )}

              {slots?.beforeSection?.(activeSection, slotCtx)}

              {activeSection.repeatable ? (
                <RepeatableSection
                  section={activeSection}
                  entries={(watch(`${activeSection.id}_entries`) as Record<string, unknown>[] | undefined) ?? []}
                  onChange={(entries) => setValue(`${activeSection.id}_entries`, entries, { shouldDirty: true })}
                  disabled={disabled || isSectionReadOnly(activeTab)}
                  externalContext={externalContext}
                />
              ) : (
                <CollapsibleSection key={activeSection.id} section={activeSection}>
                  {activeSection.description && !activeSection.collapsedByDefault && (
                    <p className="text-sm text-slate-500 mb-4">{activeSection.description}</p>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    {mainFields.map((field) => (
                      <div
                        key={field.id}
                        className={
                          field.type === 'textarea' || field.type === 'table' || field.type === 'quadrant' || field.type === 'dragMatrix'
                            ? 'sm:col-span-2'
                            : ''
                        }
                      >
                        {renderFieldItem(field)}
                      </div>
                    ))}
                  </div>
                  <OptionalFieldsGroup count={optionalFields.length}>
                    {optionalFields.map((field) => renderFieldItem(field))}
                  </OptionalFieldsGroup>
                </CollapsibleSection>
              )}

              {slots?.afterSection?.(activeSection, slotCtx)}
            </fieldset>
          )}

          {/* 底部操作栏 */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between mt-6 pt-4 border-t border-slate-100 gap-3 sm:gap-0">
            <button
              type="button"
              onClick={goPrev}
              disabled={activeTab === 0 || isSectionLocked(activeTab - 1)}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-all disabled:opacity-40"
            >
              <ArrowLeft size={14} />
              上一步
            </button>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              {!disabled && !isSectionReadOnly(activeTab) && (
                <button
                  type="button"
                  onClick={handleDraftSave}
                  disabled={saveStatus === 'saving'}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-all"
                >
                  <Save size={14} />
                  {saveStatus === 'saving' ? '保存中...' : '保存草稿'}
                </button>
              )}
              {renderPrimaryButton()}
            </div>
          </div>
        </form>
      </FormProvider>
    </div>
  );
}
