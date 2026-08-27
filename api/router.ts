import { authRouter } from "./auth-router";
import { adminRouter } from "./admin-router";
import { telephonyRouter } from "./telephony-router";
import { verificationRouter } from "./verification-router";
import { createRouter, publicQuery } from "./middleware";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  telephony: telephonyRouter,
  admin: adminRouter,
  verification: verificationRouter,
});

export type AppRouter = typeof appRouter;
