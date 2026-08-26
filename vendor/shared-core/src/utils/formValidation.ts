/**
 * 表单校验工具函数
 * 增强自 personal_review_system / root-cause-analysis
 *
 * 合并了三版能力：
 * - 基础：isFieldEmpty / resolveDefaultValue / buildInitialValues（默认值，含 table/quadrant/dragMatrix）
 * - 必填校验：validateRequiredFields（支持条件字段/checkbox 豁免/正则/数值范围）
 * - 阶段判定：getCurrentPhaseIndex / getSectionPhaseIndex / getPhaseTimeLockInfo / getScopedMissingFields
 * - 阶段完成判定：isCompletionFieldSatisfied / isPhaseCompletionSatisfied（支持重复段 minEntries/table 最少单元格）
 */
import type { FormField, FormSection, FormTemplate, PhaseConfig } from '../types';

/** 表单验证错误信息 */
export interface ValidationError {
  fieldId: string;
  fieldLabel: string;
  /** 字段所属 section 在模板中的索引（用于 tab 角标定位） */
  sectionIndex: number;
  /** 自定义错误文案（如正则校验失败提示），缺省时显示「此字段为必填项」 */
  message?: string;
}

/** 重复段条目在表单值树中的存储 key（新约定：`<sectionId>_entries`） */
export function getRepeatableEntriesKey(sectionId: string): string {
  return `${sectionId}_entries`;
}

/**
 * 读取重复段条目数组，兼容旧存储键：
 * - 新约定：`<sectionId>_entries`
 * - 旧约定（公共包 v1）：`_repeat_<sectionId>`
 */
export function readRepeatableEntries(
  data: Record<string, unknown>,
  sectionId: string
): Record<string, unknown>[] {
  const newKey = getRepeatableEntriesKey(sectionId);
  if (Array.isArray(data[newKey])) return data[newKey] as Record<string, unknown>[];
  const oldKey = `_repeat_${sectionId}`;
  if (Array.isArray(data[oldKey])) return data[oldKey] as Record<string, unknown>[];
  return [];
}

/**
 * 判断"空值"的统一定义（简单版，root-cause 语义）：
 * - undefined / null → 空
 * - 字符串 → 去空白后为空才是空
 * - 数组 → 长度 0 视为空
 * - 数字 → 永远不空（0 也是有效值）
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * 判断字段值是否为空（增强版，personal 语义）：
 * - table：数组为空，或所有行所有单元格都为空 → 空
 * - 四象限矩阵：四象限均无有效事项 → 空
 * - 布尔 false（非强调 checkbox）→ 空
 */
export function isFieldEmpty(value: unknown): boolean {
  // Table field: array of objects — empty if no rows, or all rows have empty values
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    return value.every((row) => {
      if (typeof row !== 'object' || row === null) return true;
      return Object.values(row).every((v) => v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim() === ''));
    });
  }
  // Quadrant matrix field: object with q1/q2/q3/q4 arrays — empty if all quadrants have no non-empty items
  if (typeof value === 'object' && value !== null && 'q1' in value && 'q2' in value && 'q3' in value && 'q4' in value) {
    const matrix = value as Record<string, unknown>;
    return ['q1', 'q2', 'q3', 'q4'].every((key) => {
      const arr = matrix[key];
      return !Array.isArray(arr) || arr.every((item) => {
        if (typeof item !== 'object' || item === null) return true;
        const text = (item as { text?: unknown }).text;
        return text === undefined || text === null || String(text).trim() === '';
      });
    });
  }
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (typeof value === 'string' && value.trim() === '') ||
    (typeof value === 'boolean' && value === false)
  );
}

/** 解析默认值（支持 magic string：auto_today / auto_now / auto_now+N） */
export function resolveDefaultValue(defaultValue: unknown): unknown {
  if (typeof defaultValue !== 'string') return defaultValue;

  if (defaultValue === 'auto_today') {
    return new Date().toISOString().split('T')[0];
  }
  if (defaultValue === 'auto_now') {
    return new Date().toISOString().slice(0, 16);
  }
  if (defaultValue.startsWith('auto_now+')) {
    const days = parseInt(defaultValue.replace('auto_now+', ''), 10);
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  }

  return defaultValue;
}

/** 返回一个全新的空四象限矩阵（避免多个字段共享同一引用） */
export function EMPTY_QUADRANT_MATRIX() {
  return { q1: [], q2: [], q3: [], q4: [] };
}

/** 返回一个全新的空拖拽决策矩阵（避免多个字段共享同一引用） */
export function EMPTY_DRAG_MATRIX() {
  return { q1: [], q2: [], q3: [], q4: [] };
}

/** 获取模板所有必填字段（含重复段内必填字段） */
export function getRequiredFields(template: FormTemplate): FormField[] {
  return template.sections.flatMap((s) => s.fields.filter((f) => f.required || f.priority === 'required'));
}

/**
 * 校验模板必填字段是否已填。
 * - 非重复段：校验 priority==='required' 或 required 字段（条件字段先判断显隐、非强调 checkbox 允许 false），
 *   并执行 pattern 正则 / min / max 数值范围校验；
 * - 重复段：跳过条目级校验（重复段完整性由 isPhaseCompletionSatisfied 阶段逻辑负责，与 personal 版行为一致）。
 *
 * @returns { valid, errors, missingFields } — missingFields 为字段标签数组，兼容旧版调用方
 */
export function validateRequiredFields(
  template: FormTemplate,
  formData: Record<string, unknown>
): { valid: boolean; errors: ValidationError[]; missingFields: string[] } {
  const errors: ValidationError[] = [];
  template.sections.forEach((section, sectionIndex) => {
    // 重复段跳过（阶段完成逻辑处理其完整性）
    if (section.repeatable) return;

    section.fields.forEach((field) => {
      const isRequired = field.required === true || field.priority === 'required';
      if (isRequired) {
        // 条件字段：条件不满足时视为隐藏，不参与必填校验
        if (field.condition) {
          const dependsOnValue = formData[field.condition.dependsOn];
          const showWhen = field.condition.showWhen;
          const isVisible = Array.isArray(showWhen)
            ? showWhen.includes('*')
              ? !!dependsOnValue && String(dependsOnValue).trim() !== ''
              : showWhen.includes(String(dependsOnValue))
            : dependsOnValue === showWhen;
          if (!isVisible) return;
        }
        // 普通复选框（非 emphasis）：false 是合法值
        if (field.type === 'checkbox' && !field.emphasis) return;
        if (isFieldEmpty(formData[field.id])) {
          errors.push({ fieldId: field.id, fieldLabel: field.label, sectionIndex });
        }
      }

      // 正则校验：非空字段配置了 pattern 时校验格式
      const pattern = field.validation?.pattern;
      if (pattern) {
        const value = formData[field.id];
        if (!isFieldEmpty(value) && typeof value === 'string') {
          if (!pattern.test(value.trim())) {
            errors.push({
              fieldId: field.id,
              fieldLabel: field.label,
              sectionIndex,
              message: field.validation?.patternMessage || '格式不正确',
            });
          }
        }
      }

      // 数值范围校验：按数值比较（text 字段的 RHF min 是字符串长度语义，这里统一按数值判断）
      const min = field.validation?.min;
      const max = field.validation?.max;
      if ((min !== undefined || max !== undefined) && !isFieldEmpty(formData[field.id])) {
        const num = Number(formData[field.id]);
        if (!isNaN(num)) {
          if (min !== undefined && num < min) {
            errors.push({ fieldId: field.id, fieldLabel: field.label, sectionIndex, message: `不能小于 ${min}` });
          } else if (max !== undefined && num > max) {
            errors.push({ fieldId: field.id, fieldLabel: field.label, sectionIndex, message: `不能大于 ${max}` });
          }
        }
      }
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    missingFields: errors.map((e) => e.fieldLabel),
  };
}

/** 计算表单填写完成度（百分比） */
export function calculateCompleteness(
  template: FormTemplate,
  data: Record<string, unknown>
): number {
  const allFields = template.sections.flatMap((s) => s.fields);
  if (allFields.length === 0) return 100;

  const filled = allFields.filter((f) => !isFieldEmpty(data[f.id])).length;
  return Math.round((filled / allFields.length) * 100);
}

/** 获取阶段对应的分区 */
export function getPhaseSections(
  template: FormTemplate,
  phaseIndex: number
): FormSection[] {
  const phase = template.phases?.[phaseIndex];
  if (!phase) return template.sections;
  return phase.sectionIndices.map((i) => template.sections[i]).filter(Boolean);
}

/** 获取指定 section 所属的阶段索引，找不到返回 -1 */
export function getSectionPhaseIndex(phases: PhaseConfig[], sectionIndex: number): number {
  for (let i = 0; i < phases.length; i++) {
    if (phases[i].sectionIndices.includes(sectionIndex)) return i;
  }
  return -1;
}

/**
 * 根据表单数据判断当前所处的阶段索引。
 * - 重复段：completionFields 为空时不强制；非空时要求至少一条条目满足全部完成字段；
 * - 时间锁：若下一阶段配置了 unlockAfterDays，按其参考日期（unlockAfterField 或记录创建时间）判断是否解锁。
 */
export function getCurrentPhaseIndex(
  phases: PhaseConfig[],
  formData: Record<string, unknown>,
  sections?: FormSection[],
  recordCreatedAt?: string
): number {
  const isValueFilled = (val: unknown): boolean =>
    val !== undefined && val !== null && val !== '' &&
    !(typeof val === 'string' && val.trim() === '') &&
    !(typeof val === 'boolean' && val === false);

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const repeatableSection = sections?.find((s, idx) => s.repeatable && phase.sectionIndices.includes(idx));

    if (repeatableSection) {
      const entries = readRepeatableEntries(formData, repeatableSection.id);
      // completionFields 为空 → 该阶段无强制完成项，跳过 entries 检查
      if (phase.completionFields.length > 0) {
        if (entries.length === 0) return i;
        const hasCompleteEntry = entries.some((entry) =>
          phase.completionFields.every((fieldId) => isValueFilled(entry[fieldId]))
        );
        if (!hasCompleteEntry) return i;
      }
    } else {
      const allComplete = phase.completionFields.every((fieldId) => isValueFilled(formData[fieldId]));
      if (!allComplete) return i;
    }

    // 时间锁检查：下一阶段配置了 unlockAfterDays 时判断是否已到期
    const nextPhase = phases[i + 1];
    if (nextPhase?.unlockAfterDays) {
      const unlockDays = nextPhase.unlockAfterDays;
      let referenceDate: Date | null = null;

      if (nextPhase.unlockAfterField) {
        const fieldValue = formData[nextPhase.unlockAfterField] as string | undefined;
        if (fieldValue && String(fieldValue).trim()) {
          const parsed = new Date(String(fieldValue));
          if (!isNaN(parsed.getTime())) referenceDate = parsed;
        }
      }
      // 配置了参考字段但尚未填写 → 保持该阶段锁定，避免未完成记录提前解锁
      if (!referenceDate && nextPhase.unlockAfterField) return i;
      // 回退到记录创建时间
      if (!referenceDate && recordCreatedAt) {
        const parsed = new Date(recordCreatedAt);
        if (!isNaN(parsed.getTime())) referenceDate = parsed;
      }

      if (referenceDate) {
        const today = new Date();
        const daysSince = Math.floor((today.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24));
        if (daysSince < unlockDays) return i;
      } else {
        return i; // 无参考日期 → 无法解锁下一阶段
      }
    }
  }
  return phases.length - 1; // 全部完成
}

/** 阶段时间锁 / 冷静期计算结果的完整信息 */
export interface PhaseTimeLockInfo {
  /** 时间锁解锁日期（无参考日期时为 9999，表示「待定」） */
  unlockDate: Date;
  /** 时间锁剩余天数 */
  daysRemaining: number;
  /** 是否处于时间锁中（unlockAfterDays 未到期） */
  isLocked: boolean;
  /** 是否处于冷静期中（activateAfterDays 未到期） */
  isCooldown: boolean;
  /** 冷静期剩余天数 */
  remainingDays: number;
}

/**
 * 计算某个阶段的时间锁（unlockAfterDays）与冷静期（activateAfterDays）状态。
 * @param phase 只需时间锁/冷静期相关字段（容忍 PhaseIndicator 的宽松阶段类型）
 * @returns 始终返回完整信息对象：isLocked / isCooldown 分别标记两种锁定状态。
 */
export function getPhaseTimeLockInfo(
  phase: Pick<PhaseConfig, 'unlockAfterDays' | 'unlockAfterField' | 'activateAfterDays' | 'activateAfterField'>,
  formData: Record<string, unknown>,
  recordCreatedAt?: string
): PhaseTimeLockInfo {
  const info: PhaseTimeLockInfo = {
    unlockDate: new Date(9999, 0, 1),
    daysRemaining: 0,
    isLocked: false,
    isCooldown: false,
    remainingDays: 0,
  };

  // --- 时间锁（unlockAfterDays）---
  if (phase.unlockAfterDays) {
    const unlockDays = phase.unlockAfterDays;
    let referenceDate: Date | null = null;

    if (phase.unlockAfterField) {
      const fieldValue = formData[phase.unlockAfterField] as string | undefined;
      if (fieldValue && String(fieldValue).trim()) {
        const parsed = new Date(String(fieldValue));
        if (!isNaN(parsed.getTime())) referenceDate = parsed;
      }
    }
    // 配置了参考字段但尚未填写 → 视为无限期锁定（解锁日期未知）
    if (!referenceDate && phase.unlockAfterField) {
      info.isLocked = true;
      info.daysRemaining = unlockDays;
      return info;
    }
    if (!referenceDate && recordCreatedAt) {
      const parsed = new Date(recordCreatedAt);
      if (!isNaN(parsed.getTime())) referenceDate = parsed;
    }
    if (!referenceDate) {
      info.isLocked = true;
      info.daysRemaining = unlockDays;
      return info;
    }

    const unlockDate = new Date(referenceDate.getTime() + unlockDays * 24 * 60 * 60 * 1000);
    const today = new Date();
    const daysRemaining = Math.ceil((unlockDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    info.unlockDate = unlockDate;
    info.daysRemaining = Math.max(0, daysRemaining);
    info.isLocked = daysRemaining > 0;
  }

  // --- 冷静期（activateAfterDays）---
  if (phase.activateAfterDays && phase.activateAfterField) {
    const fieldValue = formData[phase.activateAfterField] as string | undefined;
    if (fieldValue && String(fieldValue).trim()) {
      const parsed = new Date(String(fieldValue));
      if (!isNaN(parsed.getTime())) {
        const daysSince = Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24));
        const remainingDays = phase.activateAfterDays - daysSince;
        info.remainingDays = Math.max(0, remainingDays);
        info.isCooldown = remainingDays > 0;
      }
    }
  }

  return info;
}

function findFieldSection(
  template: FormTemplate,
  fieldId: string
): { section: FormSection; index: number } | undefined {
  for (let index = 0; index < template.sections.length; index++) {
    const section = template.sections[index];
    if (section.fields.some((f) => f.id === fieldId)) {
      return { section, index };
    }
  }
  return undefined;
}

/** 判断 table 类型字段是否有实际内容（至少有一个非零/非空值） */
function isTableFieldFilled(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.some((row) => {
    if (typeof row !== 'object' || row === null) return false;
    return Object.values(row as Record<string, unknown>).some((cell) => {
      if (typeof cell === 'number') return cell !== 0;
      if (typeof cell === 'string') return cell.trim() !== '';
      return cell !== undefined && cell !== null;
    });
  });
}

/**
 * 判断某个 completionFields 中列出的字段在当前数据下是否已满足：
 * - 非重复段：字段值非空（table 类型要求至少一个有效单元格）；
 * - 重复段：至少 minEntries 个条目的该字段非空（配置 stopAppendWhen 且已停止时降为 1 条）。
 */
export function isCompletionFieldSatisfied(
  template: FormTemplate,
  fieldId: string,
  values: Record<string, unknown>
): boolean {
  const found = findFieldSection(template, fieldId);
  if (!found) return false;
  const { section } = found;

  if (section.repeatable) {
    const entries = readRepeatableEntries(values, section.id);
    let minRequired = section.minEntries ?? 1;
    if (section.stopAppendWhen) {
      const { fieldId: stopFieldId, value: stopValue } = section.stopAppendWhen;
      const stopped = entries.some((entry) => entry[stopFieldId] === stopValue);
      if (stopped) minRequired = 1;
    }
    const filledCount = entries.filter((entry) => !isEmptyValue(entry[fieldId])).length;
    return filledCount >= minRequired;
  }

  const field = section.fields.find((f) => f.id === fieldId);
  if (field?.type === 'table') {
    if (!isTableFieldFilled(values[fieldId])) return false;
    if (field.validation?.min !== undefined) {
      // validation.min 视为「至少需要多少个有效单元格」
      const rows = Array.isArray(values[fieldId]) ? (values[fieldId] as unknown[]) : [];
      let validCellCount = 0;
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        for (const v of Object.values(row as Record<string, unknown>)) {
          if (typeof v === 'string') { if (v.trim()) validCellCount++; }
          else if (typeof v === 'number') { if (v !== 0 && !Number.isNaN(v)) validCellCount++; }
          else if (v !== undefined && v !== null) { validCellCount++; }
        }
      }
      return validCellCount >= field.validation.min;
    }
    return true;
  }

  return !isEmptyValue(values[fieldId]);
}

/** 判断某个阶段的所有 completionFields 是否已满足 */
export function isPhaseCompletionSatisfied(
  template: FormTemplate,
  phase: PhaseConfig,
  values: Record<string, unknown>
): boolean {
  return phase.completionFields.every((fieldId) => isCompletionFieldSatisfied(template, fieldId, values));
}

/**
 * 只校验当前阶段及其之前阶段涉及 section 的必填项（分阶段逐步校验）。
 * 用于「下一步/完成」等动作：不要求未来锁定阶段的字段现在就填。
 */
export function getScopedMissingFields(
  template: FormTemplate,
  values: Record<string, unknown>,
  activePhaseIndex: number
): ValidationError[] {
  const { errors } = validateRequiredFields(template, values);
  if (!template.phases || template.phases.length === 0) return errors;

  const accessibleIndices = new Set<number>();
  template.phases.slice(0, activePhaseIndex + 1).forEach((p) => {
    p.sectionIndices.forEach((i) => accessibleIndices.add(i));
  });
  return errors.filter((e) => accessibleIndices.has(e.sectionIndex));
}

/** 构建表单初始值（含 table / quadrant / dragMatrix 默认结构） */
export function buildInitialValues(template: FormTemplate): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const section of template.sections) {
    for (const field of section.fields) {
      if (field.type === 'table') {
        values[field.id] = Array.isArray(field.defaultValue) ? field.defaultValue : [{}];
      } else if (field.type === 'quadrant') {
        values[field.id] =
          field.defaultValue && typeof field.defaultValue === 'object'
            ? field.defaultValue
            : EMPTY_QUADRANT_MATRIX();
      } else if (field.type === 'dragMatrix') {
        values[field.id] =
          field.defaultValue && typeof field.defaultValue === 'object'
            ? field.defaultValue
            : EMPTY_DRAG_MATRIX();
      } else if (field.defaultValue !== undefined) {
        values[field.id] = resolveDefaultValue(field.defaultValue);
      }
    }
  }
  return values;
}
