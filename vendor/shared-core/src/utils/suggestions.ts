/**
 * 自动补全建议服务
 *
 * 数据来源：从用户的历史复盘记录中提取字段值，为表单填写提供快速补全建议。
 * 匹配逻辑：根据 fieldId 从所有历史记录中提取对应字段的非空字符串值，
 * 去重后按时间近远返回最近的 10 个唯一值。
 *
 * 提取来源：personal_review_system/src/services/suggestions.ts
 * 适配说明：原实现调用的是项目私有的 getAllRecords(templateId)；
 * 公共包 db 拆分成了 getAllRecords()（全量）与 getRecordsByTemplate(templateId)（按模板过滤），
 * 这里按 templateId 是否有值选择对应 API。公共包 db 返回的记录未保证按 updatedAt 排序，
 * 故在提取前显式按 updatedAt 降序排序，保证"最近使用的在前"。
 */
import { getAllRecords, getRecordsByTemplate } from '../services/db';

/**
 * 获取指定字段的自动补全建议值
 *
 * 从历史记录中提取对应字段的非空字符串值，去重后返回最多 10 个。
 * 结果按时间近远排序（最近使用的在前）。
 *
 * @param fieldId - 要获取建议的字段 ID
 * @param templateId - 可选，限定在特定模板的记录中查找
 * @returns 去重后的历史值数组（最多 10 个，最近使用的在前）
 */
export async function getFieldSuggestions(
  fieldId: string,
  templateId?: string
): Promise<string[]> {
  const records = templateId ? await getRecordsByTemplate(templateId) : await getAllRecords();
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const values = records
    .map((r) => r.data[fieldId])
    .filter((v) => v && typeof v === 'string' && (v as string).trim().length > 0) as string[];

  // Deduplicate and return most recent first (records are sorted by updatedAt desc)
  const unique = [...new Set(values)];
  return unique.slice(0, 10);
}
