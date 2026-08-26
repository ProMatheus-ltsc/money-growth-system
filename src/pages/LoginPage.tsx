/**
 * 登录页（UI-01 / F-01，06 T17）：
 * - 首次运行（users 空，驱动探测 → firstTime）：初始化管理员 + 只读双账号（05 §3.1）
 * - 登录：错误保留账号输入、清空密码、显示失败原因（PRD F-01 规则 1）；
 *   加载态按钮禁用（03 §5.2 约 0.4s）；423 锁定提示透传。
 * - PasswordInput 复用 shared-core（04 §3.9 行 1）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/core/hooks/useAuth';
import { useToast } from '@shared/core/hooks/useToast';
import PasswordInput from '@shared/core/components/PasswordInput';
import { LoadingSpinner } from '@shared/core/components/LoadingSpinner';
import { Lock } from 'lucide-react';
import { api } from '../lib/api';
import { isValidPassword, isValidUsername } from '../lib/validate';
import { setGateToken } from '../adapters/auth/restAuthDriver';

export default function LoginPage() {
  const { state } = useAuth();
  if (state === 'loading') return <LoadingSpinner message="初始化中…" />;
  if (state === 'firstTime') return <InitForm />;
  return <LoginForm />;
}

function Shell({ children, subtitle }: { children: React.ReactNode; subtitle: string }) {
  return (
    <div className="flex min-h-screen">
      {/* 左侧品牌区 */}
      <div className="hidden lg:flex lg:w-[55%] bg-gradient-to-br from-[#1a2332] to-[#2d3748] items-center justify-center p-12 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <svg viewBox="0 0 400 400" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
            <path d="M50 350 Q100 200 150 250 Q200 150 250 180 Q300 100 350 50" fill="none" stroke="white" strokeWidth="2" />
            <path d="M50 380 Q120 280 180 300 Q240 220 300 200 Q340 160 380 100" fill="none" stroke="white" strokeWidth="1.5" strokeDasharray="4 4" />
          </svg>
        </div>
        <div className="relative z-10 text-center max-w-sm">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-400 to-cyan-400 shadow-xl shadow-blue-500/30">
            <Lock size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-3">资产增长系统</h1>
          <p className="text-blue-200/80 text-sm leading-relaxed">记录每一笔，见证家庭财富成长</p>
        </div>
      </div>
      {/* 右侧表单区 */}
      <div className="flex flex-1 items-center justify-center bg-[#f0f4f8] px-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center lg:text-left">
            <div className="lg:hidden mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-400 to-cyan-400 shadow-lg">
              <Lock size={22} className="text-white" />
            </div>
            <h2 className="text-xl font-bold text-slate-800 lg:text-2xl">欢迎回来</h2>
            <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)]">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      {children}
    </div>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="input-field"
    />
  );
}

// ---------------- 邀请码验证 + 登录表单 ----------------

function LoginForm() {
  const { login, error, reload } = useAuth();
  const navigate = useNavigate();

  // 邀请码门控状态
  const [gateTokenLocal, setGateTokenLocal] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  // 登录表单状态
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inviteBusy) return;
    setInviteError(null);
    if (!inviteCode.trim()) {
      setInviteError('请输入邀请码');
      return;
    }
    setInviteBusy(true);
    try {
      const res = await api('/api/auth/verify-invite', {
        method: 'POST',
        auth: false,
        body: { code: inviteCode.trim() },
      });
      const gt = (res as { gateToken: string }).gateToken;
      setGateToken(gt);
      setGateTokenLocal(gt);
    } catch (err) {
      const e2 = err as { message?: string; status?: number };
      if (e2.status === 423) {
        setInviteError('验证次数过多，请稍后再试');
      } else {
        setInviteError(e2.message ?? '邀请码不正确');
      }
      setInviteCode('');
    } finally {
      setInviteBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setLocalError(null);
    if (!username.trim() || !password) {
      setLocalError('请输入用户名和密码');
      return;
    }
    setBusy(true);
    const start = Date.now();
    const ok = await login(username.trim(), password);
    const wait = Math.max(0, 400 - (Date.now() - start));
    await new Promise((r) => setTimeout(r, wait));
    setBusy(false);
    if (ok) {
      navigate('/', { replace: true });
    } else {
      setPassword('');
    }
  };

  // 未通过邀请码验证：显示邀请码输入
  if (!gateTokenLocal) {
    return (
      <Shell subtitle="请输入邀请码以继续">
        <form onSubmit={handleInviteSubmit} noValidate>
          <Field label="邀请码">
            <TextInput
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="请输入邀请码"
              autoComplete="off"
              autoFocus
              maxLength={20}
            />
          </Field>

          {inviteError && (
            <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
              {inviteError}
            </div>
          )}

          <button
            type="submit"
            disabled={inviteBusy}
            className="btn-primary w-full py-3"
          >
            {inviteBusy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
            {inviteBusy ? '验证中…' : '验证'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-400">
          仅受邀用户可使用本系统
        </p>
      </Shell>
    );
  }

  // 已通过邀请码验证：显示登录表单
  return (
    <Shell subtitle="登录后开始记录家庭资产增长">
      <form onSubmit={handleSubmit} noValidate>
        <Field label="用户名">
          <TextInput
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="请输入用户名"
            autoComplete="username"
            autoFocus
          />
        </Field>
        <Field label="密码">
          <PasswordInput
            value={password}
            onChange={setPassword}
            showPassword={showPassword}
            onToggleVisibility={() => setShowPassword(!showPassword)}
            placeholder="请输入密码"
            maxLength={64}
          />
        </Field>

        {(localError || error) && (
          <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            {localError ?? error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="btn-primary w-full py-3"
        >
          {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
          {busy ? '登录中…' : '登录'}
        </button>
      </form>

      <p className="mt-4 text-center text-xs text-slate-400">
        如需开通账号，请联系管理员
      </p>

      <details className="mt-3 text-xs text-slate-400">
        <summary className="cursor-pointer select-none hover:text-slate-600">首次使用？初始化账号</summary>
        <p className="mt-2 leading-relaxed">
          若系统尚未初始化，将自动进入初始化界面；也可
          <button
            type="button"
            className="mx-1 text-blue-600 underline"
            onClick={() => void reload()}
          >
            重新检测
          </button>
          初始化状态。
        </p>
      </details>
    </Shell>
  );
}

// ---------------- 首次初始化表单（05 §3.1） ----------------

function InitForm() {
  const { reload } = useAuth();
  const { showToast } = useToast();
  const [form, setForm] = useState({
    adminUsername: 'admin',
    adminPassword: '',
    viewerUsername: 'viewer',
    viewerPassword: '',
  });
  const [showPw, setShowPw] = useState({ admin: false, viewer: false });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const validate = (): string[] => {
    const errs: string[] = [];
    if (!isValidUsername(form.adminUsername)) errs.push('管理员用户名须为 3~20 个字母/数字/下划线');
    if (!isValidPassword(form.adminPassword)) errs.push('管理员密码须为 8~64 字符');
    if (!isValidUsername(form.viewerUsername)) errs.push('只读账号用户名须为 3~20 个字母/数字/下划线');
    if (!isValidPassword(form.viewerPassword)) errs.push('只读账号密码须为 8~64 字符');
    if (form.adminUsername === form.viewerUsername) errs.push('只读账号用户名不得与管理员相同');
    return errs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs = validate();
    setErrors(errs);
    if (errs.length > 0) return;
    setBusy(true);
    try {
      await api('/api/auth/init', {
        method: 'POST',
        auth: false,
        body: {
          admin: { username: form.adminUsername, password: form.adminPassword },
          viewer: { username: form.viewerUsername, password: form.viewerPassword },
        },
      });
      showToast('初始化成功，请使用管理员账号登录', 'success');
      await reload(); // users 非空 → 状态机进入 login
    } catch (err) {
      const e2 = err as { message?: string; details?: { field: string; message: string }[] };
      setErrors(e2.details?.map((d) => `${d.field}: ${d.message}`) ?? [e2.message ?? '初始化失败']);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell subtitle="首次运行：设置管理员与只读两个账号（仅一次）">
      <form onSubmit={handleSubmit} noValidate>
        <p className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700">
          管理员可录入与管理全部数据；只读账号仅可查看报表与导出 PDF。账号设置后不可再经此端点修改。
        </p>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">管理员账号</div>
        <Field label="管理员用户名">
          <TextInput value={form.adminUsername} onChange={(e) => set('adminUsername')(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="管理员密码">
          <PasswordInput
            value={form.adminPassword}
            onChange={set('adminPassword')}
            showPassword={showPw.admin}
            onToggleVisibility={() => setShowPw((s) => ({ ...s, admin: !s.admin }))}
            maxLength={64}
            placeholder="8~64 字符"
          />
        </Field>
        <div className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">只读账号</div>
        <Field label="只读账号用户名">
          <TextInput value={form.viewerUsername} onChange={(e) => set('viewerUsername')(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="只读账号密码">
          <PasswordInput
            value={form.viewerPassword}
            onChange={set('viewerPassword')}
            showPassword={showPw.viewer}
            onToggleVisibility={() => setShowPw((s) => ({ ...s, viewer: !s.viewer }))}
            maxLength={64}
            placeholder="8~64 字符"
          />
        </Field>

        {errors.length > 0 && (
          <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            <ul className="list-inside list-disc space-y-0.5">
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="btn-primary w-full py-3"
        >
          {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
          {busy ? '初始化中…' : '完成初始化'}
        </button>
      </form>
    </Shell>
  );
}
