import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useToast } from '@shared/core/hooks/useToast';
import PasswordInput from '@shared/core/components/PasswordInput';
import { Lock } from 'lucide-react';
import { api } from '../lib/api';
import { isValidPassword, isValidUsername } from '../lib/validate';

export default function RegisterPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [inviteCode, setInviteCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const validate = (): string[] => {
    const errs: string[] = [];
    if (!inviteCode.trim()) errs.push('请输入邀请码');
    if (!isValidUsername(username)) errs.push('用户名须为 3~20 个字母/数字/下划线');
    if (!isValidPassword(password)) errs.push('密码须为 8~64 字符');
    if (password !== confirmPassword) errs.push('两次输入的密码不一致');
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
      await api('/api/auth/register', {
        method: 'POST',
        auth: false,
        body: { inviteCode: inviteCode.trim(), username: username.trim(), password },
      });
      showToast('注册成功，请登录', 'success');
      navigate('/login', { replace: true });
    } catch (err) {
      const e2 = err as { message?: string; details?: { field: string; message: string }[] };
      setErrors(e2.details?.map((d) => `${d.field}: ${d.message}`) ?? [e2.message ?? '注册失败']);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen">
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
      <div className="flex flex-1 items-center justify-center bg-[#f0f4f8] px-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center lg:text-left">
            <div className="lg:hidden mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-400 to-cyan-400 shadow-lg">
              <Lock size={22} className="text-white" />
            </div>
            <h2 className="text-xl font-bold text-slate-800 lg:text-2xl">创建账号</h2>
            <p className="mt-1 text-sm text-slate-500">需要邀请码才能注册</p>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)]">
            <form onSubmit={handleSubmit} noValidate>
              <div className="mb-3">
                <label className="mb-1 block text-sm font-medium text-slate-700">邀请码</label>
                <input
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  placeholder="请输入邀请码"
                  autoComplete="off"
                  autoFocus
                  maxLength={20}
                  className="input-field"
                />
              </div>
              <div className="mb-3">
                <label className="mb-1 block text-sm font-medium text-slate-700">用户名</label>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="3~20 个字母/数字/下划线"
                  autoComplete="username"
                  className="input-field"
                />
              </div>
              <div className="mb-3">
                <label className="mb-1 block text-sm font-medium text-slate-700">密码</label>
                <PasswordInput
                  value={password}
                  onChange={setPassword}
                  showPassword={showPassword}
                  onToggleVisibility={() => setShowPassword(!showPassword)}
                  placeholder="8~64 字符"
                  maxLength={64}
                />
              </div>
              <div className="mb-3">
                <label className="mb-1 block text-sm font-medium text-slate-700">确认密码</label>
                <PasswordInput
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  showPassword={showConfirm}
                  onToggleVisibility={() => setShowConfirm(!showConfirm)}
                  placeholder="再次输入密码"
                  maxLength={64}
                />
              </div>

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
                {busy ? '注册中…' : '注册'}
              </button>
            </form>

            <p className="mt-4 text-center text-xs text-slate-400">
              已有账号？
              <Link to="/login" className="ml-1 text-blue-600 hover:underline">返回登录</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
