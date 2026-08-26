/**
 * useSearch — 通用全文搜索 hook（提取自 root-cause-analysis，已泛化）
 *
 * 基于 flexsearch 全文索引对任意列表做快速搜索：
 * - 泛化：原版 useSearchProblems 只支持 Problem（写死 title/problemStatement 字段），
 *   现改为接受任意 { id: string } 类型的条目，通过 getSearchText(item) 提取可搜索文本。
 * - flexsearch 先对所有文本建立倒排索引，搜索时不必逐条 includes 遍历，
 *   数据量大时远快于线性扫描。useRef 保存索引实例：跨渲染存活但不触发重渲染。
 *
 * 用法：
 *   const filtered = useSearch(records, query, (r) => `${r.title} ${r.data.description ?? ''}`);
 * query 为空时返回原列表。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Index as FlexSearchIndex } from 'flexsearch';

/**
 * 搜索任意条目列表。
 * @param items 全量条目列表（每条必须有 string 类型 id）
 * @param query 用户输入的关键词
 * @param getSearchText 提取某条目的可搜索文本（标题/描述等拼接）
 * @param limit 搜索结果上限，默认 100
 * @returns 过滤后的条目数组；query 为空时返回原列表
 */
export function useSearch<T extends { id: string }>(
  items: T[],
  query: string,
  getSearchText: (item: T) => string,
  limit = 100,
): T[] {
  // 用 ref 保存取文本函数，避免内联 lambda 导致索引反复重建
  const getTextRef = useRef(getSearchText);
  getTextRef.current = getSearchText;

  // 保存索引实例，跨渲染共享但不触发重渲染
  const indexRef = useRef<FlexSearchIndex | null>(null);
  // 搜索结果 id 集合；null 表示"无搜索词"，应返回全部
  const [resultIds, setResultIds] = useState<Set<string> | null>(null);

  // 第一个 useEffect：items 变化时重建索引（索引与数据强相关，数据一变就必须重建）
  useEffect(() => {
    const idx = new FlexSearchIndex({
      tokenize: 'forward', // 前缀切词，能匹配"根因"→"根因分析"
      resolution: 9,
    });
    for (const item of items) {
      // flexsearch 的 add 要求 id 是 number，这里把 string id 转成 number 再存
      idx.add(item.id as unknown as number, getTextRef.current(item));
    }
    indexRef.current = idx;
  }, [items]);

  // 第二个 useEffect：query 变化时执行搜索（只依赖 query，关键词不变则沿用上次结果）
  useEffect(() => {
    if (!query.trim()) {
      setResultIds(null);
      return;
    }
    const idx = indexRef.current;
    if (!idx) {
      setResultIds(null);
      return;
    }
    const ids = idx.search(query.trim(), { limit });
    setResultIds(new Set(ids.map(String)));
  }, [query, limit]);

  // 根据命中 id 集合过滤原始数组；resultIds 为 null（未搜索）时返回全部
  const filtered = useMemo(() => {
    if (resultIds === null) return items;
    return items.filter((item) => resultIds.has(item.id));
  }, [items, resultIds]);

  return filtered;
}

export default useSearch;
