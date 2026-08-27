/**
 * CloudTalk simulated telephony engine (server-side, lazy-tick).
 *
 * Instead of background timers, simulation advances whenever any calls-related
 * procedure is invoked — every tick compares wall-clock time against each live
 * call's `simAnswerAt` / `simEndAt` schedule and applies the transitions,
 * appending rows to the `call_events` stream.
 *
 * PLUG-IN SURFACE for the user's future live-analysis logic:
 * every state transition funnels through `logCallEvent()`. A real telephony
 * provider (SIP/Twilio webhooks) or a live-analysis module can hook the same
 * event stream without touching the UI.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "@db/schema";
import { getDb } from "./queries/connection";

const LIVE_STATUSES = ["dialing", "ringing", "active", "held"] as const;

export async function logCallEvent(
  callId: number,
  type: string,
  payload?: Record<string, unknown>,
) {
  await getDb().insert(schema.callEvents).values({
    callId,
    type,
    payload: payload ? JSON.stringify(payload) : null,
  });
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

async function getSetting(key: string): Promise<string | null> {
  const rows = await getDb()
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .limit(1);
  return rows.at(0)?.value ?? null;
}

async function setSetting(key: string, value: string) {
  await getDb()
    .insert(schema.settings)
    .values({ key, value })
    .onDuplicateKeyUpdate({ set: { value } });
}

/** Fallback caller numbers when the directory is empty — AU mobile format. */
function randomAuNumber() {
  return `+61 4${String(Math.floor(rand(10, 99)))} ${String(
    Math.floor(rand(100, 999)),
  )} ${String(Math.floor(rand(100, 999)))}`;
}

/** Advance all live simulated calls according to their schedule. */
async function progressLiveCalls(now: Date) {
  const db = getDb();
  const live = await db
    .select()
    .from(schema.calls)
    .where(
      and(
        inArray(schema.calls.status, [...LIVE_STATUSES]),
        isNull(schema.calls.endedAt),
        // Only engine-owned calls carry a sim schedule; client-driven calls
        // (from the softphone UI) are advanced by client events instead.
        sql`${schema.calls.simEndAt} IS NOT NULL`,
      ),
    );

  for (const call of live) {
    const started = call.startedAt.getTime();
    const t = now.getTime();

    if (call.status === "dialing" && t - started > 800) {
      await db
        .update(schema.calls)
        .set({ status: "ringing" })
        .where(eq(schema.calls.id, call.id));
      await logCallEvent(call.id, "call_ringing", {
        direction: call.direction,
      });
      continue;
    }

    if (call.status === "ringing") {
      if (call.simAnswerAt && t >= call.simAnswerAt.getTime()) {
        await db
          .update(schema.calls)
          .set({ status: "active", answeredAt: now })
          .where(eq(schema.calls.id, call.id));
        await logCallEvent(call.id, "call_active", { answeredAt: t });
      } else if (!call.simAnswerAt && call.simEndAt && t >= call.simEndAt.getTime()) {
        // Unanswered → missed
        await db
          .update(schema.calls)
          .set({ status: "missed", endedAt: now })
          .where(eq(schema.calls.id, call.id));
        await logCallEvent(call.id, "call_ended", { reason: "no_answer" });
        if (call.extensionId) await setExtensionStatus(call.extensionId, "idle");
      }
      continue;
    }

    if (
      (call.status === "active" || call.status === "held") &&
      call.simEndAt &&
      t >= call.simEndAt.getTime()
    ) {
      const answeredAt = call.answeredAt ?? call.startedAt;
      const durationSec = Math.max(1, Math.round((t - answeredAt.getTime()) / 1000));
      const hasRecording = call.direction === "inbound" || Math.random() < 0.6;
      await db
        .update(schema.calls)
        .set({ status: "completed", endedAt: now, durationSec, hasRecording })
        .where(eq(schema.calls.id, call.id));
      if (hasRecording) {
        await db
          .insert(schema.recordings)
          .values({ callId: call.id, durationSec });
      }
      await logCallEvent(call.id, "call_ended", {
        reason: "completed",
        durationSec,
      });
      if (call.extensionId) await setExtensionStatus(call.extensionId, "idle");
    }
  }
}

async function setExtensionStatus(
  extensionId: number,
  status: "idle" | "ringing" | "in_call" | "held" | "offline",
) {
  await getDb()
    .update(schema.extensions)
    .set({ status })
    .where(eq(schema.extensions.id, extensionId));
}

/** Spawn new simulated traffic so the live monitor always has a pulse. */
async function maybeSpawnCall(now: Date) {
  const db = getDb();
  const liveCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.calls)
    .where(
      and(
        inArray(schema.calls.status, [...LIVE_STATUSES]),
        isNull(schema.calls.endedAt),
      ),
    );
  const live = Number(liveCount.at(0)?.n ?? 0);
  if (live >= 4) return;

  const lastSpawn = Number((await getSetting("sim.lastSpawnAt")) ?? 0);
  if (now.getTime() - lastSpawn < 18_000) return;
  await setSetting("sim.lastSpawnAt", String(now.getTime()));

  // Pick a random extension (assigned ones feel more realistic).
  const exts = await db.select().from(schema.extensions);
  if (exts.length === 0) return;
  const ext = exts[Math.floor(Math.random() * exts.length)];

  // Draw simulated callers from the REAL contacts directory — no fake names.
  const directory = await db
    .select({ name: schema.contacts.name, phone: schema.contacts.phone })
    .from(schema.contacts)
    .limit(200);
  const caller =
    directory.length > 0
      ? directory[Math.floor(Math.random() * directory.length)]
      : { name: null as string | null, phone: randomAuNumber() };

  const inbound = Math.random() < 0.6;
  const answered = Math.random() < 0.78;
  const answerDelay = rand(2000, 6000);
  const talkTime = rand(45_000, 240_000);
  const ringTimeout = 24_000;

  const agentRow = ext
    ? await db
        .select({ userId: schema.agentProfiles.userId })
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.extensionId, ext.id))
        .limit(1)
    : [];

  const [result] = await db.insert(schema.calls).values({
    direction: inbound ? "inbound" : "outbound",
    status: "ringing",
    fromNumber: inbound ? caller.phone : `ext ${ext.number}`,
    toNumber: inbound ? `ext ${ext.number}` : caller.phone,
    contactName: caller.name,
    agentId: agentRow.at(0)?.userId ?? null,
    extensionId: ext.id,
    startedAt: now,
    simAnswerAt: answered ? new Date(now.getTime() + answerDelay) : null,
    simEndAt: new Date(
      now.getTime() + (answered ? answerDelay + talkTime : ringTimeout),
    ),
  });
  const callId = Number((result as unknown as { insertId: number }).insertId);
  await setExtensionStatus(ext.id, "ringing");
  await logCallEvent(callId, inbound ? "incoming_call" : "call_ringing", {
    direction: inbound ? "inbound" : "outbound",
    simulated: true,
  });
}

/**
 * Advance the simulation. Called lazily from calls/admin procedures so every
 * read of live state is fresh without background workers.
 */
export async function advanceSimulation() {
  const now = new Date();
  try {
    await progressLiveCalls(now);
    await maybeSpawnCall(now);
  } catch (err) {
    // Simulation must never break real queries.
    console.error("[simulator] advance failed:", err);
  }
}

/** Recent global event feed — the stream the Live Analysis dock consumes. */
export async function recentEvents(limit = 30) {
  const db = getDb();
  return db
    .select({
      id: schema.callEvents.id,
      callId: schema.callEvents.callId,
      type: schema.callEvents.type,
      payload: schema.callEvents.payload,
      createdAt: schema.callEvents.createdAt,
      contactName: schema.calls.contactName,
      fromNumber: schema.calls.fromNumber,
      toNumber: schema.calls.toNumber,
      direction: schema.calls.direction,
    })
    .from(schema.callEvents)
    .innerJoin(schema.calls, eq(schema.callEvents.callId, schema.calls.id))
    .orderBy(desc(schema.callEvents.id))
    .limit(limit);
}
