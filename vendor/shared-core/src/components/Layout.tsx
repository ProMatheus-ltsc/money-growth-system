/**
 * 应用壳组件 - 固定侧边栏 + 可折叠
 * 侧边栏始终可见（非悬浮），支持折叠/展开
 */
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { LogOut, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

export interface NavItem {
  to: string;
  icon: React.ElementType;
  label: string;
  end?: boolean;
}

/** 导航分组（PATCHES #4）：按组展示标题 + 子导航项 */
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
  /** 扁平导航（PATCHES #4 前形态）；与 navGroups 二选一 */
  navItems?: NavItem[];
  /** 分组导航（PATCHES #4）：分组标题 + 子项，优先于 navItems */
  navGroups?: NavGroup[];
  appConfig: AppConfig;
}

export function Layout({ children, navItems = [], navGroups, appConfig }: LayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { logout, account } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const AppIcon = appConfig.icon;
  const sidebarWidth = collapsed ? 'w-16' : 'w-56';
  const mainPadding = collapsed ? 'pl-16' : 'pl-56';

  const renderNavLink = (item: NavItem) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end ?? item.to === '/'}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-lg text-sm font-medium transition-all duration-200 mb-0.5 group relative ${
          collapsed ? 'px-0 py-2.5 justify-center' : 'px-3 py-2.5'
        } ${
          isActive
            ? 'bg-blue-50 text-blue-700 shadow-sm border border-blue-100'
            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-transparent'
        }`
      }
    >
      <item.icon size={18} className="flex-shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {/* 折叠态 tooltip */}
      {collapsed && (
        <span className="absolute left-full ml-2 px-2 py-1 bg-slate-800 text-white text-xs rounded-md whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50 shadow-lg">
          {item.label}
        </span>
      )}
    </NavLink>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* 固定侧边栏 */}
      <aside
        className={`fixed left-0 top-0 bottom-0 ${sidebarWidth} flex flex-col bg-white border-r border-slate-200 z-40 transition-all duration-300 ease-in-out`}
      >
        {/* 顶部品牌区 */}
        <div className="flex items-center h-14 px-3 border-b border-slate-100 flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div
              className={`flex-shrink-0 w-9 h-9 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-xl flex items-center justify-center shadow-md ${appConfig.iconClassName || ''}`}
            >
              <AppIcon size={18} className="text-white" />
            </div>
            {!collapsed && (
              <span className="font-bold text-slate-800 text-sm truncate">
                {appConfig.name}
              </span>
            )}
          </div>
        </div>

        {/* 导航菜单 */}
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          {navGroups
            ? navGroups.map((group) => (
                <div key={group.key} className="mb-3">
                  {!collapsed && (
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      <group.icon size={11} className="flex-shrink-0" />
                      {group.label}
                    </div>
                  )}
                  {group.children.map(renderNavLink)}
                </div>
              ))
            : navItems.map(renderNavLink)}
        </nav>

        {/* 底部操作区 */}
        <div className="flex-shrink-0 border-t border-slate-100 p-2 space-y-1">
          {/* 用户信息 */}
          {!collapsed && account?.username && (
            <div className="flex items-center gap-2 px-3 py-2">
              <div className="w-7 h-7 bg-gradient-to-br from-slate-600 to-slate-700 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                {account.username.charAt(0)}
              </div>
              <span className="text-xs text-slate-600 truncate">{account.username}</span>
            </div>
          )}

          {/* 折叠/展开按钮 */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={`flex items-center gap-2 w-full rounded-lg text-sm text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-all ${
              collapsed ? 'px-0 py-2 justify-center' : 'px-3 py-2'
            }`}
            title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            {!collapsed && <span className="text-xs">折叠</span>}
          </button>

          {/* 退出登录 */}
          <button
            onClick={handleLogout}
            className={`flex items-center gap-2 w-full rounded-lg text-sm text-slate-500 hover:text-red-600 hover:bg-red-50 transition-all ${
              collapsed ? 'px-0 py-2 justify-center' : 'px-3 py-2'
            }`}
            title="退出登录"
          >
            <LogOut size={18} />
            {!collapsed && <span className="text-xs">退出</span>}
          </button>
        </div>
      </aside>

      {/* 主内容区 - 跟随侧边栏宽度 */}
      <main className={`flex-1 ${mainPadding} transition-all duration-300 ease-in-out min-h-screen`}>
        <div className="p-4 lg:p-6 max-w-7xl mx-auto">{children}</div>
      </main>
    </div>
  );
}
