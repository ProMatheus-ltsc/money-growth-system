/**
 * 可重复分区组件：支持动态添加/删除条目
 * 增强自 personal_review_system / root-cause-analysis
 *
 * 通用能力：
 * - 条目折叠展开 + 折叠预览摘要（标题含日期 + 状态 + 计算值）
 * - 撤销删除（带二次确认，删除后可撤销）
 * - computed 条目计算（formula + externalDeps，依赖值从 externalContext props 注入）
 * - 条目内条件字段（entry 级 condition 判断）
 * - stopAppendWhen 停止追加 / minEntries 最小条目
 * - 默认展开最后一条（含异步回填历史数据场景）
 * - table / quadrant / dragMatrix 新条目的默认值
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { FormSection, FormField } from '../../types';
import { FieldRenderer } from './FieldRenderer';
import { EMPTY_QUADRANT_MATRIX, EMPTY_DRAG_MATRIX } from '../../utils/formValidation';

interface RepeatableEntry {
  [fieldId: string]: unknown;
}

interface RepeatableSectionProps {
  section: FormSection;
  entries: RepeatableEntry[];
  onChange: (entries: RepeatableEntry[]) => void;
  disabled?: boolean;
  /** 条目 computed 字段 externalDeps 的数据源（props 注入，剥离业务耦合） */
  externalContext?: Record<string, unknown>;
}

export function RepeatableSection({
  section,
  entries,
  onChange,
  disabled = false,
  externalContext,
}: RepeatableSectionProps) {
  const computedFields = useMemo(() => section.fields.filter((f) => f.computed), [section.fields]);

  // 默认展开最后一条；无条目时全部折叠
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(() => {
    if (entries.length === 0) return new Set();
    return new Set([entries.length - 1]);
  });

  // entries 可能在挂载后异步加载（初始为空数组，随后回填历史数据），
  // 用 effect 补一次「首次拿到非空数据时展开最后一条」
  const hasInitializedRef = useRef(entries.length > 0);
  useEffect(() => {
    if (!hasInitializedRef.current && entries.length > 0) {
      hasInitializedRef.current = true;
      setExpandedIndices(new Set([entries.length - 1]));
    }
  }, [entries.length]);

  // 删除二次确认 + 撤销
  const [deleteConfirmIdx, setDeleteConfirmIdx] = useState<number | null>(null);
  const [trash, setTrash] = useState<{ entry: RepeatableEntry; index: number } | null>(null);
  const trashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (trashTimerRef.current) clearTimeout(trashTimerRef.current);
    };
  }, []);

  const toggleExpand = useCallback((index: number) => {
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  /** 撤销删除：把 trash 中条目插回原位 */
  const undoDelete = useCallback(() => {
    if (!trash) return;
    if (trashTimerRef.current) clearTimeout(trashTimerRef.current);
    const next = [...entries];
    const insertAt = Math.min(trash.index, next.length);
    next.splice(insertAt, 0, trash.entry);
    onChange(next);
    setTrash(null);
  }, [trash, entries, onChange]);

  const handleAddEntry = useCallback(() => {
    const newEntry: RepeatableEntry = {};
    const now = new Date();
    section.fields.forEach((f) => {
      if (f.type === 'table') {
        newEntry[f.id] = [{}];
      } else if (f.type === 'quadrant') {
        newEntry[f.id] = EMPTY_QUADRANT_MATRIX();
      } else if (f.type === 'dragMatrix') {
        newEntry[f.id] = EMPTY_DRAG_MATRIX();
      } else if (f.defaultValue !== undefined) {
        if (f.defaultValue === 'today' || f.defaultValue === 'auto_today') {
          newEntry[f.id] = now.toISOString().slice(0, 10);
        } else {
          newEntry[f.id] = f.defaultValue;
        }
      }
      if (f.autoTimestamp) {
        newEntry[f.id] = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      }
    });
    const newEntries = [...entries, newEntry];
    onChange(newEntries);
    // 展开新增条目
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      next.add(newEntries.length - 1);
      return next;
    });
  }, [entries, onChange, section.fields]);

  const handleDeleteEntry = useCallback(
    (index: number) => {
      const deletedEntry = entries[index];
      setTrash({ entry: deletedEntry, index });
      onChange(entries.filter((_, i) => i !== index));
      setDeleteConfirmIdx(null);
      // 调整展开索引（删除位之后的条目索引前移）
      setExpandedIndices((prev) => {
        const next = new Set<number>();
        prev.forEach((i) => {
          if (i < index) next.add(i);
          else if (i > index) next.add(i - 1);
        });
        return next;
      });
      // 5 秒后不可再撤销
      if (trashTimerRef.current) clearTimeout(trashTimerRef.current);
      trashTimerRef.current = setTimeout(() => setTrash(null), 5000);
    },
    [entries, onChange]
  );

  const handleFieldChange = useCallback(
    (entryIndex: number, fieldId: string, value: unknown) => {
      const newEntries = [...entries];
      newEntries[entryIndex] = { ...newEntries[entryIndex], [fieldId]: value };
      onChange(newEntries);
    },
    [entries, onChange]
  );

  /** 条目标题：日期字段 + 序号 */
  const getEntryTitle = (entry: RepeatableEntry, index: number): string => {
    const dateField = section.fields.find((f) => f.type === 'date');
    const dateValue = dateField ? (entry[dateField.id] as string) : undefined;
    const dateStr = dateValue ? ` - ${dateValue}` : '';
    return `第${index + 1}条${dateStr}`;
  };

  /** 条目内条件字段判断（entry 级，非 RHF） */
  const isFieldVisible = (field: FormField, entry: RepeatableEntry): boolean => {
    if (!field.condition) return true;
    const dependsOnValue = entry[field.condition.dependsOn];
    const showWhen = field.condition.showWhen;
    if (Array.isArray(showWhen)) {
      return showWhen.includes('*') ? !!dependsOnValue : showWhen.includes(String(dependsOnValue));
    }
    return dependsOnValue === showWhen;
  };

  const computeValueForField = useCallback(
    (field: FormField, entry: RepeatableEntry): string | undefined => {
      if (!field.computed) return undefined;
      const values: Record<string, unknown> = {};
      field.computed.dependsOn.forEach((dep) => {
        values[dep] = entry[dep];
      });
      if (field.computed.externalDeps && externalContext) {
        field.computed.externalDeps.forEach((dep) => {
          values[dep] = externalContext[dep];
        });
      }
      const result = field.computed.formula(values);
      return typeof result === 'string' ? result : undefined;
    },
    [externalContext]
  );

  /** 折叠预览摘要：前 2 个已填的 select/radio 值 + 计算值 */
  const getEntrySummary = useCallback(
    (entry: RepeatableEntry): string => {
      const parts: string[] = [];
      const statusFields = section.fields.filter((f) => (f.type === 'radio' || f.type === 'select') && entry[f.id]);
      statusFields.slice(0, 2).forEach((f) => {
        const val = entry[f.id] as string;
        if (val) {
          const option = f.options?.find((o) => o.value === val);
          parts.push(option ? option.label : val);
        }
      });
      computedFields.forEach((f) => {
        const cv = computeValueForField(f, entry);
        if (cv && parts.length < 3) parts.push(cv);
      });
      return parts.join(' · ');
    },
    [section.fields, computedFields, computeValueForField]
  );

  const renderEntryField = (field: FormField, entry: RepeatableEntry, entryIndex: number) => {
    if (!isFieldVisible(field, entry)) return null;

    const fieldKey = `${section.id}_${entryIndex}_${field.id}`;
    const computedValue = computeValueForField(field, entry);

    return (
      <div key={fieldKey} className="mb-3">
        <FieldRenderer
          field={field}
          value={entry[field.id]}
          onChange={(val) => handleFieldChange(entryIndex, field.id, val)}
          computedValue={computedValue}
          disabled={disabled}
          controlled
        />
      </div>
    );
  };

  // 检查是否应停止追加
  const shouldStop = section.stopAppendWhen
    ? entries.some((entry) => entry[section.stopAppendWhen!.fieldId] === section.stopAppendWhen!.value)
    : false;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-700">
          {section.title}
          <span className="ml-2 text-xs text-slate-400 font-normal">({entries.length} 条)</span>
        </h4>
        {!disabled && !shouldStop && (
          <button
            type="button"
            onClick={handleAddEntry}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
          >
            <span className="text-sm leading-none">+</span>
            {section.repeatLabel ?? '添加'}
          </button>
        )}
      </div>

      {section.description && (
        <p className="text-xs text-slate-500">{section.description}</p>
      )}

      {entries.length === 0 && (
        <div className="text-center py-8 text-slate-400 text-sm border-2 border-dashed border-slate-200 rounded-lg">
          {section.repeatLabel ? `暂无记录，点击「${section.repeatLabel}」添加` : '暂无记录，点击上方按钮添加'}
        </div>
      )}

      <div className="space-y-2">
        {entries.map((entry, index) => {
          const isExpanded = expandedIndices.has(index);
          const title = getEntryTitle(entry, index);
          const summary = getEntrySummary(entry);
          return (
            <div key={index} className="border border-slate-200 rounded-lg overflow-hidden bg-white shadow-sm">
              {/* 条目头 */}
              <div
                className="flex items-center justify-between px-4 py-3 bg-slate-50 cursor-pointer hover:bg-slate-100 transition"
                onClick={() => toggleExpand(index)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-slate-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                  <span className="font-medium text-sm text-slate-800 truncate">{title}</span>
                  {!isExpanded && summary && (
                    <span className="text-xs text-slate-400 truncate ml-2">{summary}</span>
                  )}
                </div>

                {/* 删除按钮（二次确认） */}
                {!disabled && (
                  <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                    {deleteConfirmIdx === index ? (
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-red-500">确认删除？</span>
                        <button
                          type="button"
                          onClick={() => handleDeleteEntry(index)}
                          className="text-xs px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600 transition"
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmIdx(null)}
                          className="text-xs px-2 py-1 bg-slate-200 text-slate-600 rounded hover:bg-slate-300 transition"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmIdx(index)}
                        className="text-slate-400 hover:text-red-500 transition p-1"
                        title="删除此记录"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* 条目内容 */}
              {isExpanded && (
                <div className="px-4 py-4 grid gap-3 sm:grid-cols-2">
                  {section.fields.map((field) =>
                    field.type === 'textarea' || field.type === 'table'
                      ? (
                        <div key={`${section.id}_${index}_${field.id}`} className="sm:col-span-2">
                          {renderEntryField(field, entry, index)}
                        </div>
                      )
                      : renderEntryField(field, entry, index)
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 撤销删除横幅 */}
      {trash && !disabled && (
        <div className="flex items-center justify-between px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
          <span className="text-xs text-amber-700">已删除一条记录</span>
          <button
            type="button"
            onClick={undoDelete}
            className="text-xs font-medium text-amber-700 underline hover:text-amber-900"
          >
            撤销
          </button>
        </div>
      )}
    </div>
  );
}
