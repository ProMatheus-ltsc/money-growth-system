/**
 * 应用根组件 — 路由、全局 Provider 装配、权限守卫。
 *
 * 架构要点：
 *   - AuthProvider 管理认证状态机（loading → firstTime / unauthenticated / authenticated）
 *   - 路由分两层：公开层（/login, /register 重定向）+ 受保护层（ProtectedRoute 包裹）
 *   - 受保护层内再按角色区分：admin 可访问所有页面，viewer 仅可访问报表类页面
 *   - 导航菜单按角色动态切换（ADMIN_NAV_GROUPS / VIEWER_NAV_GROUPS）
 *   - 所有页面组件均为 lazy 加载，配合 Suspense 显示加载状态
 *   - UnauthorizedHandler 监听 401 广播事件，自动登出并提示用户
 */
import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './adapters/shared/useAuth';
import { ToastProvider, useToast } from '@shared/core/hooks/useToast';
import { ToastContainer } from '@shared/core/components/Toast';
import { ProtectedRoute } from './adapters/shared/ProtectedRoute';
import { Layout, type NavGroup } from './adapters/shared/Layout';
import { LoadingSpinner } from '@shared/core/components/LoadingSpinner';
import {
  Activity,
  FileBarChart2,
  FileClock,
  FileSpreadsheet,
  FolderTree,
  GitFork,
  Home,
  Landmark,
  Lock,
  Package,
  PencilLine,
  Settings,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import { restAuthDriver } from './adapters/auth/restAuthDriver';
import { UNAUTHORIZED_EVENT } from './lib/api';
import { EntryDraftProvider } from './context/EntryDraftContext';
import { UiProvider } from './context/UiContext';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const EntryPage = lazy(() => import('./pages/EntryPage'));
const DebtsPage = lazy(() => import('./pages/DebtsPage'));
const AssetReportPage = lazy(() => import('./pages/AssetReportPage'));
const FinanceReportPage = lazy(() => import('./pages/FinanceReportPage'));
const ReportSnapshotsPage = lazy(() => import('./pages/ReportSnapshotsPage'));
const TreeManagePage = lazy(() => import('./pages/TreeManagePage'));
const PhysicalAssetsPage = lazy(() => import('./pages/PhysicalAssetsPage'));
const CatManagePage = lazy(() => import('./pages/CatManagePage'));
const AiPage = lazy(() => import('./pages/AiPage'));
const BackupPage = lazy(() => import('./pages/BackupPage'));
const HealthPage = lazy(() => import('./pages/HealthPage'));

const UsersPage = lazy(() => import('./pages/UsersPage'));

/** 全局 401 事件监听器：会话过期时自动登出并提示用户 */
function UnauthorizedHandler() {
  const { logout } = useAuth();
  const { showToast } = useToast();
  useEffect(() => {
    const handler = () => {
      showToast('会话已过期，请重新登录', 'warning');
      logout();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
  }, [logout, showToast]);
  return null;
}

/** 角色路由守卫：viewer 角色访问管理页面时重定向到报表首页 */
function RoleRoute({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();
  const { showToast } = useToast();
  useEffect(() => {
    if (role === 'viewer') {
      showToast('只读账号无权访问该页面', 'warning');
    }
  }, [role, showToast]);
  if (role === 'viewer') return <Navigate to="/reports/assets" replace />;
  return <>{children}</>;
}

/** 根据角色决定默认首页：admin → 仪表盘，viewer → 资产报表 */
function DefaultRedirect() {
  const { role } = useAuth();
  return <Navigate to={role === 'viewer' ? '/reports/assets' : '/'} replace />;
}

function NotFoundRedirect() {
  return <Navigate to="/" replace />;
}

/** 登录页门控：已认证用户访问 /login 时自动跳转回首页 */
function LoginGate() {
  const { state } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (state === 'authenticated') navigate('/', { replace: true });
  }, [state, navigate]);
  return <LoginPage />;
}

/** 管理员侧边栏导航配置：概览 + 数据录入 + 数据分析 + 系统设置 */
const ADMIN_NAV_GROUPS: NavGroup[] = [
  {
    key: 'home',
    label: '概览',
    icon: Home,
    children: [
      { to: '/', icon: TrendingUp, label: '仪表盘', end: true },
    ],
  },
  {
    key: 'data',
    label: '数据录入',
    icon: PencilLine,
    children: [
      { to: '/entry', icon: PencilLine, label: '月末录入' },
      { to: '/debts', icon: Landmark, label: '负债管理' },
      { to: '/physical-assets', icon: Package, label: '实物资产' },
    ],
  },
  {
    key: 'analysis',
    label: '数据分析',
    icon: FileBarChart2,
    children: [
      { to: '/reports/assets', icon: FileBarChart2, label: '资产报表' },
      { to: '/reports/finance', icon: FileSpreadsheet, label: '财务报表' },
      { to: '/reports/snapshots', icon: FileClock, label: '报告快照' },
      { to: '/health', icon: Activity, label: '财务健康' },
    ],
  },
  {
    key: 'settings',
    label: '系统设置',
    icon: Settings,
    children: [
      { to: '/settings/tree', icon: GitFork, label: '资产树管理' },
      { to: '/settings/categories', icon: FolderTree, label: '收支分类管理' },
      { to: '/settings/users', icon: Users, label: '用户管理' },
      { to: '/ai', icon: Sparkles, label: 'AI 分析' },
      { to: '/settings/backup', icon: Wallet, label: '备份与恢复' },
    ],
  },
];

/** 只读用户侧边栏导航配置：仅包含数据分析（报表查看） */
const VIEWER_NAV_GROUPS: NavGroup[] = [
  {
    key: 'analysis',
    label: '数据分析',
    icon: FileBarChart2,
    children: [
      { to: '/reports/assets', icon: FileBarChart2, label: '资产报表' },
      { to: '/reports/finance', icon: FileSpreadsheet, label: '财务报表' },
      { to: '/reports/snapshots', icon: FileClock, label: '报告快照' },
    ],
  },
];

/** 应用外壳：根据当前用户角色渲染对应的侧边栏导航布局 */
function AppShell({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();
  return (
    <Layout
      navGroups={role === 'viewer' ? VIEWER_NAV_GROUPS : ADMIN_NAV_GROUPS}
      appConfig={{ name: '资产增长系统', icon: Lock, iconClassName: 'from-emerald-600 to-teal-700' }}
    >
      {children}
    </Layout>
  );
}

function PageFallback() {
  return <LoadingSpinner message="页面加载中…" />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Suspense fallback={<PageFallback />}><LoginGate /></Suspense>} />
      {/* 注册功能已禁用，访问 /register 重定向到登录 */}
      <Route path="/register" element={<Navigate to="/login" replace />} />
      <Route
        path="*"
        element={
          <ProtectedRoute>
            <AppShell>
              <Suspense fallback={<PageFallback />}>
                <Routes>
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/entry" element={<RoleRoute><EntryPage /></RoleRoute>} />
                  <Route path="/debts" element={<RoleRoute><DebtsPage /></RoleRoute>} />
                  <Route path="/reports/assets" element={<AssetReportPage />} />
                  <Route path="/reports/finance" element={<FinanceReportPage />} />
                  <Route path="/reports/snapshots" element={<ReportSnapshotsPage />} />
                  <Route path="/physical-assets" element={<RoleRoute><PhysicalAssetsPage /></RoleRoute>} />
                  <Route path="/settings/tree" element={<RoleRoute><TreeManagePage /></RoleRoute>} />
                  <Route path="/settings/categories" element={<RoleRoute><CatManagePage /></RoleRoute>} />
                  <Route path="/ai" element={<RoleRoute><AiPage /></RoleRoute>} />
                  <Route path="/settings/users" element={<RoleRoute><UsersPage /></RoleRoute>} />
                  <Route path="/settings/backup" element={<RoleRoute><BackupPage /></RoleRoute>} />
                  <Route path="/health" element={<HealthPage />} />
                  <Route path="*" element={<NotFoundRedirect />} />
                </Routes>
              </Suspense>
            </AppShell>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider driver={restAuthDriver}>
      <ToastProvider>
        <EntryDraftProvider>
          <UiProvider>
            <BrowserRouter>
              <UnauthorizedHandler />
              <AppRoutes />
              <ToastContainer />
            </BrowserRouter>
          </UiProvider>
        </EntryDraftProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
