import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { User } from "@db/schema";
import { authenticateRequest } from "./kimi/auth";
import {
  getOpenAccessUser,
  isAuthDisabled,
  syntheticOpenAccessUser,
} from "./local-auth";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  user?: User;
};

export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<TrpcContext> {
  const ctx: TrpcContext = { req: opts.req, resHeaders: opts.resHeaders };
  try {
    ctx.user = await authenticateRequest(opts.req.headers);
  } catch {
    // Authentication is optional here
  }
  // Open-access mode: when AUTH_DISABLED=true and no session was found,
  // hand every request the admin user so the app opens straight into the
  // dashboard with no login page.
  if (!ctx.user && isAuthDisabled()) {
    try {
      ctx.user = await getOpenAccessUser();
    } catch {
      // DB unavailable — fall back to an in-memory admin so the UI still works
      ctx.user = syntheticOpenAccessUser();
    }
  }
  return ctx;
}
