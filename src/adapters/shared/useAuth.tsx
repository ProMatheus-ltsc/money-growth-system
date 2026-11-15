/**
 * 认证 Hook + Provider —— 转发到 @shared/core 的统一认证。
 *
 * 本项目原先 vendor 了一份 shared-core 的 useAuth（并打了 AuthDriver 注入补丁），
 * 与上游实现逐渐分化。这次把认证收归共享包：
 * - 认证状态机、错误语义：shared-core 的 `AuthProvider` / `useAuth`
 * - 服务端权威认证的具体实现：本项目的 `src/adapters/auth/restAuthDriver.ts`
 *
 * 对外形状保持不变（调用方无须改写）：
 *   state / account / role / login / register / logout / resetPassword / reload / error
 *
 * 与共享包的差异（在本文件消化）：
 * - 共享包用 `user`（统一 AuthUser），本项目对外仍用 `account`，
 *   且 account 上带 `role`（只读/管理员）。
 * - 共享包是四态，本项目额外提供 `reload`（首次初始化完成后刷新状态机）。
 */
import React, { useCallback, useContext, useMemo } from 'react';
import {
  AuthProvider as SharedAuthProvider,
  useAuth as useSharedAuth,
  type AuthDriver,
  type AuthUser,
} from '@shared/core/auth';
import type { Account } from '@shared/core/types';

/** AuthDriver 账号：Account + 角色（服务端权威，本地驱动下角色缺省 admin） */
export interface AuthDriverAccount extends Account {
  role: string;
}

type AuthState = 'loading' | 'firstTime' | 'login' | 'authenticated';

interface AuthContextType {
  state: AuthState;
  account: Account | null;
  role: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  register: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  resetPassword: (username: string, newPassword: string) => Promise<boolean>;
  /** 重新探测会话（首次初始化完成后调用） */
  reload: () => Promise<void>;
  error: string | null;
}

export function AuthProvider({
  children,
  driver,
}: {
  children: React.ReactNode;
  /** 认证驱动：本项目注入服务端权威的 REST 驱动 */
  driver: AuthDriver;
}) {
  return (
    <SharedAuthProvider driver={driver} errorMode="boolean">
      {children}
    </SharedAuthProvider>
  );
}

export function useAuth(): AuthContextType {
  const shared = useSharedAuth();

  const role = useMemo(() => {
    const value = shared.user?.extra?.role;
    return typeof value === 'string' ? value : null;
  }, [shared.user]);

  /** 统一的 Account 形态：保留上游 Account 字段，role 挂在上层 */
  const account = useMemo<Account | null>(() => {
    const user: AuthUser | null = shared.user;
    if (!user) return null;
    const base: Account = {
      id: user.id,
      username: user.username,
      passwordHash: '',
      salt: '',
      createdAt: new Date().toISOString(),
    };
    return role ? { ...base, role } : base;
  }, [shared.user, role]);

  const reload = useCallback(async () => {
    await shared.refresh();
  }, [shared]);

  return {
    state: shared.state,
    account,
    role,
    login: shared.login,
    // 本项目未开放自助注册（服务端已删除 /api/auth/register），
    // 共享包会给出「当前系统未开放自助注册」的提示。
    register: shared.register,
    logout: shared.logout,
    resetPassword: shared.resetPassword,
    reload,
    error: shared.error,
  };
}
