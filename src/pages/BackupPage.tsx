/**
 * 备份与恢复页（UI-06 / F-07，06 T24，V1.4 移除 R2 后仅本地备份）：
 * - 本地备份：下载全量 JSON（05 §3.26，附件流）；文件恢复「先校验后写入」（05 §3.27），
 *   非法拒绝且现有数据不变，合法二次确认后覆盖并全局刷新（F-07 规则 3）
 * - 云端备份（R2）已下线（2026-08-27，用户不需要 R2）：请自行下载 JSON 留档。
 */
import { useRef, useState } from 'react';
import { useToast } from '@shared/core/hooks/useToast';
import { ConfirmDialog } from '@shared/core/components/ConfirmDialog';
import { Download, HardDrive, RefreshCw, AlertTriangle } from 'lucide-react';
import { api, apiBlob, ApiError } from '../lib/api';
import type { BackupCounts } from '../lib/types';

export default function BackupPage() {
  const { showToast } = useToast();
  const [busy, setBusy] = useState<string | null>(null); // 'import' | 'export'
  const [confirmImport, setConfirmImport] = useState<{ payload: unknown; summary: string } | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
      const summary = `含 ${trees} 个资产树配置版本、${(payload.catConfigs as unknown[]).length} 个分类配置版本、${(payload.debts as unknown[]).length} 项负债、${snaps} 个月度快照。恢复将全量覆盖现有业务数据（账号不受影响）。建议恢复前先下载一份当前数据留档。`;
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
        <p className="mt-0.5 text-xs text-slate-400">本地 JSON 手动备份（V1.4 起云端自动备份已下线）</p>
      </div>

      {/* 云端备份下线提示 */}
      <section className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
        <p className="flex items-center gap-1.5 font-medium">
          <AlertTriangle size={14} /> 云端自动备份已下线（2026-08-27）
        </p>
        <p className="mt-1">请定期「下载全量备份」保存到本地留档；重要操作前也建议先下载一份。恢复时系统会先校验文件合法性，非法文件不影响现有数据。</p>
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
            {busy === 'import' ? <RefreshCw size={14} className="animate-spin" /> : null}
            {busy === 'import' ? '校验中…' : '从文件恢复…'}
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFilePicked(f); }} />
        </div>
        <p className="mt-2 text-xs text-slate-400">
          下载内容含资产树与分类配置版本、全部月度快照、负债、报告快照与 AI 记录（不含账号信息、不加密，Q2 定论；不含折旧/重估/或有负债/健康配置扩展表，恢复后需重新录入）。恢复先校验后写入：非法文件拒绝且现有数据不变。
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
