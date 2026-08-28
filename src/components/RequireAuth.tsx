import type { ReactNode } from 'react';

/**
 * Authentication bypassed — all routes are now public.
 * Kept as a pass-through so existing imports don't break.
 */
export default function RequireAuth({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
