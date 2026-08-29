/**
 * 应用壳适配层 — 薄封装 @shared/core Layout（统一 UI 风格：可折叠侧边栏 + 分组导航 + 移动端 Drawer + ⌘K）
 * - 保留本项目历史 API（navItems / navGroups + appConfig），内部映射到 shared-core Layout
 * - 认证走本项目自有 useAuth（adapters/shared/useAuth），通过 user/onLogout 注入
 */
import { useNavigate } from 'react-router-dom';
import { Layout as SharedLayout } from '@shared/core';
import { useAuth } from './useAuth';

export interface NavItem {
  to: string;
  icon: React.ElementType;
  label: string;
  end?: boolean;
}

/** 导航分组：按组展示标题 + 子导航项 */
export interface NavGroup {
  key: string;
  label: string;
  icon: React.ElementType;
  children: NavItem[];
}

export interface AppConfig {
  name: string;
  icon: React.ElementType;
  iconClassName?: string;
}

interface LayoutProps {
  children: React.ReactNode;
  /** 扁平导航；与 navGroups 二选一 */
  navItems?: NavItem[];
  /** 分组导航：分组标题 + 子项，优先于 navItems */
  navGroups?: NavGroup[];
  appConfig: AppConfig;
}

export function Layout({ children, navItems, navGroups, appConfig }: LayoutProps) {
  const navigate = useNavigate();
  const { logout, account } = useAuth();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <SharedLayout
      navItems={navItems}
      groups={navGroups}
      appConfig={appConfig}
      user={account ? { username: account.username } : null}
      onLogout={handleLogout}
    >
      {children}
    </SharedLayout>
  );
}
