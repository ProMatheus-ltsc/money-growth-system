/**
 * 备份与恢复页（UI-06 / F-07，06 T24）：
 * - 云端备份（R2，backup-worker 每日 01:00 全量，保留 30 份）：状态卡 + 列表 + 手动备份 + 逐份恢复
 * - 本地备份：下载全量 JSON（05 §3.26，附件流）；文件恢复「先校验后写入」（05 §3.27），
 *   非法拒绝且现有数据不变，合法二次确认后覆盖并全局刷新（F-07 规则 3）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@shared/core/hooks/useToast';
import { ConfirmDialog } from '@shared/core/components/ConfirmDialog';
import { CloudUpload, Download, HardDrive, RefreshCw } from 'lucide-react';
import { api, apiBlob, ApiError } from '../lib/api';
import { fmtBytes, fmtDateTime } from '../lib/format';
import type { BackupCounts, BackupListItem } from '../lib/types';

interface BackupPolicy {
  cron: string;
  retention: number;
}

export default function BackupPage() {
  const { showToast } = useToast();
  const [backups, setBackups] = useState<BackupListItem[]>([]);
  const [policy, setPolicy] = useState<BackupPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // 'manual' | key | 'import' | 'export'
  const [confirmRestore, setConfirmRestore] = useState<BackupListItem | null>(null);
  const [confirmImport, setConfirmImport] = useState<{ payload: unknown; summary: string } | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ backups: BackupListItem[]; policy: BackupPolicy }>('/api/backups');
      setBackups(res.backups);
      setPolicy(res.policy);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---------- 云端 ----------
  const manualBackup = async () => {
    setBusy('manual');
    try {
      const res = await api<{ key: string; sizeBytes: number; createdAt: string }>('/api/backups', { method: 'POST' });
      showToast(`手动备份完成：${res.key}（${fmtBytes(res.sizeBytes)}）`, 'success', 5000);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '备份失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const restoreCloud = async () => {
    if (!confirmRestore) return;
    const key = confirmRestore.key;
    setConfirmRestore(null);
    setBusy(key);
    try {
      const res = await api<{ restored: boolean; counts: BackupCounts }>('/api/backups/restore', { method: 'POST', body: { key } });
      showToast(`已从 ${key} 恢复（快照 ${res.counts.snapshots} 个月 / 负债 ${res.counts.debts} 项）`, 'success', 6000);
      await load();
    } catch (e) {
      const ae = e as ApiError;
      showToast(ae.details?.map((d) => d.message).join('；') ?? ae.message ?? '恢复失败（现有数据未变更）', 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  // ---------- 本地 ----------
  const downloadLocal = async () => {
    setBusy('export');
    try {
      const { blob, filename } = await apiBlob('/api/backups/export');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`本地备份已下载：${filename}`, 'success', 5000);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '下载失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const onFilePicked = async (file: File) => {
    setImportErrors([]);
    setBusy('import');
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as Record<string, unknown>;
      // 客户端预检（服务端仍会以同一校验器权威校验，05 §3.27）
      const problems: string[] = [];
      if (payload.schemaVersion !== 1) problems.push(`schemaVersion 应为 1（实际 ${String(payload.schemaVersion)}）`);
      for (const k of ['treeConfigs', 'catConfigs', 'debts', 'snapshots']) {
        if (!Array.isArray(payload[k])) problems.push(`缺少数组字段 ${k}`);
      }
      if (problems.length > 0) {
        setImportErrors(problems);
        showToast('文件预检未通过，现有数据未变更', 'error', 6000);
        return;
      }
      const snaps = (payload.snapshots as { month?: string }[]).length;
      const trees = (payload.treeConfigs as unknown[]).length;
      const summary = `含 ${trees} 个资产树配置版本、${(payload.catConfigs as unknown[]).length} 个分类配置版本、${(payload.debts as unknown[]).length} 项负债、${snaps} 个月度快照。恢复将全量覆盖现有业务数据（账号不受影响）。`;
      setConfirmImport({ payload, summary });
    } catch {
      setImportErrors(['文件不是合法 JSON，已拒绝（现有数据未变更）。']);
      showToast('文件不是合法 JSON，已拒绝', 'error');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const doImport = async () => {
    if (!confirmImport) return;
    const payload = confirmImport.payload;
    setConfirmImport(null);
    setBusy('import');
    try {
      const res = await api<{ restored: boolean; counts: BackupCounts }>('/api/backups/import', { method: 'POST', body: { payload } });
      showToast(`恢复成功（快照 ${res.counts.snapshots} 个月 / 报表 ${res.counts.reportSnapshots} 份 / AI ${res.counts.aiAnalyses} 条），即将刷新页面`, 'success', 6000);
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      const ae = e as ApiError;
      if (ae.details && ae.details.length > 0) setImportErrors(ae.details.map((d) => `${d.field}：${d.message}`));
      else setImportErrors([ae.message ?? '恢复失败']);
      showToast('备份文件校验失败，现有数据未变更', 'error', 6000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">备份与恢复</h2>
        <p className="mt-0.5 text-xs text-slate-400">云端每日自动备份（R2）+ 本地 JSON 手动备份，双保险（F-07）</p>
      </div>

      {/* 云端备份状态卡 */}
      <section className="card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1 text-sm font-semibold text-slate-800">
            <CloudUpload size={15} className="text-blue-600" /> 云端备份（自动）
          </h3>
          <button onClick={() => void manualBackup()} disabled={busy !== null} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy === 'manual' ? <RefreshCw size={12} className="animate-spin" /> : null} {busy === 'manual' ? '备份中…' : '立即手动备份'}
          </button>
        </div>
        {policy && (
          <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            策略：{policy.cron} 全量备份 · 保留最近 {policy.retention} 份 · 恢复前自动校验（非法即拒绝）
          </p>
        )}
        {loading ? (
          <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
        ) : backups.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">尚未生成云端备份（可点击右上角手动备份）。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-3 py-2 font-medium">备份对象</th>
                  <th className="px-3 py-2 text-right font-medium">大小</th>
                  <th className="px-3 py-2 font-medium">生成时间</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.key} className="border-b border-slate-50 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">{b.key}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums">{fmtBytes(b.sizeBytes)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{fmtDateTime(b.createdAt)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setConfirmRestore(b)}
                        disabled={busy !== null}
                        className="rounded-lg bg-slate-100 px-3 py-1 text-xs text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                      >
                        {busy === b.key ? '恢复中…' : '从此恢复'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 本地备份 */}
      <section className="card">
        <h3 className="mb-3 flex items-center gap-1 text-sm font-semibold text-slate-800">
          <HardDrive size={15} className="text-emerald-600" /> 本地备份（JSON）
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => void downloadLocal()} disabled={busy !== null} className="flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            <Download size={14} /> {busy === 'export' ? '导出中…' : '下载全量备份'}
          </button>
          <button onClick={() => fileRef.current?.click()} disabled={busy !== null} className="flex items-center gap-1 rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {busy === 'import' ? '校验中…' : '从文件恢复…'}
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFilePicked(f); }} />
        </div>
        <p className="mt-2 text-xs text-slate-400">
          下载内容含资产树与分类配置版本、全部月度快照、负债、报告快照与 AI 记录（不含账号信息、不加密，Q2 定论）。恢复先校验后写入：非法文件拒绝且现有数据不变。
        </p>
        {importErrors.length > 0 && (
          <div className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
            <p className="mb-1 font-medium">恢复被拒绝（现有数据未变更）：</p>
            <ul className="list-inside list-disc space-y-0.5">
              {importErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmRestore !== null}
        title="从云端备份恢复"
        message={confirmRestore ? `将用 ${confirmRestore.key} 全量覆盖现有业务数据（账号不受影响）。确认继续？` : ''}
        confirmText="恢复"
        variant="warning"
        onConfirm={() => void restoreCloud()}
        onCancel={() => setConfirmRestore(null)}
      />
      <ConfirmDialog
        open={confirmImport !== null}
        title="从本地文件恢复"
        message={confirmImport?.summary ?? ''}
        confirmText="覆盖恢复"
        variant="warning"
        onConfirm={() => void doImport()}
        onCancel={() => setConfirmImport(null)}
      />
    </div>
  );
}
