/**
 * 认证 Hook + Provider：管理登录/注册/登出状态机
 * 可配置版本 - 各项目通过 configureDB 设置不同的数据库前缀
 *
 * PATCHES #1（family-asset-growth-tracker 适配）：AuthDriver 注入扩展
 * - 新增可选 AuthDriver（probe/login/logout）注入点：消费方可接入服务端权威认证
 *   （本项目注入 REST 驱动，见 src/adapters/auth/restAuthDriver.ts）；
 * - 未注入 driver 时保持上游 IndexedDB 本地认证行为完全不变；
 * - 上下文新增 role（account?.role，用于只读/管理员角色路由）与 reload
 *   （首次初始化完成后刷新状态机进入 login）。
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Account } from '../types';
import { setCurrentAccountId, listAccounts, getDBPrefix } from '../services/db';
import { registerAccount, verifyAccountPassword, resetAccountPassword } from '../services/auth';

type AuthState = 'loading' | 'firstTime' | 'login' | 'authenticated';

/** AuthDriver 账号：Account + 角色（本地驱动下角色缺省 admin） */
export interface AuthDriverAccount extends Account {
  role: string;
}

/** AuthDriver 契约：服务端权威认证的最小注入点（探测/登录/登出） */
export interface AuthDriver {
  probe: () => Promise<{ account: AuthDriverAccount | null; hasAccounts: boolean }>;
  login: (username: string, password: string) => Promise<AuthDriverAccount>;
  logout: () => Promise<void>;
}

interface AuthContextType {
  state: AuthState;
  account: Account | null;
  role: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  register: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  resetPassword: (username: string, newPassword: string) => Promise<boolean>;
  reload: () => Promise<void>;
  error: string | null;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({
  children,
  driver,
}: {
  children: React.ReactNode;
  /** 可选认证驱动：注入后走服务端权威认证（PATCHES #1） */
  driver?: AuthDriver;
}) {
  const [state, setState] = useState<AuthState>('loading');
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);

  const SESSION_KEY = `${getDBPrefix()}-current-account`;

  /** driver 模式：探测会话/初始化状态 */
  const initWithDriver = useCallback(async () => {
    const res = await driver!.probe();
    if (res.account) {
      setAccount(res.account);
      setRole(res.account.role);
      setState('authenticated');
    } else {
      setAccount(null);
      setRole(null);
      setState(res.hasAccounts ? 'login' : 'firstTime');
    }
  }, [driver]);

  /** 本地模式：IndexedDB 账号 + localStorage 会话（上游原逻辑） */
  const initWithLocal = useCallback(async () => {
    const accounts = await listAccounts();
    const savedId = localStorage.getItem(SESSION_KEY);

    if (savedId) {
      const found = accounts.find((a) => a.id === savedId);
      if (found) {
        setCurrentAccountId(found.id);
        setAccount(found);
        setRole('admin');
        setState('authenticated');
        return;
      }
    }

    setState(accounts.length === 0 ? 'firstTime' : 'login');
  }, [SESSION_KEY]);

  const reload = useCallback(async () => {
    try {
      if (driver) {
        await initWithDriver();
      } else {
        await initWithLocal();
      }
    } catch {
      setState('firstTime');
    }
  }, [driver, initWithDriver, initWithLocal]);

  useEffect(() => {
    async function init() {
      try {
        if (driver) {
          await initWithDriver();
        } else {
          await initWithLocal();
        }
      } catch {
        setState('firstTime');
      }
    }
    init();
  }, [driver, initWithDriver, initWithLocal]);

  const login = useCallback(
    async (username: string, password: string): Promise<boolean> => {
      setError(null);
      try {
        if (driver) {
          const acc = await driver.login(username, password);
          setAccount(acc);
          setRole(acc.role);
          setState('authenticated');
          return true;
        }
        const acc = await verifyAccountPassword(username, password);
        if (!acc) {
          setError('用户名或密码错误');
          return false;
        }
        setCurrentAccountId(acc.id);
        localStorage.setItem(SESSION_KEY, acc.id);
        setAccount(acc);
        setRole('admin');
        setState('authenticated');
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : '登录失败');
        return false;
      }
    },
    [driver, SESSION_KEY]
  );

  const register = useCallback(
    async (username: string, password: string): Promise<boolean> => {
      if (driver) {
        setError('服务端认证模式下不支持本地注册');
        return false;
      }
      setError(null);
      try {
        const acc = await registerAccount(username, password);
        setCurrentAccountId(acc.id);
        localStorage.setItem(SESSION_KEY, acc.id);
        setAccount(acc);
        setRole('admin');
        setState('authenticated');
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : '注册失败');
        return false;
      }
    },
    [driver, SESSION_KEY]
  );

  const logout = useCallback(() => {
    if (driver) {
      void driver.logout().catch(() => undefined);
    }
    setCurrentAccountId(undefined);
    localStorage.removeItem(SESSION_KEY);
    setAccount(null);
    setRole(null);
    setState('login');
    setError(null);
  }, [driver, SESSION_KEY]);

  const resetPassword = useCallback(
    async (username: string, newPassword: string): Promise<boolean> => {
      if (driver) {
        setError('服务端认证模式下不支持本地重置密码');
        return false;
      }
      setError(null);
      try {
        await resetAccountPassword(username, newPassword);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : '重置失败');
        return false;
      }
    },
    [driver]
  );

  return (
    <AuthContext.Provider
      value={{ state, account, role, login, register, logout, resetPassword, reload, error }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
