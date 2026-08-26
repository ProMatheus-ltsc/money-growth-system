import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@shared/core/hooks/useToast';
import PasswordInput from '@shared/core/components/PasswordInput';
import { ConfirmDialog } from '@shared/core/components/ConfirmDialog';
import { api } from '../lib/api';
import { isValidPassword, isValidUsername } from '../lib/validate';
import { UserPlus, Trash2, Shield, Eye } from 'lucide-react';

interface UserInfo {
  id: number;
  username: string;
  role: string;
  created_at: string;
}

export default function UsersPage() {
  const { showToast } = useToast();
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  // CR-024：删除二次确认统一 ConfirmDialog（原 window.confirm）
  const [confirmDelete, setConfirmDelete] = useState<UserInfo | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      const data = await api<UserInfo[]>('/api/auth/users');
      setUsers(data);
    } catch {
      showToast('获取用户列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: string[] = [];
    if (!isValidUsername(username)) errs.push('用户名须为 3~20 个字母/数字/下划线');
    if (!isValidPassword(password)) errs.push('密码须为 8~64 字符');
    if (errs.length > 0) {
      showToast(errs.join('；'), 'error');
      return;
    }
    setBusy(true);
    try {
      await api('/api/auth/create-viewer', {
        method: 'POST',
        body: { username: username.trim(), password },
      });
      showToast(`浏览者账户 "${username.trim()}" 创建成功`, 'success');
      setUsername('');
      setPassword('');
      setShowForm(false);
      await fetchUsers();
    } catch (err) {
      const e2 = err as { message?: string };
      showToast(e2.message ?? '创建失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (u: UserInfo) => {
    setConfirmDelete(null);
    try {
      await api(`/api/auth/users/${u.id}`, { method: 'DELETE' });
      showToast(`用户 "${u.username}" 已删除`, 'success');
      await fetchUsers();
    } catch (err) {
      const e2 = err as { message?: string };
      showToast(e2.message ?? '删除失败', 'error');
    }
  };

  if (loading) return <div className="p-6 text-center text-slate-500">加载中…</div>;

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">用户管理</h1>
          <p className="mt-1 text-sm text-slate-500">管理系统用户，创建浏览者账户</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="btn-primary flex items-center gap-1.5 px-3 py-2 text-sm"
        >
          <UserPlus size={16} />
          创建浏览者
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">创建浏览者账户</h3>
          <p className="mb-4 text-xs text-slate-500">浏览者仅可查看报表与导出 PDF，无法录入或修改数据。</p>
          <form onSubmit={handleCreate} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">用户名</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="3~20 个字母/数字/下划线"
                className="input-field"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">密码</label>
              <PasswordInput
                value={password}
                onChange={setPassword}
                showPassword={showPw}
                onToggleVisibility={() => setShowPw(!showPw)}
                placeholder="8~64 字符"
                maxLength={64}
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={busy} className="btn-primary px-4 py-2 text-sm">
                {busy ? '创建中…' : '确认创建'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="btn-secondary px-4 py-2 text-sm">
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-700">全部用户（{users.length}）</h3>
        </div>
        <ul className="divide-y divide-slate-100">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-3">
                <div className={`flex h-8 w-8 items-center justify-center rounded-full ${u.role === 'admin' ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>
                  {u.role === 'admin' ? <Shield size={16} /> : <Eye size={16} />}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-800">{u.username}</p>
                  <p className="text-xs text-slate-400">
                    {u.role === 'admin' ? '管理员' : '浏览者'} · 创建于 {u.created_at.slice(0, 10)}
                  </p>
                </div>
              </div>
              {u.role !== 'admin' && (
                <button
                  onClick={() => setConfirmDelete(u)}
                  className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                  title="删除用户"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="删除用户"
        message={confirmDelete ? `确定要删除用户 "${confirmDelete.username}" 吗？此操作不可撤销。` : ''}
        confirmText="删除"
        variant="danger"
        onConfirm={() => { if (confirmDelete) void doDelete(confirmDelete); }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
