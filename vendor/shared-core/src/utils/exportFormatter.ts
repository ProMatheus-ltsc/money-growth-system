/**
 * 导出字段格式化器：把"字段存储值"统一转换为"可读展示文本"，供 Markdown 导出等场景复用。
 *
 * 提取来源：
 * - personal_review_system/src/services/exportMarkdown.ts（select/radio/checkbox/date/number 的 label 反查与空值处理）
 * - root-cause-analysis/src/services/exportMarkdown.ts（optionLabel 多选合并、table 渲染、checkbox 开关语义）
 *
 * 适配说明：
 * - 合并两个版本的字段格式化逻辑，签名统一为 formatFieldValue(value, field)（值在前）；
 * - 剥离业务象限矩阵（quadrant/dragMatrix）与百分比等业务性字段名映射，
 *   无法识别的类型一律以 String(value) 兜底返回；
 * - 不确定的映射（如数值字段按 validation.max === 100 显示百分号）保留为通用启发式。
 */
import type { FormField, FormRecord } from '../types';

/** Markdown 导出中"未填写"的统一占位文本 */
export const EMPTY_TEXT = '（未填写）';

/** 判断字段值是否为空（null/undefined/空串/空数组） */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/** 将 ISO 日期字符串格式化为中文日期（如「2024年3月15日」）；无法解析时原样返回 */
export function formatDateText(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * select/radio/checkbox 的 option value → label 反查。
 * 多选（数组）时每个元素都转成 label，再用"、"连接；找不到匹配的 option 就原样字符串兜底。
 */
function optionLabel(field: FormField, value: unknown): string {
  const options = field.options ?? [];
  if (Array.isArray(value)) {
    return value.map((v) => options.find((o) => o.value === v)?.label ?? String(v)).join('、');
  }
  return options.find((o) => o.value === value)?.label ?? String(value);
}

/**
 * table 类型字段渲染为 Markdown 表格。
 * 空表或没有列定义时返回占位文本；全空的行会被过滤掉。
 */
function formatTable(field: FormField, value: unknown): string {
  if (!Array.isArray(value)) return EMPTY_TEXT;
  const columns = field.tableColumns ?? [];
  if (columns.length === 0) return EMPTY_TEXT;

  const rows = value.filter((row) =>
    columns.some((col) => String((row as Record<string, unknown>)?.[col.id] ?? '').trim() !== '')
  );
  if (rows.length === 0) return EMPTY_TEXT;

  const header = '| ' + columns.map((col) => col.label).join(' | ') + ' |';
  const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body = rows.map(
    (row) => '| ' + columns.map((col) => String((row as Record<string, unknown>)?.[col.id] ?? '')).join(' | ') + ' |'
  );
  return [header, separator, ...body].join('\n');
}

/**
 * 字段值 → 可读展示文本（核心格式化入口）。
 * 覆盖类型：select/radio（label 反查）、checkbox（数组多选 / 布尔开关）、
 * date/datetime（中文日期）、number（百分比启发式）、textarea/text（原文）、
 * table（Markdown 表格）、rating（星级展示）；其余类型 String(value) 兜底。
 *
 * @param value 字段存储值
 * @param field 字段定义（提供 options / tableColumns / validation 等格式化所需的元信息）
 */
export function formatFieldValue(value: unknown, field: FormField): string {
  if (isEmptyValue(value)) return EMPTY_TEXT;

  switch (field.type) {
    case 'select':
    case 'radio':
      return optionLabel(field, value);
    case 'checkbox':
      // 有选项的是多选（数组 → label 合并）；无选项的是布尔开关 → 是/否
      if (field.options) return optionLabel(field, value);
      return value ? '是' : '否';
    case 'date':
    case 'datetime':
      return formatDateText(String(value));
    case 'number':
      // 百分比启发式：字段校验上限为 100 时按百分比展示
      if (field.validation?.max === 100) return `${value}%`;
      return String(value);
    case 'textarea':
    case 'text':
      return String(value);
    case 'table':
      return formatTable(field, value);
    case 'rating': {
      const n = typeof value === 'number' ? value : Number(value);
      if (isNaN(n)) return String(value);
      const stars = Math.max(0, Math.min(5, Math.round(n)));
      return `${'★'.repeat(stars)} ${n}`;
    }
    default:
      return String(value);
  }
}

/**
 * 生成记录展示标题：优先取记录 title，其次模板名，最后回退占位文案。
 * 对应两项目导出实现中的「record.title || template.name」逻辑。
 *
 * @param record 记录对象（只读取 title）
 * @param templateName 记录所属模板名（记录无标题时的回退）
 */
export function formatRecordTitle(
  record: Pick<FormRecord, 'title'> | null | undefined,
  templateName?: string
): string {
  const title = record?.title?.trim();
  return title || templateName || '未命名记录';
}

// === Markdown 行辅助函数 ===

/** Markdown 标题：mdHeading('标题', 2) → '## 标题' */
export function mdHeading(text: string, level = 1): string {
  return `${'#'.repeat(Math.max(1, level))} ${text}`;
}

/** 字段行：mdFieldLine('状态', '已完成') → '**状态**: 已完成' */
export function mdFieldLine(label: string, content: string): string {
  return `**${label}**: ${content}`;
}
