/**
 * ConditionalField — 条件显隐字段容器（合并版）
 *
 * 由两个项目的同名组件合并而来：
 * - root-cause-analysis 版：支持 basePath 嵌套路径前缀（repeatable 分区内字段监听），
 *   通过 useFormContext().watch 实时监听，数组值匹配。
 * - personal_review_system 版：支持 '*' 通配符（被依赖字段值为任意非空值时命中）。
 *
 * 行为：
 * - 无 condition 配置 → 始终渲染 children（但仍无条件调用监听 Hook，保证 Hooks 顺序稳定）。
 * - 有 condition 配置 → 监听 `${basePath}${condition.dependsOn}` 字段的值：
 *   - showWhen 为数组 → 命中其中任意一个即可；
 *   - showWhen 含 '*' → 被监听值为任意非空值时命中；
 *   - 被监听值本身是数组（如多选 checkbox）→ 数组内任一元素命中即可。
 *
 * 用法：
 * - 在 FormProvider 内部（默认）：<ConditionalField condition={f.condition} basePath={basePath}>
 * - 需要显式传 control 时：<ConditionalField condition={f.condition} control={control}>
 * - 隐藏时 children 从表单上卸载，其值保留在表单值树中，重新出现时自动回填。
 */
import type { ReactNode } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import type { Control } from 'react-hook-form';
import type { FieldCondition } from '../../types';

/**
 * 判断"被依赖字段的当前值"value 是否命中 showWhen 配置。
 * - 数组值（多选 checkbox）：任一元素命中即满足；
 * - '*' 通配符：值为任意非空值即满足（空字符串/空数组/undefined/null 视为空）。
 */
function matchesCondition(value: unknown, showWhen: string | string[]): boolean {
  const targets = Array.isArray(showWhen) ? showWhen : [showWhen];
  if (targets.includes('*')) {
    return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
  }
  if (Array.isArray(value)) return value.some((v) => targets.includes(String(v)));
  return targets.includes(String(value));
}

export interface ConditionalFieldProps {
  /** 条件配置。dependsOn 指明监听哪个"兄弟字段"，showWhen 列出命中值；不传则始终展示 */
  condition?: FieldCondition;
  /** 被依赖字段在表单值树中的路径前缀（例如 'sectionId.' 或 'repeatId.0.'），默认空 */
  basePath?: string;
  /** 可选：显式传入 RHF control（组件不在 FormProvider 内时使用） */
  control?: Control;
  children: ReactNode;
}

export function ConditionalField({ condition, basePath = '', control, children }: ConditionalFieldProps) {
  const formContext = useFormContext();
  const name = condition ? `${basePath}${condition.dependsOn}` : '__unused__';
  // 注意：即使无 condition 也必须调用监听 Hook（传占位路径），保证 Hooks 调用次数稳定，
  // 否则条件字段的显示/隐藏切换会导致 Hook 顺序错乱。
  const watchedValue = useWatch({ control: control ?? formContext?.control, name });

  if (!condition) return <>{children}</>;
  if (!matchesCondition(watchedValue, condition.showWhen)) return null;
  return <>{children}</>;
}

export default ConditionalField;
