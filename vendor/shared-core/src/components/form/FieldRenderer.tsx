/**
 * 字段渲染器：根据字段类型分发到对应的输入组件
 * 增强自 personal_review_system / root-cause-analysis
 *
 * 通用能力：
 * - 错误提示透传（error prop + RHF formState.errors 双重来源）
 * - conditionalHints 条件提示（按 hintDependsOn 字段值切换文案，支持 URL 链接化与长文本折叠）
 * - computed 计算字段只读展示（含复制按钮）
 * - priority 推荐徽章（recommended → 「推荐完成」）
 * - datalist 自动补全（suggestions 透传）
 * - 受控 / 非受控 / name 三种模式：name 位于 FormProvider 内时用 useController 接管
 * - React.memo 避免无关字段重渲染
 */
import { memo, useState } from 'react';
import { useFormContext, useController } from 'react-hook-form';
import type { UseFormRegister, FieldValues } from 'react-hook-form';
import type { FormField } from '../../types';
import {
  TextInput,
  TextareaInput,
  NumberInput,
  DateInput,
  SelectInput,
  RadioInput,
  SingleCheckboxInput,
  CheckboxGroupInput,
  RatingInput,
  TableInput,
  QuadrantInput,
  DragMatrixInput,
  ComputedDisplay,
  buildValidationRules,
  type InputFieldProps,
} from './FieldInputs';

/** 计算字段的快速复制按钮：点击把生成内容复制到剪贴板 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 非安全上下文（如 http 环境）clipboard API 不可用时的降级方案
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-100"
    >
      {copied ? '已复制 ✓' : '复制'}
    </button>
  );
}

interface FieldRendererProps {
  field: FormField;
  /** RHF register（非受控模式） */
  register?: UseFormRegister<FieldValues>;
  /** 表单值路径（位于 FormProvider 内时用 useController 接管） */
  name?: string;
  /** 受控模式开关（true 时用 value/onChange） */
  controlled?: boolean;
  value?: unknown;
  onChange?: (value: unknown) => void;
  disabled?: boolean;
  /** 外部校验错误文案（如自定义必填校验） */
  error?: string;
  /** hintDependsOn 依赖字段的当前值（条件提示用） */
  watchedHintValue?: string;
  /** 当前已计算的计算字段值 */
  computedValue?: string;
  /** 动态选项（optionsFrom 生成，select / dragMatrix 用） */
  dynamicOptions?: { value: string; label: string }[];
  /** datalist 自动补全建议 */
  suggestions?: string[];
  /** 只读覆盖（字段级 field.readOnly 之外的强制只读） */
  readOnly?: boolean;
}

const baseInputClass =
  'w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition';
const errorTextClass = 'text-xs text-red-500 mt-1';

const FieldRendererImpl = memo(function FieldRenderer({
  field,
  register,
  name,
  controlled,
  value,
  onChange,
  disabled = false,
  error,
  watchedHintValue,
  computedValue,
  dynamicOptions,
  suggestions,
  readOnly,
}: FieldRendererProps) {
  const isOptional = field.priority === 'optional';
  const isRequired = field.required === true || field.priority === 'required';
  const labelClass = `block text-sm font-medium mb-1 ${isOptional ? 'text-slate-500' : 'text-slate-700'}`;
  const inputClass = `${baseInputClass} ${error ? 'border-red-500' : 'border-slate-300'}`;

  const isControlledType =
    field.type === 'checkbox' ||
    field.type === 'rating' ||
    field.type === 'table' ||
    field.type === 'quadrant' ||
    field.type === 'dragMatrix';

  // name 模式：位于 FormProvider 内时用 useController 受控接管（name 恒定，Hook 调用顺序稳定）
  const formContext = useFormContext();
  const useControllerMode = !!name && !controlled && !!formContext?.control;
  const { field: ctlField, fieldState: ctlState } = useControllerMode
    ? useController({ control: formContext!.control, name: name!, rules: buildValidationRules(field) })
    : { field: { value, onChange }, fieldState: { error: undefined } };

  const effectiveValue = useControllerMode ? ctlField.value : value;
  const effectiveOnChange = useControllerMode ? ctlField.onChange : onChange;
  const effectiveError = error ?? (ctlState.error ? (typeof ctlState.error.message === 'string' ? ctlState.error.message : undefined) : undefined);
  const effectiveDisabled = disabled || readOnly || field.readOnly;

  const isSingleCheckbox = field.type === 'checkbox' && (!field.options || field.options.length === 0);

  // Hint state（必须位于所有提前 return 之前，保证 Hooks 顺序稳定）
  const [hintExpanded, setHintExpanded] = useState(false);

  if (field.type === 'hidden') return null;

  // 计算字段：只读展示 + 复制按钮
  if (field.computed) {
    const displayValue = computedValue || '';
    const isError = displayValue === '__ERROR__';
    const placeholder = field.computed.placeholder || '自动计算';
    const errorText = field.computed.errorText || '无法计算';
    const displayContent = isError ? errorText : displayValue || placeholder;
    const stringResult = displayValue && !isError ? displayValue : '';
    return (
      <div className="space-y-1">
        <label className={labelClass}>
          {field.label}
          {(isRequired) && <span className="text-red-500 ml-1">*</span>}
        </label>
        <div className="flex items-start gap-2">
          <div className={`flex-1 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-sm ${isError ? 'text-red-500' : displayValue ? 'text-slate-900 font-medium' : 'text-slate-400'}`}>
            {displayContent}
          </div>
          {stringResult && <CopyButton text={stringResult} />}
        </div>
      </div>
    );
  }

  // 自动补全（datalist）
  const shouldAutocomplete = field.autocomplete === true && (field.type === 'text' || field.type === 'textarea');

  // 受控/非受控分发（显式 value/onChange 或受控类型一律走受控，其余走 register）
  const hasValueBridge = controlled || value !== undefined || !!onChange;
  const passControlled = hasValueBridge || useControllerMode || isControlledType;
  const commonInputProps: InputFieldProps = {
    field,
    inputClass,
    controlled: passControlled,
    value: effectiveValue,
    onChange: effectiveOnChange,
    disabled: effectiveDisabled,
    dynamicOptions,
    readOnly: effectiveDisabled,
    suggestions: shouldAutocomplete ? suggestions : undefined,
  };

  const renderField = () => {
    switch (field.type) {
      case 'text':
        return <TextInput {...commonInputProps} />;
      case 'textarea':
        return <TextareaInput {...commonInputProps} />;
      case 'number':
        return <NumberInput {...commonInputProps} />;
      case 'date':
      case 'datetime':
        return <DateInput {...commonInputProps} />;
      case 'select':
        return <SelectInput {...commonInputProps} />;
      case 'radio':
        return <RadioInput {...commonInputProps} />;
      case 'checkbox':
        return field.options && field.options.length > 0
          ? <CheckboxGroupInput {...commonInputProps} />
          : <SingleCheckboxInput {...commonInputProps} />;
      case 'rating':
        return <RatingInput {...commonInputProps} />;
      case 'table':
        return <TableInput {...commonInputProps} />;
      case 'quadrant':
        return <QuadrantInput {...commonInputProps} />;
      case 'dragMatrix':
        return <DragMatrixInput {...commonInputProps} />;
      default:
        return <TextInput {...commonInputProps} />;
    }
  };

  // 条件提示：hintDependsOn 字段值切换文案
  const effectiveHint = (field.conditionalHints && watchedHintValue && field.conditionalHints[watchedHintValue]) || field.hint;

  /** 把 hint 文本中的 http(s) 链接渲染为可点击链接（URL 结尾不含中英文括号/标点） */
  const renderHintText = (text: string) => {
    const parts = text.split(/(https?:\/\/[^\s（）()，,。；;]+)/g);
    return parts.map((part, i) =>
      /^https?:\/\//.test(part) ? (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="underline text-blue-500 hover:text-blue-700 break-all"
          onClick={(e) => e.stopPropagation()}
        >
          {part}
        </a>
      ) : part
    );
  };

  const renderHint = () => {
    if (!effectiveHint) return null;
    const hasUrl = /https?:\/\//.test(effectiveHint);
    const isLong = effectiveHint.length > 60 && !hasUrl;
    const displayText = isLong && !hintExpanded ? effectiveHint.slice(0, 60) + '...' : effectiveHint;
    const isConditional = !!(field.conditionalHints && watchedHintValue && field.conditionalHints[watchedHintValue]);

    return (
      <p className={`text-xs mt-1 italic ${isConditional ? 'text-blue-500' : 'text-slate-400'}`}>
        <span className="mr-1">{isConditional ? '🎯' : '💡'}</span>
        {renderHintText(displayText)}
        {isLong && (
          <button
            type="button"
            onClick={() => setHintExpanded(!hintExpanded)}
            className="ml-1 text-blue-400 hover:text-blue-600 underline"
          >
            {hintExpanded ? '收起' : '展开'}
          </button>
        )}
      </p>
    );
  };

  // 单布尔复选框特殊布局（label 自带文本，无需独立 label）
  if (isSingleCheckbox) {
    return (
      <div className="space-y-1.5">
        {renderField()}
        {effectiveHint && (
          <p className="text-xs text-slate-400 mt-1 italic pl-8">
            <span className="mr-1">💡</span>
            {effectiveHint}
          </p>
        )}
        {effectiveError && <p className={`${errorTextClass} pl-8`}>{effectiveError}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={field.id} className={labelClass}>
        {field.label}
        {isRequired && <span className="text-red-500 ml-1">*</span>}
        {field.priority === 'recommended' && (
          <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
            推荐完成
          </span>
        )}
        {isOptional && <span className="text-xs text-slate-400 font-normal">（可选）</span>}
      </label>
      {renderField()}
      {renderHint()}
      {effectiveError && <p className={errorTextClass}>{effectiveError}</p>}
    </div>
  );
});

FieldRendererImpl.displayName = 'FieldRenderer';

export const FieldRenderer = FieldRendererImpl;
