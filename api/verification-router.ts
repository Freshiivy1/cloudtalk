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
import { adminQuery, authedQuery, createRouter } from "./middleware";
import { getDb, getDbOrNull } from "./queries/connection";
import * as vs from "./verification";
import { twilioCallerIdFor } from "./twilio-voice";
import { logCallEvent } from "./simulator";

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

  /**
   * Guarded inmate call (softphone mode): the agent dials a callee through
   * the verification engine. This mutation ONLY creates the guarded session
   * (state INITIATED) — the browser then places the caller leg itself as an
   * OUTBOUND Twilio Voice SDK call carrying the sessionId as the `guarded`
   * custom param, and the TwiML App voice webhook parks the caller in the
   * session conference and starts Leg A. Speakerphone suspicion during the
   * call triggers a caller-only (inmate) challenge-noise announce — never a hangup.
   * Any authed agent may use this (same auth as the softphone telephony router).
   */
  initiateGuarded: authedQuery
    .input(z.object({ calleeNumber: z.string().min(3).max(32) }))
    .mutation(async ({ input, ctx }) => {
      try {
        vs.setRuntimeBaseUrl(new URL(ctx.req.url).origin);
      } catch {
        /* ignore — env var may still provide the base URL */
      }
      await vs.sweepStaleSessions();
      const callee = toE164(input.calleeNumber, "calleeNumber");
      // Same Twilio Client identity resolution as telephony.voice.token.
      const callerClient = `user-${ctx.user.id}`;
      const session = await vs.initiate({ calleeNumber: callee, callerClient });

      // Best-effort history row (like placeCall), marked as guarded. The
      // clientCallId links this row to the verification session so later
      // events (e.g. speakerphone_suspected) can find it.
      const db = getDbOrNull();
      if (db) {
        try {
          const fromNumber = twilioCallerIdFor("legA") || "guarded";
          const [r] = await db.insert(schema.calls).values({
            direction: "outbound",
            status: "dialing",
            fromNumber,
            toNumber: callee,
            agentId: ctx.user.id,
            twilioSid: session.callerCallSid ?? null,
            clientCallId: `guarded-${session.sessionId}`,
            note: `guarded inmate call (verification session ${session.sessionId})`,
            startedAt: new Date(),
          });
          const callId = Number((r as unknown as { insertId: number }).insertId);
          await logCallEvent(callId, "call_ringing", {
            agentId: ctx.user.id,
            guarded: true,
            verificationSessionId: session.sessionId,
          });
        } catch (err) {
          console.warn("[verify] guarded history insert failed:", (err as Error).message);
        }
      }
      return { sessionId: session.sessionId };
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

  // authedQuery (not adminQuery): the softphone's in-call "Live analysis"
  // panel polls these two endpoints for the agent's own guarded session.
  get: authedQuery.input(sessionIdInput).query(async ({ input }) => {
    const session = await vs.findSession(input.sessionId);
    if (!session) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
    }
    return session;
  }),

  events: authedQuery.input(sessionIdInput).query(async ({ input }) => {
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
