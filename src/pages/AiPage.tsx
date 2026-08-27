/**
 * AI 分析页（UI-07 / F-09 导出 + F-10 导入，06 T24）：
 * - 四分区数据包导出（## 数据 / ## 提示词 / ## 结果格式 / ## 示例），一键复制，不含身份信息（F-09）
 * - AI 结果 JSON 导入：schema 逐字段校验（日期格式/必填/优先级 高中低/中文字段名），不符逐条列出（F-10）
 * - 历史记录：可展开建议表、删除（二次确认，ConfirmDialog；RecordList 经 PATCHES #2 注入确认回调）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@shared/core/hooks/useToast';
import { ConfirmDialog } from '@shared/core/components/ConfirmDialog';
import RecordList from '../adapters/shared/RecordList';
import type { FormRecord } from '@shared/core/types';
import { ChevronDown, ChevronRight, Copy, Sparkles, Upload } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type { AiRecord, SnapshotsListData } from '../lib/types';
import { useAuth } from '../adapters/shared/useAuth';

export default function AiPage() {
  const { showToast } = useToast();
  const { role } = useAuth();
  const isViewer = role === 'viewer';

  // ---- 导出（F-09） ----
  const [months, setMonths] = useState<string[]>([]);
  const [exportMonth, setExportMonth] = useState('');
  const [exportText, setExportText] = useState('');
  const [exporting, setExporting] = useState(false);

  // ---- 导入（F-10） ----
  const [importText, setImportText] = useState('');
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);

  // ---- 历史 ----
  const [records, setRecords] = useState<AiRecord[]>([]);
  const [filterMonth, setFilterMonth] = useState('');
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<AiRecord | null>(null);

  const loadMonths = useCallback(async () => {
    try {
      const res = await api<SnapshotsListData>('/api/snapshots', { query: { range: 'all' } });
      const ms = res.months.map((m) => m.month);
      setMonths(ms);
      if (ms.length > 0) setExportMonth(ms[ms.length - 1]);
    } catch {
      /* 无快照 */
    }
  }, []);

  const loadRecords = useCallback(async () => {
    setLoadingRecords(true);
    try {
      const res = await api<{ list: AiRecord[] }>('/api/ai/analyses', { query: filterMonth ? { month: filterMonth } : {} });
      setRecords(res.list);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败', 'error');
    } finally {
      setLoadingRecords(false);
    }
  }, [filterMonth, showToast]);

  useEffect(() => {
    void loadMonths();
  }, [loadMonths]);
  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  const handleExport = async () => {
    if (!exportMonth) {
      showToast('请选择月份', 'warning');
      return;
    }
    setExporting(true);
    setExportText('');
    try {
      const res = await api<{ month: string; text: string }>('/api/ai/export', { query: { month: exportMonth } });
      setExportText(res.text);
      showToast('四分区数据包已生成，可一键复制', 'success');
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.message ?? '导出失败', 'error', 5000);
    } finally {
      setExporting(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportText);
      showToast('已复制到剪贴板', 'success');
    } catch {
      showToast('复制失败，请手动选择文本复制', 'warning');
    }
  };

  const handleImport = async () => {
    setImportErrors([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      setImportErrors(['不是合法 JSON，请先修正格式。']);
      return;
    }
    setImporting(true);
    try {
      const res = await api<{ id: number; analysisDate: string; assetMonth: string }>('/api/ai/analyses', { method: 'POST', body: parsed });
      showToast(`已保存（关联 ${res.assetMonth}），记录 #${res.id}`, 'success');
      setImportText('');
      await loadRecords();
    } catch (e) {
      const ae = e as ApiError;
      if (ae.details && ae.details.length > 0) {
        setImportErrors(ae.details.map((d) => `${d.field}：${d.message}`));
      } else {
        setImportErrors([ae.message ?? '导入失败']);
      }
    } finally {
      setImporting(false);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    try {
      await api(`/api/ai/analyses/${confirmDelete.id}`, { method: 'DELETE' });
      showToast('已删除 AI 记录', 'success');
      setConfirmDelete(null);
      await loadRecords();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败', 'error');
      setConfirmDelete(null);
    }
  };

  // RecordList 需要 FormRecord[]
  const formRecords: FormRecord[] = useMemo(
    () =>
      records.map((r) => ({
        id: String(r.id),
        templateId: 'ai-analysis',
        title: `${r.assetMonth} 财务分析（${r.suggestionCount} 条建议）`,
        data: r.payload,
        status: 'completed',
        createdAt: r.createdAt,
        updatedAt: r.createdAt,
      })),
    [records]
  );

  const recordById = useMemo(() => new Map(records.map((r) => [String(r.id), r])), [records]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">AI 分析</h2>
        <p className="mt-0.5 text-xs text-slate-400">
          {isViewer ? 'AI 生成的资产配置建议与历史分析记录' : '导出四分区数据包 → 粘贴给外部 AI → 将结果 JSON 导入（零直连，复制-粘贴模式）'}
        </p>
      </div>

      {!isViewer && (
        <div className="grid gap-4 xl:grid-cols-2">
          {/* ============ 导出（F-09） ============ */}
          <section className="card">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-1 text-sm font-semibold text-slate-800">
                <Sparkles size={15} className="text-blue-600" /> ① 导出财务数据包（四分区）
              </h3>
            </div>
            {months.length === 0 ? (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">尚无资产快照，请先在「月末录入」页录入数据再导出（F-09 规则 3）。</p>
            ) : (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <select value={exportMonth} onChange={(e) => setExportMonth(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" aria-label="导出月份">
                    {months.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => void handleExport()} disabled={exporting} className="btn-primary">
                    {exporting ? '生成中…' : '生成清单'}
                  </button>
                  {exportText && (
                    <button onClick={() => void handleCopy()} className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                      <Copy size={14} /> 一键复制
                    </button>
                  )}
                </div>
                {exportText && (
                  <textarea
                    readOnly
                    value={exportText}
                    rows={16}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs outline-none"
                    aria-label="四分区数据包"
                  />
                )}
              </>
            )}
          </section>

          {/* ============ 导入（F-10） ============ */}
          <section className="card">
            <h3 className="mb-3 flex items-center gap-1 text-sm font-semibold text-slate-800">
              <Upload size={15} className="text-emerald-600" /> ② 导入 AI 结果（schema 校验）
            </h3>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={12}
              placeholder={'粘贴外部 AI 返回的 JSON，例如：\n{"analysisDate":"2026-08-20","assetMonth":"2026-08","suggestions":[{"type":"配置优化","module":"消费基金","current":"…","plan":"…","reason":"…","priority":"高"}]}'}
              className="mb-3 w-full rounded-lg border border-slate-300 p-3 font-mono text-xs outline-none focus:border-blue-500"
              aria-label="AI 结果 JSON"
            />
            {importErrors.length > 0 && (
              <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                <p className="mb-1 font-medium">schema 校验未通过，未保存：</p>
                <ul className="list-inside list-disc space-y-0.5">
                  {importErrors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            <button onClick={() => void handleImport()} disabled={importing || !importText.trim()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              {importing ? '校验并保存中…' : '校验并保存'}
            </button>
          </section>
        </div>
      )}

      {/* ============ 历史 / 浏览者按优先级分类展示 ============ */}
      {isViewer ? (
        <ViewerAiResults records={records} loadingRecords={loadingRecords} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />
      ) : (
        <section className="card">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">③ 历史分析记录（{records.length}）</h3>
            <select value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs outline-none focus:border-blue-500" aria-label="按月份过滤">
              <option value="">全部月份</option>
              {[...new Set(records.map((r) => r.assetMonth))].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          {loadingRecords ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-slate-100" />
              ))}
            </div>
          ) : records.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-6 text-center text-xs text-slate-400">暂无 AI 分析记录。</p>
          ) : (
            <div className="space-y-2">
              <RecordList
                records={formRecords}
                formatDate={(iso) => fmtDateTime(iso)}
                onEdit={(id) => {
                  const num = Number(id);
                  setExpanded((s) => {
                    const n = new Set(s);
                    if (n.has(num)) n.delete(num);
                    else n.add(num);
                    return n;
                  });
                }}
                onDelete={(id) => {
                  const rec = recordById.get(id);
                  if (rec) setConfirmDelete(rec);
                }}
                confirmDelete={() => true}
              />
              {records.filter((r) => expanded.has(r.id)).map((r) => (
                <SuggestionTable key={`detail-${r.id}`} record={r} />
              ))}
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="删除 AI 记录"
        message={confirmDelete ? `确定删除 ${confirmDelete.assetMonth} 的 AI 分析记录吗？关联的报告快照将不再展示其正文。` : ''}
        confirmText="删除"
        variant="danger"
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/** 浏览者专用：按优先级分类展示 AI 建议，高优先级展开，中低折叠 */
function ViewerAiResults({ records, loadingRecords, filterMonth, setFilterMonth }: { records: AiRecord[]; loadingRecords: boolean; filterMonth: string; setFilterMonth: (v: string) => void }) {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set(['中', '低']));

  const allSuggestions = useMemo(() => {
    return records.flatMap((r) => (r.payload.suggestions ?? []).map((s) => ({ ...s, assetMonth: r.assetMonth, createdAt: r.createdAt })));
  }, [records]);

  const grouped = useMemo(() => {
    const high = allSuggestions.filter((s) => s.priority === '高');
    const medium = allSuggestions.filter((s) => s.priority === '中');
    const low = allSuggestions.filter((s) => s.priority !== '高' && s.priority !== '中');
    return { '高': high, '中': medium, '低': low };
  }, [allSuggestions]);

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  if (loadingRecords) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    );
  }

  if (records.length === 0) {
    return <div className="card"><p className="rounded-lg bg-slate-50 px-3 py-6 text-center text-xs text-slate-400">暂无 AI 分析记录。</p></div>;
  }

  const priorityConfig: Record<string, { label: string; color: string; border: string; bg: string }> = {
    '高': { label: '高优先级建议', color: 'text-red-600', border: 'border-red-200', bg: 'bg-red-50/50' },
    '中': { label: '中优先级建议', color: 'text-amber-600', border: 'border-amber-200', bg: 'bg-amber-50/50' },
    '低': { label: '低优先级建议', color: 'text-slate-500', border: 'border-slate-200', bg: 'bg-slate-50/50' },
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">共 {allSuggestions.length} 条建议（来自 {records.length} 次分析）</p>
        <select value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs outline-none focus:border-blue-500" aria-label="按月份过滤">
          <option value="">全部月份</option>
          {[...new Set(records.map((r) => r.assetMonth))].map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {(['高', '中', '低'] as const).map((priority) => {
        const items = grouped[priority];
        if (items.length === 0) return null;
        const cfg = priorityConfig[priority];
        const isCollapsed = collapsedSections.has(priority);
        return (
          <section key={priority} className={`rounded-xl border ${cfg.border} ${cfg.bg} overflow-hidden`}>
            <button
              onClick={() => toggleSection(priority)}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-white/30 transition-colors"
            >
              <span className={`flex items-center gap-2 text-sm font-semibold ${cfg.color}`}>
                <PriorityBadge priority={priority} />
                {cfg.label}（{items.length}）
              </span>
              {isCollapsed ? <ChevronRight size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
            </button>
            {!isCollapsed && (
              <div className="overflow-x-auto px-4 pb-3">
                <table className="w-full min-w-[640px] text-xs">
                  <thead>
                    <tr className="text-left text-slate-400">
                      {['建议类型', '目标模块', '当前配置', '建议方案', '理由', '关联月份'].map((h) => (
                        <th key={h} className="px-2 py-1.5 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((s, i) => (
                      <tr key={i} className="border-t border-slate-100 align-top">
                        <td className="px-2 py-1.5">{s.type}</td>
                        <td className="px-2 py-1.5 font-medium">{s.module}</td>
                        <td className="px-2 py-1.5">{s.current}</td>
                        <td className="px-2 py-1.5">{s.plan}</td>
                        <td className="px-2 py-1.5 text-slate-500">{s.reason}</td>
                        <td className="px-2 py-1.5 text-slate-400">{s.assetMonth}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function SuggestionTable({ record }: { record: AiRecord }) {
  const suggestions = record.payload.suggestions ?? [];
  return (
    <div className="animate-fadeIn overflow-x-auto rounded-lg border border-blue-100 bg-blue-50/30 p-3">
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="text-left text-slate-400">
            {['建议类型', '目标模块', '当前配置', '建议方案', '理由', '优先级'].map((h) => (
              <th key={h} className="px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {suggestions.map((s, i) => (
            <tr key={i} className="border-t border-blue-100/50 align-top">
              <td className="px-2 py-1.5">{s.type}</td>
              <td className="px-2 py-1.5">{s.module}</td>
              <td className="px-2 py-1.5">{s.current}</td>
              <td className="px-2 py-1.5">{s.plan}</td>
              <td className="px-2 py-1.5">{s.reason}</td>
              <td className="px-2 py-1.5">
                <PriorityBadge priority={s.priority} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const cls = priority === '高' ? 'bg-red-50 text-red-600' : priority === '中' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500';
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{priority}</span>;
}
