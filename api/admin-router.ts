/**
 * Admin router: live monitoring dashboard, agents & extensions management,
 * org-wide call logs, recordings, and system settings (incl. the integrations
 * registry where future live-analysis modules get configured).
 */
import { and, desc, eq, gte, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@db/schema";
import { adminQuery, createRouter } from "./middleware";
import { getDb } from "./queries/connection";
import { advanceSimulation, recentEvents } from "./simulator";

export const adminRouter = createRouter({
  /* ----------------------------- dashboard ------------------------------ */
  dashboard: createRouter({
    /** KPI row + hourly sparkline + system health for the admin overview. */
    stats: adminQuery.query(async () => {
      await advanceSimulation();
      const db = getDb();
      const live = Number(
        (
          await db
            .select({ n: sql<number>`count(*)` })
            .from(schema.calls)
            .where(
              and(
                inArrayLive(),
                sql`${schema.calls.endedAt} IS NULL`,
              ),
            )
        ).at(0)?.n ?? 0,
      );
      const todayRows = await db
        .select({
          status: schema.calls.status,
          durationSec: schema.calls.durationSec,
          direction: schema.calls.direction,
        })
        .from(schema.calls)
        .where(sql`DATE(${schema.calls.startedAt}) = CURDATE()`);
      const completed = todayRows.filter((r) => r.status === "completed");
      const missed = todayRows.filter((r) => r.status === "missed");
      const agents = await db
        .select({ presence: schema.agentProfiles.presence })
        .from(schema.agentProfiles);

      // Hourly volume for the last 12 hours (sparkline).
      const since = new Date(Date.now() - 12 * 3600_000);
      const recent = await db
        .select({ startedAt: schema.calls.startedAt })
        .from(schema.calls)
        .where(gte(schema.calls.startedAt, since));
      const buckets = new Array<number>(12).fill(0);
      for (const r of recent) {
        const idx = Math.min(
          11,
          Math.floor(
            (r.startedAt.getTime() - since.getTime()) / 3600_000,
          ),
        );
        buckets[idx] += 1;
      }

      return {
        liveCalls: live,
        callsToday: todayRows.length,
        missedToday: missed.length,
        answerRate:
          todayRows.length === 0
            ? 100
            : Math.round((completed.length / Math.max(1, todayRows.length)) * 100),
        avgDurationSec:
          completed.length === 0
            ? 0
            : Math.round(
                completed.reduce((s, r) => s + (r.durationSec ?? 0), 0) /
                  completed.length,
              ),
        agentsOnline: agents.filter(
          (a) => a.presence === "available" || a.presence === "busy",
        ).length,
        agentsTotal: agents.length,
        hourlyVolume: buckets,
      };

      function inArrayLive() {
        return sql`${schema.calls.status} IN ('dialing','ringing','active','held')`;
      }
    }),

    /** Live active calls with agent/extension context — the mission-control feed. */
    activeCalls: adminQuery.query(async () => {
      await advanceSimulation();
      const db = getDb();
      return db
        .select({
          call: schema.calls,
          agentName: schema.users.name,
          extensionNumber: schema.extensions.number,
        })
        .from(schema.calls)
        .leftJoin(schema.users, eq(schema.calls.agentId, schema.users.id))
        .leftJoin(
          schema.extensions,
          eq(schema.calls.extensionId, schema.extensions.id),
        )
        .where(
          and(
            sql`${schema.calls.status} IN ('dialing','ringing','active','held')`,
            sql`${schema.calls.endedAt} IS NULL`,
          ),
        )
        .orderBy(desc(schema.calls.startedAt))
        .limit(20);
    }),

    /** Global event stream — consumed by the Live Analysis dock tickers. */
    eventFeed: adminQuery
      .input(z.object({ limit: z.number().default(30) }))
      .query(async ({ input }) => {
        await advanceSimulation();
        return recentEvents(input.limit);
      }),
  }),

  /* --------------------------- agents & exts ----------------------------- */
  agents: createRouter({
    list: adminQuery.query(async () => {
      const db = getDb();
      return db
        .select({
          id: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
          role: schema.users.role,
          lastSignInAt: schema.users.lastSignInAt,
          presence: schema.agentProfiles.presence,
          title: schema.agentProfiles.title,
          department: schema.agentProfiles.department,
          extensionId: schema.extensions.id,
          extensionNumber: schema.extensions.number,
          extensionStatus: schema.extensions.status,
        })
        .from(schema.users)
        .leftJoin(
          schema.agentProfiles,
          eq(schema.agentProfiles.userId, schema.users.id),
        )
        .leftJoin(
          schema.extensions,
          eq(schema.agentProfiles.extensionId, schema.extensions.id),
        )
        .orderBy(schema.users.name);
    }),

    update: adminQuery
      .input(
        z.object({
          userId: z.number(),
          role: z.enum(["user", "admin"]).optional(),
          presence: z.enum(["available", "busy", "away", "offline"]).optional(),
          title: z.string().optional(),
          department: z.string().optional(),
          extensionId: z.number().nullable().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const db = getDb();
        if (input.role) {
          await db
            .update(schema.users)
            .set({ role: input.role })
            .where(eq(schema.users.id, input.userId));
        }
        const existing = await db
          .select()
          .from(schema.agentProfiles)
          .where(eq(schema.agentProfiles.userId, input.userId))
          .limit(1);
        if (existing.at(0)) {
          await db
            .update(schema.agentProfiles)
            .set({
              ...(input.presence ? { presence: input.presence } : {}),
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.department !== undefined
                ? { department: input.department }
                : {}),
              ...(input.extensionId !== undefined
                ? { extensionId: input.extensionId }
                : {}),
            })
            .where(eq(schema.agentProfiles.userId, input.userId));
        } else {
          await db.insert(schema.agentProfiles).values({
            userId: input.userId,
            presence: input.presence ?? "offline",
            title: input.title,
            department: input.department,
            extensionId: input.extensionId ?? null,
          });
        }
        return { ok: true };
      }),
  }),

  extensions: createRouter({
    list: adminQuery.query(async () => {
      const db = getDb();
      return db
        .select({
          extension: schema.extensions,
          agentName: schema.users.name,
          agentId: schema.users.id,
        })
        .from(schema.extensions)
        .leftJoin(
          schema.agentProfiles,
          eq(schema.agentProfiles.extensionId, schema.extensions.id),
        )
        .leftJoin(schema.users, eq(schema.agentProfiles.userId, schema.users.id))
        .orderBy(schema.extensions.number);
    }),

    create: adminQuery
      .input(z.object({ number: z.string().min(2), label: z.string().optional() }))
      .mutation(async ({ input }) => {
        await getDb().insert(schema.extensions).values(input);
        return { ok: true };
      }),

    setStatus: adminQuery
      .input(
        z.object({
          id: z.number(),
          status: z.enum(["idle", "ringing", "in_call", "held", "offline"]),
        }),
      )
      .mutation(async ({ input }) => {
        await getDb()
          .update(schema.extensions)
          .set({ status: input.status })
          .where(eq(schema.extensions.id, input.id));
        return { ok: true };
      }),
  }),

  /* ------------------------------- logs --------------------------------- */
  logs: createRouter({
    list: adminQuery
      .input(
        z.object({
          page: z.number().default(1),
          pageSize: z.number().default(25),
          direction: z.enum(["inbound", "outbound"]).optional(),
          status: z
            .enum(["completed", "missed", "failed", "active", "held", "ringing"])
            .optional(),
          search: z.string().optional(),
          days: z.number().default(30),
        }),
      )
      .query(async ({ input }) => {
        await advanceSimulation();
        const db = getDb();
        const conds = [
          gte(
            schema.calls.startedAt,
            new Date(Date.now() - input.days * 24 * 3600_000),
          ),
        ];
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
          .select({
            call: schema.calls,
            agentName: schema.users.name,
            extensionNumber: schema.extensions.number,
          })
          .from(schema.calls)
          .leftJoin(schema.users, eq(schema.calls.agentId, schema.users.id))
          .leftJoin(
            schema.extensions,
            eq(schema.calls.extensionId, schema.extensions.id),
          )
          .where(where)
          .orderBy(desc(schema.calls.startedAt))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize);
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),

    /** Daily volume histogram for the filter strip (last N days). */
    histogram: adminQuery
      .input(z.object({ days: z.number().default(30) }))
      .query(async ({ input }) => {
        const db = getDb();
        const since = new Date(Date.now() - input.days * 24 * 3600_000);
        const rows = await db
          .select({ startedAt: schema.calls.startedAt })
          .from(schema.calls)
          .where(gte(schema.calls.startedAt, since));
        const buckets = new Array<number>(input.days).fill(0);
        const now = Date.now();
        for (const r of rows) {
          const idx = Math.min(
            input.days - 1,
            Math.floor((r.startedAt.getTime() - (now - input.days * 24 * 3600_000)) / (24 * 3600_000)),
          );
          if (idx >= 0) buckets[idx] += 1;
        }
        return buckets;
      }),

    recording: adminQuery
      .input(z.object({ callId: z.number() }))
      .query(async ({ input }) => {
        const rec = (
          await getDb()
            .select()
            .from(schema.recordings)
            .where(eq(schema.recordings.callId, input.callId))
            .limit(1)
        ).at(0);
        return rec ?? null;
      }),
  }),

  /* ------------------------------ settings ------------------------------- */
  settings: createRouter({
    getAll: adminQuery.query(async () => {
      const rows = await getDb().select().from(schema.settings);
      return Object.fromEntries(rows.map((r) => [r.key, r.value ?? ""]));
    }),

    set: adminQuery
      .input(z.object({ key: z.string().min(1), value: z.string() }))
      .mutation(async ({ input }) => {
        await getDb()
          .insert(schema.settings)
          .values({ key: input.key, value: input.value })
          .onDuplicateKeyUpdate({ set: { value: input.value } });
        return { ok: true };
      }),
  }),
});
