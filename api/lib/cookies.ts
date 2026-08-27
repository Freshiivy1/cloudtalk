/**
 * Cookie options for the `kimi_sid` session cookie, derived from the incoming
 * request headers. Behind the platform proxy, `x-forwarded-proto` tells us
 * whether the browser-facing connection is HTTPS — cross-site OAuth redirects
 * need SameSite=None;Secure, while plain http (local dev) must stay Lax +
 * non-Secure or the browser refuses to store the cookie.
 */
export interface SessionCookieOptions {
  httpOnly: boolean;
  path: string;
  sameSite: "Lax" | "None";
  secure: boolean;
}

export function getSessionCookieOptions(headers: Headers): SessionCookieOptions {
  const proto = (headers.get("x-forwarded-proto") ?? "").split(",")[0].trim();
  const secure = proto === "https";
  return {
    httpOnly: true,
    path: "/",
    sameSite: secure ? "None" : "Lax",
    secure,
  };
}
