/**
 * Agent-facing telephony router: contacts, presence, and call lifecycle
 * mirroring. The softphone UI runs its snappy client-side simulation; these
 * procedures persist the lifecycle so history, recordings and the admin live
 * monitor all share one source of truth.
 */
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as schema from "@db/schema";
import { authedQuery, createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { advanceSimulation, logCallEvent } from "./simulator";
import { generateVoiceToken, twilioConfigured } from "./twilio-voice";

const presenceEnum = z.enum(["available", "busy", "away", "offline"]);

async function ensureProfile(userId: number) {
  const db = getDb();
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
  return created[0];
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
        const db = getDb();
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
        const db = getDb();
        const [r] = await db.insert(schema.contacts).values({
          ...input,
          ownerId: ctx.user.id,
        });
        return { id: Number((r as unknown as { insertId: number }).insertId) };
      }),

    toggleFavorite: authedQuery
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const db = getDb();
        await db
          .update(schema.contacts)
          .set({ favorite: sql`NOT ${schema.contacts.favorite}` })
          .where(eq(schema.contacts.id, input.id));
        return { ok: true };
      }),

    remove: authedQuery
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await getDb()
          .delete(schema.contacts)
          .where(eq(schema.contacts.id, input.id));
        return { ok: true };
      }),
  }),

  /* ------------------------------ presence ------------------------------ */
  presence: createRouter({
    set: authedQuery
      .input(z.object({ presence: presenceEnum }))
      .mutation(async ({ input, ctx }) => {
        await ensureProfile(ctx.user.id);
        await getDb()
          .update(schema.agentProfiles)
          .set({ presence: input.presence })
          .where(eq(schema.agentProfiles.userId, ctx.user.id));
        return { ok: true };
      }),
    mine: authedQuery.query(async ({ ctx }) => {
      const profile = await ensureProfile(ctx.user.id);
      return profile;
    }),
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
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const db = getDb();
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
        });
        const id = Number((r as unknown as { insertId: number }).insertId);
        await logCallEvent(
          id,
          input.direction === "inbound" ? "incoming_call" : "call_ringing",
          { agentId: ctx.user.id },
        );
        return { id };
      }),

    /**
     * Append a lifecycle event and mirror the call state.
     * Types: call_ringing | call_active | call_held | call_resumed |
     *        call_muted | call_unmuted | dtmf | call_ended
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
        const db = getDb();
        await logCallEvent(input.callId, input.type, input.payload);
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
        return { ok: true };
      }),

    addNote: authedQuery
      .input(z.object({ callId: z.number(), note: z.string() }))
      .mutation(async ({ input }) => {
        await getDb()
          .update(schema.calls)
          .set({ note: input.note })
          .where(eq(schema.calls.id, input.callId));
        return { ok: true };
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
        }),
      )
      .query(async ({ input, ctx }) => {
        const db = getDb();
        const conds = [eq(schema.calls.agentId, ctx.user.id)];
        if (input.direction)
          conds.push(eq(schema.calls.direction, input.direction));
        if (input.status) conds.push(eq(schema.calls.status, input.status));
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
      }),

    getById: authedQuery
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const db = getDb();
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
      }),

    /** Agent workspace quick stats (today). */
    myStatsToday: authedQuery.query(async ({ ctx }) => {
      const db = getDb();
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
  call: authedMutation
    .input(z.object({ to: z.string(), from: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const client = getTwilioClient();
      const fromNumber = input.from || process.env.TWILIO_CALLER_ID!;
      const call = await client.calls.create({
        to: input.to,
        from: fromNumber,
        twiml: `<Response><Dial callerId="${fromNumber}">${input.to}</Dial></Response>`,
      });
      return { sid: call.sid, status: call.status };
    }),
        });
      }
      return { token: generateVoiceToken(`user-${ctx.user.id}`) };
    }),
  }),
});
  call: authedMutation
    .input(z.object({ to: z.string(), from: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const client = getTwilioClient();
      const fromNumber = input.from || process.env.TWILIO_CALLER_ID!;
      const call = await client.calls.create({
        to: input.to,
        from: fromNumber,
        twiml: `<Response><Dial callerId="${fromNumber}">${input.to}</Dial></Response>`,
      });
      return { sid: call.sid, status: call.status };
    }),
