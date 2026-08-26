/**
 * REST AuthDriver（04 §3.9 行 1 / 06 T16）：
 * shared-core useAuth 四态机（loading/firstTime/login/authenticated）接到本项目
 * 服务端权威认证（05 §3.1~§3.4）。经 vendor useAuth 的 AuthDriver 注入点（PATCHES.md #1）接入。
 *
 *  - 挂载探测：有效令牌 → GET /api/auth/me 恢复会话（含角色）
 *  - 无令牌：以 init 端点探测初始化状态（users 空→400 参数错误 ⇒ firstTime；已初始化→409 ⇒ login）
 *  - firstTime：登录页渲染首次初始化表单 → POST /api/auth/init（双账号）→ reload → login
 *  - login：POST /api/auth/login（签发 token 本地保存）
 *  - logout：POST /api/auth/logout（幂等；失败吞掉）
 */
import type { AuthDriver, AuthDriverAccount } from '../shared/useAuth';
import { api, clearToken, getToken, setToken } from '../../lib/api';

interface MeData {
  username: string;
  role: 'admin' | 'viewer';
}

interface LoginData {
  token: string;
  username: string;
  role: 'admin' | 'viewer';
  expiresAt: string;
}

function toAccount(username: string, role: string): AuthDriverAccount {
  return {
    id: username,
    username,
    role,
    // 服务端权威：本地不持有口令材料，占位字段满足上游 Account 类型
    passwordHash: '',
    salt: '',
    createdAt: new Date().toISOString(),
  };
}

/**
 * 初始化状态探测（无副作用）：空参数调用 §3.1 init——
 * 服务端先校验 users 表为空再校验参数：
 *  - 未初始化 → 400 INVALID_PARAM（参数校验，说明可初始化）
 *  - 已初始化 → 409 CONFLICT「系统已完成初始化」
 */
async function probeHasAccounts(): Promise<boolean> {
  try {
    await api('/api/auth/init', { method: 'POST', body: {}, auth: false });
    return true; // 防御：空参数不应成功
  } catch (e) {
    return (e as { status?: number })?.status !== 400;
  }
}

// 邀请码门控 token（LoginPage 验证邀请码后设置，login 时携带）
let _gateToken: string | null = null;
export function setGateToken(token: string | null) { _gateToken = token; }
export function getGateToken() { return _gateToken; }

export const restAuthDriver: AuthDriver = {
  async probe() {
    const token = getToken();
    if (token) {
      try {
        const me = await api<MeData>('/api/auth/me');
        return { account: toAccount(me.username, me.role), hasAccounts: true };
      } catch {
        clearToken();
      }
    }
    return { account: null, hasAccounts: await probeHasAccounts() };
  },

  async login(username, password) {
    const data = await api<LoginData>('/api/auth/login', {
      method: 'POST',
      body: { username, password, gateToken: _gateToken },
      auth: false,
    });
    setToken(data.token);
    _gateToken = null;
    return toAccount(data.username, data.role);
  },

  async logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // 幂等：令牌失效等情况同样视为登出成功
    } finally {
      clearToken();
    }
  },
};
