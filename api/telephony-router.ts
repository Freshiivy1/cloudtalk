/**
 * Agent-facing telephony router: contacts, presence, and call lifecycle
 * mirroring. The softphone UI runs its snappy client-side simulation; these
 * procedures persist the lifecycle so history, recordings and the admin live
 * monitor all share one source of truth.
 *
 * Resilience rule: real calling must never fail because optional history
 * storage is unavailable. Every procedure here uses `getDbOrNull()` and returns
 * an explicit degraded result when DATABASE_URL is missing or MySQL is down.
 */
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as schema from "@db/schema";
import { authedQuery, createRouter, publicQuery } from "./middleware";
import { getDbOrNull } from "./queries/connection";
import { advanceSimulation, logCallEvent } from "./simulator";
import {
  generateVoiceToken,
  getTwilioClient,
  twilioCallerIdFor,
  twilioConfigured,
  twilioRestConfigured,
} from "./twilio-voice";

const presenceEnum = z.enum(["available", "busy", "away", "offline"]);
type Db = NonNullable<ReturnType<typeof getDbOrNull>>;

function offlineProfile(userId: number): schema.AgentProfile {
  return {
    id: 0,
    userId,
    extensionId: null,
    presence: "offline",
    title: null,
    department: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** Run a DB operation with an explicit fallback; never throw to tRPC. */
async function safeDb<T>(
  label: string,
  fallback: T,
  op: (db: Db) => Promise<T>,
): Promise<T> {
  const db = getDbOrNull();
  if (!db) return fallback;
  try {
    return await op(db);
  } catch (err) {
    console.warn(`[telephony] ${label} failed:`, (err as Error).message);
    return fallback;
  }
}

async function ensureProfile(userId: number): Promise<schema.AgentProfile> {
  return safeDb("ensureProfile", offlineProfile(userId), async (db) => {
    const rows = await db
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.userId, userId))
      .limit(1);
    if (rows.at(0)) return rows[0];
    await db.insert(schema.agentProfiles).values({ userId, presence: "offline" });
    const created = await db
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.userId, userId))
      .limit(1);
    return created[0] ?? offlineProfile(userId);
  });
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

type CallDetailResult = {
  call: schema.Call;
  events: schema.CallEvent[];
  recording: schema.Recording | null;
} | null;

function mapTwilioStatus(status: string): schema.InsertCall["status"] {
  switch (status) {
    case "ringing":
      return "ringing";
    case "in-progress":
      return "active";
    case "completed":
      return "completed";
    case "busy":
    case "no-answer":
    case "failed":
    case "canceled":
      return "failed";
    case "queued":
    case "initiated":
    default:
      return "dialing";
  }
}

export const telephonyRouter = createRouter({
  /* ------------------------------ contacts ------------------------------ */
  contacts: createRouter({
    list: authedQuery
      .input(
        z.object({
          search: z.string().optional(),
          tag: z.enum(["vip", "lead", "customer", "supplier"]).optional(),
          favoritesOnly: z.boolean().optional(),
        }),
      )
      .query(async ({ input }) => {
        return safeDb("contacts.list", [] as schema.Contact[], async (db) => {
          const conds = [];
          if (input.search) {
            const q = `%${input.search}%`;
            conds.push(
              or(
                like(schema.contacts.name, q),
                like(schema.contacts.company, q),
                like(schema.contacts.phone, q),
              ),
            );
          }
          if (input.tag) conds.push(eq(schema.contacts.tag, input.tag));
          if (input.favoritesOnly) conds.push(eq(schema.contacts.favorite, true));
          return db
            .select()
            .from(schema.contacts)
            .where(conds.length ? and(...conds) : undefined)
            .orderBy(desc(schema.contacts.favorite), schema.contacts.name)
            .limit(200);
        });
      }),

    create: authedQuery
      .input(
        z.object({
          name: z.string().min(1),
          phone: z.string().min(3),
          company: z.string().optional(),
          email: z.string().email().optional(),
          tag: z.enum(["vip", "lead", "customer", "supplier"]).optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        return safeDb(
          "contacts.create",
          { id: 0, persisted: false },
          async (db) => {
            const [r] = await db.insert(schema.contacts).values({
              ...input,
              ownerId: ctx.user.id,
            });
            return {
              id: Number((r as unknown as { insertId: number }).insertId),
              persisted: true,
            };
          },
        );
      }),

    toggleFavorite: authedQuery
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        return safeDb(
          "contacts.toggleFavorite",
          { ok: true, persisted: false },
          async (db) => {
            await db
              .update(schema.contacts)
              .set({ favorite: sql`NOT ${schema.contacts.favorite}` })
              .where(eq(schema.contacts.id, input.id));
            return { ok: true, persisted: true };
          },
        );
      }),

    remove: authedQuery
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        return safeDb(
          "contacts.remove",
          { ok: true, persisted: false },
          async (db) => {
            await db.delete(schema.contacts).where(eq(schema.contacts.id, input.id));
            return { ok: true, persisted: true };
          },
        );
      }),
  }),

  /* ------------------------------ presence ------------------------------ */
  presence: createRouter({
    set: authedQuery
      .input(z.object({ presence: presenceEnum }))
      .mutation(async ({ input, ctx }) => {
        const profile = await ensureProfile(ctx.user.id);
        await safeDb("presence.set", undefined, async (db) => {
          await db
            .update(schema.agentProfiles)
            .set({ presence: input.presence })
            .where(eq(schema.agentProfiles.userId, ctx.user.id));
          return undefined;
        });
        return { ok: true, presence: input.presence, persisted: profile.id !== 0 };
      }),
    mine: authedQuery.query(async ({ ctx }) => ensureProfile(ctx.user.id)),
  }),

  /* -------------------------------- calls -------------------------------- */
  calls: createRouter({
    /** Softphone reports a newly originated/received call → persisted. */
    originate: authedQuery
      .input(
        z.object({
          direction: z.enum(["inbound", "outbound"]),
          fromNumber: z.string(),
          toNumber: z.string(),
          contactName: z.string().optional(),
          clientCallId: z.string().optional(),
          twilioSid: z.string().optional(),
          speakerphoneAttempted: z.boolean().optional(),
          listenLiveAttempted: z.boolean().optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        return safeDb("calls.originate", { id: 0, persisted: false }, async (db) => {
          const profile = await ensureProfile(ctx.user.id);
          const contact = input.contactName
            ? null
            : (
                await db
                  .select()
                  .from(schema.contacts)
                  .where(
                    eq(
                      schema.contacts.phone,
                      input.direction === "outbound"
                        ? input.toNumber
                        : input.fromNumber,
                    ),
                  )
                  .limit(1)
              ).at(0);
          const [r] = await db.insert(schema.calls).values({
            direction: input.direction,
            status: input.direction === "inbound" ? "ringing" : "dialing",
            fromNumber: input.fromNumber,
            toNumber: input.toNumber,
            contactName: input.contactName ?? contact?.name ?? null,
            contactId: contact?.id ?? null,
            agentId: ctx.user.id,
            extensionId: profile?.extensionId ?? null,
            clientCallId: input.clientCallId ?? null,
            twilioSid: input.twilioSid ?? null,
            speakerphoneAttempted: input.speakerphoneAttempted ?? false,
            listenLiveAttempted: input.listenLiveAttempted ?? false,
          });
          const id = Number((r as unknown as { insertId: number }).insertId);
          await logCallEvent(
            id,
            input.direction === "inbound" ? "incoming_call" : "call_ringing",
            {
              agentId: ctx.user.id,
              clientCallId: input.clientCallId,
              twilioSid: input.twilioSid,
              speakerphoneAttempted: input.speakerphoneAttempted ?? false,
              listenLiveAttempted: input.listenLiveAttempted ?? false,
            },
          );
          return { id, persisted: true };
        });
      }),

    /**
     * Append a lifecycle event and mirror the call state.
     * Types: call_ringing | call_active | call_held | call_resumed |
     *        call_muted | call_unmuted | dtmf | call_ended |
     *        speakerphone_attempted | speakerphone_enabled | speakerphone_disabled |
     *        listen_live_attempted | listen_live_started | listen_live_stopped
     */
    event: authedQuery
      .input(
        z.object({
          callId: z.number(),
          type: z.string().min(1),
          payload: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        return safeDb(
          "calls.event",
          { ok: true, persisted: false },
          async (db) => {
            if (input.callId > 0) {
              await logCallEvent(input.callId, input.type, input.payload);
            }
            const now = new Date();
            switch (input.type) {
              case "call_active":
                await db
                  .update(schema.calls)
                  .set({ status: "active", answeredAt: now })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "call_held":
                await db
                  .update(schema.calls)
                  .set({ status: "held" })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "call_resumed":
                await db
                  .update(schema.calls)
                  .set({ status: "active" })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "call_muted":
                await db
                  .update(schema.calls)
                  .set({ muted: true })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "call_unmuted":
                await db
                  .update(schema.calls)
                  .set({ muted: false })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "speakerphone_attempted":
                await db
                  .update(schema.calls)
                  .set({ speakerphoneAttempted: true })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "speakerphone_enabled":
                await db
                  .update(schema.calls)
                  .set({ speakerphoneAttempted: true, speakerphoneUsed: true })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "speakerphone_disabled":
                await db
                  .update(schema.calls)
                  .set({ speakerphoneUsed: false })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "listen_live_attempted":
                await db
                  .update(schema.calls)
                  .set({ listenLiveAttempted: true })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "listen_live_started":
                await db
                  .update(schema.calls)
                  .set({ listenLiveAttempted: true, listenLiveUsed: true })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "listen_live_stopped":
                await db
                  .update(schema.calls)
                  .set({ listenLiveUsed: false })
                  .where(eq(schema.calls.id, input.callId));
                break;
              case "call_ended": {
                const rows = await db
                  .select()
                  .from(schema.calls)
                  .where(eq(schema.calls.id, input.callId))
                  .limit(1);
                const call = rows.at(0);
                if (!call) break;
                const answered =
                  call.status === "active" ||
                  call.status === "held" ||
                  call.answeredAt != null;
                const durationSec = answered
                  ? Math.max(
                      1,
                      Math.round(
                        (now.getTime() -
                          (call.answeredAt ?? call.startedAt).getTime()) /
                          1000,
                      ),
                    )
                  : 0;
                const status = answered
                  ? ("completed" as const)
                  : call.direction === "inbound"
                    ? ("missed" as const)
                    : ("failed" as const);
                const hasRecording =
                  answered && durationSec > 20 && Math.random() < 0.65;
                await db
                  .update(schema.calls)
                  .set({ status, endedAt: now, durationSec, hasRecording })
                  .where(eq(schema.calls.id, input.callId));
                if (hasRecording) {
                  await db
                    .insert(schema.recordings)
                    .values({ callId: input.callId, durationSec });
                }
                break;
              }
            }
            return { ok: true, persisted: true };
          },
        );
      }),

    addNote: authedQuery
      .input(z.object({ callId: z.number(), note: z.string() }))
      .mutation(async ({ input }) => {
        return safeDb(
          "calls.addNote",
          { ok: true, persisted: false },
          async (db) => {
            await db
              .update(schema.calls)
              .set({ note: input.note })
              .where(eq(schema.calls.id, input.callId));
            return { ok: true, persisted: true };
          },
        );
      }),

    /** Current user's call history (paginated + filtered). */
    listMine: authedQuery
      .input(
        z.object({
          page: z.number().default(1),
          pageSize: z.number().default(25),
          direction: z.enum(["inbound", "outbound"]).optional(),
          status: z
            .enum(["completed", "missed", "failed", "active", "held", "ringing"])
            .optional(),
          search: z.string().optional(),
          speakerphone: z.enum(["attempted", "not_attempted"]).optional(),
        }),
      )
      .query(async ({ input, ctx }) => {
        const fallback = {
          rows: [] as schema.Call[],
          total: 0,
          page: input.page,
          pageSize: input.pageSize,
        };
        return safeDb("calls.listMine", fallback, async (db) => {
          const conds = [eq(schema.calls.agentId, ctx.user.id)];
          if (input.direction)
            conds.push(eq(schema.calls.direction, input.direction));
          if (input.status) conds.push(eq(schema.calls.status, input.status));
          if (input.speakerphone === "attempted")
            conds.push(eq(schema.calls.speakerphoneAttempted, true));
          if (input.speakerphone === "not_attempted")
            conds.push(eq(schema.calls.speakerphoneAttempted, false));
          if (input.search) {
            const q = `%${input.search}%`;
            conds.push(
              or(
                like(schema.calls.contactName, q),
                like(schema.calls.fromNumber, q),
                like(schema.calls.toNumber, q),
              )!,
            );
          }
          const where = and(...conds);
          const total = Number(
            (
              await db
                .select({ n: sql<number>`count(*)` })
                .from(schema.calls)
                .where(where)
            ).at(0)?.n ?? 0,
          );
          const rows = await db
            .select()
            .from(schema.calls)
            .where(where)
            .orderBy(desc(schema.calls.startedAt))
            .limit(input.pageSize)
            .offset((input.page - 1) * input.pageSize);
          return { rows, total, page: input.page, pageSize: input.pageSize };
        });
      }),

    getById: authedQuery
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return safeDb<CallDetailResult>("calls.getById", null, async (db) => {
          const call = (
            await db
              .select()
              .from(schema.calls)
              .where(eq(schema.calls.id, input.id))
              .limit(1)
          ).at(0);
          if (!call) return null;
          const events = await db
            .select()
            .from(schema.callEvents)
            .where(eq(schema.callEvents.callId, input.id))
            .orderBy(schema.callEvents.id);
          const recording = (
            await db
              .select()
              .from(schema.recordings)
              .where(eq(schema.recordings.callId, input.id))
              .limit(1)
          ).at(0);
          return { call, events, recording: recording ?? null };
        });
      }),

    /** Agent workspace quick stats (today). */
    myStatsToday: authedQuery.query(async ({ ctx }) => {
      const fallback = { total: 0, completed: 0, missed: 0, talkSec: 0 };
      return safeDb("calls.myStatsToday", fallback, async (db) => {
        const today = sql`DATE(${schema.calls.startedAt}) = CURDATE()`;
        const rows = await db
          .select({
            status: schema.calls.status,
            durationSec: schema.calls.durationSec,
          })
          .from(schema.calls)
          .where(and(eq(schema.calls.agentId, ctx.user.id), today));
        const completed = rows.filter((r) => r.status === "completed");
        return {
          total: rows.length,
          completed: completed.length,
          missed: rows.filter((r) => r.status === "missed").length,
          talkSec: completed.reduce((s, r) => s + (r.durationSec ?? 0), 0),
        };
      });
    }),
  }),

  /** Live event feed for analysis surfaces (also used by admin dock). */
  events: createRouter({
    recent: authedQuery
      .input(z.object({ limit: z.number().default(30) }))
      .query(async ({ input }) => {
        await advanceSimulation();
        const { recentEvents } = await import("./simulator");
        return recentEvents(input.limit);
      }),
  }),

  /** Real-calling voice bridge (Twilio). */
  voice: createRouter({
    /** Public: is the real telephony provider configured? */
    status: publicQuery.query(() => ({ enabled: twilioConfigured() })),
    /** Authed: mint a Voice access token for the browser SDK. */
    token: authedQuery.query(({ ctx }) => {
      if (!twilioConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Twilio is not configured",
        });
      }
      return { token: generateVoiceToken(`user-${ctx.user.id}`) };
    }),
  }),

  /**
   * Direct REST dial endpoint (used by smoke tests and non-browser clients).
   * It is deliberately independent from MySQL: the Twilio call is placed first;
   * history persistence is best-effort and never changes the call result.
   */
  call: authedQuery
    .input(
      z.object({
        to: z.string().min(3),
        from: z.string().optional(),
        /** Optional second leg to bridge to after the first leg answers. */
        bridgeTo: z.string().optional(),
        clientCallId: z.string().optional(),
        speakerphoneAttempted: z.boolean().optional(),
        listenLiveAttempted: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!twilioRestConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Twilio REST credentials are not configured",
        });
      }
      const fromNumber = (input.from || twilioCallerIdFor("legA") || "").trim();
      if (!fromNumber) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "TWILIO_CALLER_ID is not configured",
        });
      }
      const client = getTwilioClient();
      const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
      const say = "CloudTalk call connected.";
      const twiml = input.bridgeTo
        ? `<Response><Dial callerId="${escapeXml(fromNumber)}">${escapeXml(input.bridgeTo)}</Dial></Response>`
        : `<Response><Say voice="alice">${say}</Say><Pause length="60"/></Response>`;
      const call = await client.calls.create({
        to: input.to,
        from: fromNumber,
        twiml,
        ...(publicBase
          ? {
              statusCallback: `${publicBase}/api/voice/status`,
              statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
              statusCallbackMethod: "POST",
            }
          : {}),
      });

      const persisted = await safeDb(
        "telephony.call.log",
        { id: 0, persisted: false },
        async (db) => {
          const [r] = await db.insert(schema.calls).values({
            direction: "outbound",
            status: mapTwilioStatus(call.status),
            fromNumber,
            toNumber: input.to,
            agentId: ctx.user.id,
            twilioSid: call.sid,
            clientCallId: input.clientCallId ?? null,
            speakerphoneAttempted: input.speakerphoneAttempted ?? false,
            listenLiveAttempted: input.listenLiveAttempted ?? false,
            startedAt: new Date(),
          });
          const id = Number((r as unknown as { insertId: number }).insertId);
          await logCallEvent(id, "call_ringing", {
            agentId: ctx.user.id,
            twilioSid: call.sid,
            rest: true,
            speakerphoneAttempted: input.speakerphoneAttempted ?? false,
            listenLiveAttempted: input.listenLiveAttempted ?? false,
          });
          return { id, persisted: true };
        },
      );

      return {
        sid: call.sid,
        status: call.status,
        id: persisted.id,
        persisted: persisted.persisted,
      };
    }),
});
