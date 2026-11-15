/**
 * REST AuthDriver —— 实现 @shared/core 统一认证的 AuthDriver 接口。
 *
 * 接入本项目的服务端权威认证（backend/routes/auth.ts）：
 *  - 挂载探测：有效令牌 → GET /api/auth/me 恢复会话（含角色）
 *  - 无令牌：以 init 端点探测初始化状态（users 空→400 参数错误 ⇒ firstTime；已初始化→409 ⇒ login）
 *  - firstTime：登录页渲染首次初始化表单 → POST /api/auth/init（双账号）→ reload → login
 *  - login：POST /api/auth/login（签发 token 本地保存）
 *  - logout：POST /api/auth/logout（幂等；失败吞掉）
 *
 * 本项目保留 Bearer token 传输（而不是 HttpOnly Cookie）：
 * 运维脚本 scripts/smoke-online.mjs 等非浏览器客户端需要用
 * `Authorization: Bearer <token>` 访问 API，Cookie 对它们不适用。
 * 这是本项目对统一契约的**显式偏离**，在此说明。
 */
import type { AuthDriver, AuthUser } from '@shared/core/auth';
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

/** 统一 AuthUser：id 用用户名（本项目 users.id 是整数，外部以用户名标识） */
function toUser(username: string, role: string): AuthUser {
  return {
    id: username,
    username,
    extra: { role },
  };
}

/**
 * 初始化状态探测（无副作用）：空参数调用 init 端点——
 * 服务端先校验 users 表为空再校验参数：
 *  - 未初始化 → 400 INVALID_PARAM（参数校验，说明可初始化）⇒ 这是首次使用
 *  - 已初始化 → 409 CONFLICT「系统已完成初始化」
 *
 * 结果会缓存：共享包的 AuthProvider 启动时先 restore（失败）再问 isFirstTime，
 * 两次探测问的是同一件事，不必重复打服务端。初始化完成后由 reload 触发刷新。
 */
let firstTimeCache: boolean | null = null;

async function probeIsFirstTime(): Promise<boolean> {
  if (firstTimeCache !== null) return firstTimeCache;
  try {
    await api('/api/auth/init', { method: 'POST', body: {}, auth: false });
    firstTimeCache = false; // 防御：空参数不应成功
  } catch (e) {
    firstTimeCache = (e as { status?: number })?.status === 400;
  }
  return firstTimeCache;
}

/** 首次初始化完成（users 表非空）后刷新缓存 */
export function invalidateFirstTimeCache(): void {
  firstTimeCache = null;
}

// 邀请码门控 token（LoginPage 验证邀请码后设置，login 时携带）
let _gateToken: string | null = null;
export function setGateToken(token: string | null) {
  _gateToken = token;
}
export function getGateToken() {
  return _gateToken;
}

export const restAuthDriver: AuthDriver = {
  async restore() {
    const token = getToken();
    if (!token) return null;
    try {
      const me = await api<MeData>('/api/auth/me');
      return toUser(me.username, me.role);
    } catch {
      clearToken();
      return null;
    }
  },

  async isFirstTime() {
    return probeIsFirstTime();
  },

  async login(credential) {
    const data = await api<LoginData>('/api/auth/login', {
      method: 'POST',
      body: { username: credential.username, password: credential.password, gateToken: _gateToken },
      auth: false,
    });
    setToken(data.token);
    _gateToken = null;
    return toUser(data.username, data.role);
  },

  // 本项目未开放自助注册（服务端已删除 /api/auth/register）。
  // 不实现 register，共享包会给出「当前系统未开放自助注册」的提示。

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
