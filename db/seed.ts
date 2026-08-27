/**
 * CloudTalk demo seed: agents + extensions, contacts, 30 days of call logs,
 * recordings, settings, and a few live simulated calls.
 * Run: npx tsx db/seed.ts   (idempotent-ish: skips if calls already exist)
 */
import { sql } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import * as schema from "./schema";

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

const AGENTS = [
  { name: "Ava Reyes", email: "ava@cloudtalk.demo", title: "Senior Agent", department: "Support", presence: "available" as const },
  { name: "Liam Novak", email: "liam@cloudtalk.demo", title: "Agent", department: "Support", presence: "available" as const },
  { name: "Chloe Dubois", email: "chloe@cloudtalk.demo", title: "Agent", department: "Sales", presence: "busy" as const },
  { name: "Marcus Chen", email: "marcus@cloudtalk.demo", title: "Team Lead", department: "Support", presence: "busy" as const },
  { name: "Ingrid Solberg", email: "ingrid@cloudtalk.demo", title: "Agent", department: "Sales", presence: "available" as const },
  { name: "Omar Haddad", email: "omar@cloudtalk.demo", title: "Agent", department: "Success", presence: "busy" as const },
  { name: "Yuki Mori", email: "yuki@cloudtalk.demo", title: "Agent", department: "Support", presence: "away" as const },
  { name: "Elena Petrova", email: "elena@cloudtalk.demo", title: "Agent", department: "Success", presence: "away" as const },
  { name: "Tomás Silva", email: "tomas@cloudtalk.demo", title: "Agent", department: "Sales", presence: "available" as const },
  { name: "Grace Adeyemi", email: "grace@cloudtalk.demo", title: "Agent", department: "Support", presence: "offline" as const },
  { name: "Finn O'Connor", email: "finn@cloudtalk.demo", title: "Agent", department: "Success", presence: "offline" as const },
];

const CONTACTS: Array<[string, string, string, schema.Contact["tag"]]> = [
  ["Maya Lindqvist", "Northwind Retail", "+46 70 552 89 14", "vip"],
  ["Derek Okafor", "Vertex Logistics", "+1 415 555 0182", "customer"],
  ["Sofia Marchetti", "Marchetti & Co", "+39 02 8736 4410", "lead"],
  ["Haruto Tanaka", "Sakura Systems", "+81 3 4520 9982", "customer"],
  ["Amelia Foster", "Foster Legal", "+44 20 7946 0318", "vip"],
  ["Lucas Meyer", "Meyer Bau GmbH", "+49 30 2201 8874", "supplier"],
  ["Priya Raman", "Raman Analytics", "+91 98 2204 7715", "lead"],
  ["Noah Williams", "Bluepeak Media", "+1 646 555 0147", "customer"],
  ["Isabella Costa", "Costa Imports", "+55 11 9982 4430", "supplier"],
  ["Jonas Weber", "Weber & Söhne", "+49 89 5520 1173", "customer"],
  ["Anaïs Bernard", "Maison Bernard", "+33 1 44 90 22 18", "vip"],
  ["Ethan Clark", "Clarkson Foods", "+1 312 555 0119", "lead"],
  ["Freya Nilsen", "Nordic Freight", "+47 22 41 88 30", "supplier"],
  ["Gabriel Rossi", "Rossi Trattoria", "+39 06 4420 7712", "customer"],
  ["Hana Kim", "Kimsoft", "+82 2 5510 3342", "lead"],
  ["Ivan Petrov", "Baltic Shipping", "+7 812 440 22 91", "supplier"],
  ["Julia Novak", "Novak Design", "+48 22 630 44 17", "customer"],
  ["Kai Andersen", "Andersen Marine", "+45 33 92 11 08", "customer"],
  ["Lara Haddad", "Haddad Trading", "+961 1 442 890", "lead"],
  ["Mateo García", "García & Hijos", "+34 91 552 30 74", "customer"],
  ["Nina Kowalski", "Kowalski Pharma", "+48 12 440 92 31", "vip"],
  ["Oliver Smith", "Smith & Weston", "+1 212 555 0163", "lead"],
  ["Paula Mendes", "Mendes Studio", "+351 21 440 18 72", "customer"],
  ["Quentin Laurent", "Laurent Vins", "+33 5 56 90 44 21", "supplier"],
];

const DEFAULT_SETTINGS: Record<string, string> = {
  "telephony.provider": "simulated",
  "telephony.callerId": "+1 415 555 0100",
  "routing.strategy": "round_robin",
  "routing.maxRingSec": "24",
  "recording.policy": "inbound_plus_random",
  "recording.enabled": "true",
  "security.requireMfa": "false",
  "integrations.analysisEndpoint": "",
  "integrations.analysisEnabled": "false",
};

async function seed() {
  const db = getDb();
  console.log("Seeding CloudTalk demo data...");

  const existing = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.calls);
  if (Number(existing.at(0)?.n ?? 0) > 0) {
    console.log("Calls table already populated — skipping seed.");
    process.exit(0);
  }

  /* Settings */
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db
      .insert(schema.settings)
      .values({ key, value })
      .onDuplicateKeyUpdate({ set: { value } });
  }

  /* Extensions 100–131 */
  const extIds: number[] = [];
  for (let n = 100; n <= 131; n++) {
    const [r] = await db
      .insert(schema.extensions)
      .values({ number: String(n), label: `Extension ${n}` })
      .onDuplicateKeyUpdate({ set: { label: `Extension ${n}` } });
    const id = Number((r as unknown as { insertId: number }).insertId);
    if (id) extIds.push(id);
  }
  const allExts = await db.select().from(schema.extensions);
  const extByNumber = new Map(allExts.map((e) => [e.number, e.id]));

  /* Agents (seeded users + profiles) */
  const agentUserIds: number[] = [];
  for (let i = 0; i < AGENTS.length; i++) {
    const a = AGENTS[i];
    await db
      .insert(schema.users)
      .values({
        unionId: `seed-agent-${i}`,
        name: a.name,
        email: a.email,
        role: i === 0 ? "admin" : "user",
      })
      .onDuplicateKeyUpdate({ set: { name: a.name } });
    const user = (
      await db
        .select()
        .from(schema.users)
        .where(sql`${schema.users.unionId} = ${`seed-agent-${i}`}`)
        .limit(1)
    ).at(0)!;
    agentUserIds.push(user.id);
    const extId = extByNumber.get(String(100 + i)) ?? null;
    await db
      .insert(schema.agentProfiles)
      .values({
        userId: user.id,
        extensionId: extId,
        presence: a.presence,
        title: a.title,
        department: a.department,
      })
      .onDuplicateKeyUpdate({
        set: { presence: a.presence, title: a.title, department: a.department },
      });
  }

  /* Contacts */
  const contactIds: number[] = [];
  for (const [name, company, phone, tag] of CONTACTS) {
    const [r] = await db
      .insert(schema.contacts)
      .values({ name, company, phone, tag, favorite: Math.random() < 0.25 });
    contactIds.push(Number((r as unknown as { insertId: number }).insertId));
  }
  const allContacts = await db.select().from(schema.contacts);

  /* 30 days of call history (~340 rows) + events + recordings */
  const now = Date.now();
  const dayMs = 24 * 3600_000;
  let inserted = 0;
  for (let i = 0; i < 345; i++) {
    const contact = pick(allContacts);
    const agentIdx = randInt(0, AGENTS.length - 1);
    const direction = Math.random() < 0.52 ? ("inbound" as const) : ("outbound" as const);
    const roll = Math.random();
    const status =
      roll < 0.72 ? ("completed" as const) : roll < 0.88 ? ("missed" as const) : ("failed" as const);
    const startedAt = new Date(now - rand(0.02, 30) * dayMs);
    const durationSec = status === "completed" ? randInt(25, 720) : 0;
    const answeredAt = status === "completed" ? new Date(startedAt.getTime() + randInt(3, 18) * 1000) : null;
    const endedAt = status === "completed" && answeredAt ? new Date(answeredAt.getTime() + durationSec * 1000) : new Date(startedAt.getTime() + 24_000);
    const hasRecording = status === "completed" && Math.random() < 0.6;
    const extId = extByNumber.get(String(100 + agentIdx)) ?? null;

    const [r] = await db.insert(schema.calls).values({
      direction,
      status,
      fromNumber: direction === "inbound" ? contact.phone : `ext ${100 + agentIdx}`,
      toNumber: direction === "inbound" ? `ext ${100 + agentIdx}` : contact.phone,
      contactName: contact.name,
      contactId: contact.id,
      agentId: agentUserIds[agentIdx],
      extensionId: extId,
      startedAt,
      answeredAt,
      endedAt,
      durationSec,
      hasRecording,
    });
    const callId = Number((r as unknown as { insertId: number }).insertId);
    await db.insert(schema.callEvents).values({
      callId,
      type: direction === "inbound" ? "incoming_call" : "call_ringing",
      createdAt: startedAt,
    });
    if (answeredAt) {
      await db.insert(schema.callEvents).values({ callId, type: "call_active", createdAt: answeredAt });
    }
    await db.insert(schema.callEvents).values({
      callId,
      type: "call_ended",
      payload: JSON.stringify({ reason: status === "completed" ? "completed" : "no_answer", durationSec }),
      createdAt: endedAt,
    });
    if (hasRecording) {
      await db.insert(schema.recordings).values({ callId, durationSec });
    }
    inserted++;
  }
  console.log(`Inserted ${inserted} historical calls.`);

  /* A few live calls so the admin dashboard has a pulse on first load */
  for (let i = 0; i < 4; i++) {
    const contact = pick(allContacts);
    const agentIdx = randInt(0, 4);
    const inbound = i % 2 === 0;
    const answered = i !== 3; // one ringing call
    const startedAt = new Date(now - randInt(20, 300) * 1000);
    const answeredAt = answered ? new Date(startedAt.getTime() + 4000) : null;
    const [r] = await db.insert(schema.calls).values({
      direction: inbound ? "inbound" : "outbound",
      status: answered ? (i === 2 ? "held" : "active") : "ringing",
      fromNumber: inbound ? contact.phone : `ext ${100 + agentIdx}`,
      toNumber: inbound ? `ext ${100 + agentIdx}` : contact.phone,
      contactName: contact.name,
      contactId: contact.id,
      agentId: agentUserIds[agentIdx],
      extensionId: extByNumber.get(String(100 + agentIdx)) ?? null,
      startedAt,
      answeredAt,
      simAnswerAt: answered ? null : new Date(now + 5000),
      simEndAt: new Date(now + randInt(120, 420) * 1000),
    });
    const callId = Number((r as unknown as { insertId: number }).insertId);
    await db.insert(schema.callEvents).values({
      callId,
      type: inbound ? "incoming_call" : "call_ringing",
      createdAt: startedAt,
    });
    if (answeredAt) {
      await db.insert(schema.callEvents).values({ callId, type: "call_active", createdAt: answeredAt });
    }
  }

  console.log("Done. Seeded agents, extensions, contacts, calls, recordings, settings.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
