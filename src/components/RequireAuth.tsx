import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { LOGIN_PATH } from '@/const';

/**
 * Route guard. `requireAdmin` additionally demands the `admin` role
 * (agents are bounced to the softphone workspace).
 */
export default function RequireAuth({
  children,
  requireAdmin = false,
}: {
  children: ReactNode;
  requireAdmin?: boolean;
}) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-ink-950">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-pulse rounded-[12px] bg-ink-800" />
          <div className="font-mono text-xs text-text-low">connecting…</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to={LOGIN_PATH} replace state={{ from: location.pathname }} />;
  }

  if (requireAdmin && user.role !== 'admin') {
    return <Navigate to="/app" replace />;
  }

  return <>{children}</>;
}
