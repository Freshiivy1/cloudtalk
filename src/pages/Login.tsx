import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Kimi platform OAuth is only available when the platform vars are present. */
const oauthConfigured = Boolean(
  import.meta.env.VITE_KIMI_AUTH_URL && import.meta.env.VITE_APP_ID,
);

function getOAuthUrl() {
  const kimiAuthUrl = import.meta.env.VITE_KIMI_AUTH_URL;
  const appID = import.meta.env.VITE_APP_ID;
  const redirectUri = `${window.location.origin}/api/oauth/callback`;
  const state = btoa(redirectUri);

  const url = new URL(`${kimiAuthUrl}/api/oauth/authorize`);
  url.searchParams.set("client_id", appID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "profile");
  url.searchParams.set("state", state);

  return url.toString();
}

/**
 * Off-platform login: username/password against ADMIN_USERNAME/ADMIN_PASSWORD
 * (server-side env). The mutation sets the same `kimi_sid` session cookie as
 * the Kimi OAuth callback, then we invalidate and land on the app.
 */
function PasswordLogin() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const mode = trpc.auth.loginMode.useQuery(undefined, { retry: false });
  const login = trpc.auth.login.useMutation({
    onSuccess: async () => {
      await utils.invalidate();
      navigate("/");
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate({ username, password });
  }

  if (mode.data === "none") {
    return (
      <p className="text-sm text-muted-foreground text-center">
        Authentication is not configured on this server. Set ADMIN_USERNAME and
        ADMIN_PASSWORD (or the Kimi OAuth vars) and redeploy.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <Input
        name="username"
        autoComplete="username"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
      />
      <Input
        name="password"
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {login.error && (
        <p className="text-sm text-destructive">{login.error.message}</p>
      )}
      <Button
        type="submit"
        className="w-full"
        size="lg"
        disabled={login.isPending || mode.isLoading}
      >
        {login.isPending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export default function Login() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>Welcome</CardTitle>
        </CardHeader>
        <CardContent>
          {oauthConfigured ? (
            <Button
              className="w-full"
              size="lg"
              onClick={() => {
                window.location.href = getOAuthUrl();
              }}
            >
              Sign in with Kimi
            </Button>
          ) : (
            <PasswordLogin />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
