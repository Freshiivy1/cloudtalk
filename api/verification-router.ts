/**
 * CallVerify port — tRPC API for the verification engine.
 *
 * Mirrors piecebyte's VerificationController:
 *   POST /api/verify                     → verification.initiate
 *   GET  /api/sessions                   → verification.list (+ lazy stale sweep)
 *   GET  /api/sessions/:id               → verification.get
 *   GET  /api/sessions/:id/events        → verification.events
 *   POST /api/sessions/:id/terminate     → verification.terminate
 *   (new) DTMF-00 caller confirmation    → verification.confirmVoicemail
 *
 * All procedures are admin-only (adminQuery pattern from admin-router.ts).
 */
import { TRPCError } from "@trpc/server";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@db/schema";
import { adminQuery, createRouter } from "./middleware";
import { getDb } from "./queries/connection";
import * as vs from "./verification";

/** Normalize then require strict E.164 (mirror of normalizePhoneNumber). */
function toE164(raw: string, field: string): string {
  const n = vs.normalizeE164(raw);
  if (!n) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${field} must be a valid E.164 number (e.g. +61412345678)`,
    });
  }
  return n;
}

const sessionIdInput = z.object({
  sessionId: z.string().min(8).max(64),
});

export const verificationRouter = createRouter({
  /** Start a verification session (sweeps stale sessions first, like the Java cleanup job). */
  initiate: adminQuery
    .input(
      z.object({
        calleeNumber: z.string().min(3).max(32),
        callerNumber: z.string().max(32).optional(),
        legBNumber: z.string().max(32).optional(),
        ringTestNumber: z.string().max(32).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Learn the public origin from the incoming request (published domain),
      // so verification works even when PUBLIC_BASE_URL env is unset.
      try {
        vs.setRuntimeBaseUrl(new URL(ctx.req.url).origin);
      } catch {
        /* ignore — env var may still provide the base URL */
      }
      await vs.sweepStaleSessions();
      return vs.initiate({
        calleeNumber: toE164(input.calleeNumber, "calleeNumber"),
        callerNumber: input.callerNumber ? toE164(input.callerNumber, "callerNumber") : null,
        legBNumber: input.legBNumber ? toE164(input.legBNumber, "legBNumber") : null,
        ringTestNumber: input.ringTestNumber
          ? toE164(input.ringTestNumber, "ringTestNumber")
          : null,
      });
    }),

  /** Sessions, most recent first. Lazy stale sweep mirrors StaleSessionCleanupJob. */
  list: adminQuery.query(async () => {
    await vs.sweepStaleSessions();
    return getDb()
      .select()
      .from(schema.verificationSessions)
      .orderBy(desc(schema.verificationSessions.createdAt))
      .limit(100);
  }),

  get: adminQuery.input(sessionIdInput).query(async ({ input }) => {
    const session = await vs.findSession(input.sessionId);
    if (!session) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
    }
    return session;
  }),

  events: adminQuery.input(sessionIdInput).query(async ({ input }) => {
    return getDb()
      .select()
      .from(schema.verificationEvents)
      .where(eq(schema.verificationEvents.sessionId, input.sessionId))
      .orderBy(asc(schema.verificationEvents.timestamp), asc(schema.verificationEvents.id))
      .limit(500);
  }),

  terminate: adminQuery.input(sessionIdInput).mutation(async ({ input }) => {
    await vs.terminate(input.sessionId);
    return { ok: true };
  }),

  /** Replaces the Java DTMF-00 caller flow: admin confirms voicemail. */
  confirmVoicemail: adminQuery.input(sessionIdInput).mutation(async ({ input }) => {
    await vs.confirmVoicemail(input.sessionId);
    return { ok: true };
  }),
});
