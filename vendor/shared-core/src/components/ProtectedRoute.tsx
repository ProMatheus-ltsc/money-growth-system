/**
 * 路由守卫：未认证时重定向到登录页
 */
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { LoadingSpinner } from './LoadingSpinner';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { state } = useAuth();

  if (state === 'loading') {
    return <LoadingSpinner message="初始化中..." />;
  }

  if (state !== 'authenticated') {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
