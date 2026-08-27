import * as cookie from "cookie";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import { issueSessionToken } from "./kimi/auth";
import {
  isLocalLoginConfigured,
  verifyLocalLogin,
} from "./local-auth";
import { createRouter, authedQuery, publicQuery } from "./middleware";

export const authRouter = createRouter({
  me: authedQuery.query((opts) => opts.ctx.user),

  /**
   * Off-platform auth discovery for Login.tsx: "password" when ADMIN_USERNAME
   * + ADMIN_PASSWORD are set, otherwise "none" (the client then shows an
   * "auth not configured" state). The Kimi OAuth button is gated client-side
   * by VITE_KIMI_AUTH_URL / VITE_APP_ID, so it is not reported here.
   */
  loginMode: publicQuery.query(() =>
    isLocalLoginConfigured() ? ("password" as const) : ("none" as const),
  ),

  /**
   * Env-based username/password login (off-platform fallback). Issues the same
   * `kimi_sid` session cookie as the Kimi OAuth callback. No-op when
   * ADMIN_USERNAME / ADMIN_PASSWORD are unset.
   */
  login: publicQuery
    .input(
      z.object({
        username: z.string().min(1).max(255),
        password: z.string().min(1).max(1024),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!isLocalLoginConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Password login is not configured on this server (set ADMIN_USERNAME and ADMIN_PASSWORD)",
        });
      }
      const user = await verifyLocalLogin(input.username, input.password);
      if (!user) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid username or password",
        });
      }
      const token = await issueSessionToken(user.id);
      const opts = getSessionCookieOptions(ctx.req.headers);
      ctx.resHeaders.append(
        "set-cookie",
        cookie.serialize(Session.cookieName, token, {
          httpOnly: opts.httpOnly,
          path: opts.path,
          sameSite: opts.sameSite?.toLowerCase() as "lax" | "none",
          secure: opts.secure,
          maxAge: Math.floor(Session.maxAgeMs / 1000),
        }),
      );
      return { success: true, user };
    }),

  logout: authedQuery.mutation(async ({ ctx }) => {
    const opts = getSessionCookieOptions(ctx.req.headers);
    ctx.resHeaders.append(
      "set-cookie",
      cookie.serialize(Session.cookieName, "", {
        httpOnly: opts.httpOnly,
        path: opts.path,
        sameSite: opts.sameSite?.toLowerCase() as "lax" | "none",
        secure: opts.secure,
        maxAge: 0,
      }),
    );
    return { success: true };
  }),
});
