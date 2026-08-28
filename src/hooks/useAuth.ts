import { useMemo } from "react";

const MOCK_USER = {
  id: 1,
  name: "Admin",
  email: "admin@cloudtalk.local",
  role: "admin" as const,
};

/**
 * Mock auth hook — returns a static admin user so the UI never shows
 * login states or redirects. The real auth bypass lives in api/context.ts
 * via AUTH_DISABLED.
 */
export function useAuth() {
  return useMemo(
    () => ({
      user: MOCK_USER,
      isAuthenticated: true,
      isLoading: false,
      error: null,
      logout: () => {},
      refresh: () => {},
    }),
    [],
  );
}
