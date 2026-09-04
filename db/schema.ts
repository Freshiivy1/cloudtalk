import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  text,
  timestamp,
  bigint,
  int,
  boolean,
  index,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  unionId: varchar("unionId", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/* -------------------------------------------------------------------------- */
/* CloudTalk — VoIP domain model                                               */
/* -------------------------------------------------------------------------- */

/** Telephony extensions (100–131). Assigned to agents via agentProfiles. */
export const extensions = mysqlTable("extensions", {
  id: serial("id").primaryKey(),
  number: varchar("number", { length: 8 }).notNull().unique(),
  label: varchar("label", { length: 255 }),
  status: mysqlEnum("status", ["idle", "ringing", "in_call", "held", "offline"])
    .default("idle")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Extension = typeof extensions.$inferSelect;
export type InsertExtension = typeof extensions.$inferInsert;

/** Per-user agent profile: presence + extension assignment. */
export const agentProfiles = mysqlTable("agent_profiles", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true })
    .notNull()
    .unique(),
  extensionId: bigint("extensionId", { mode: "number", unsigned: true }),
  presence: mysqlEnum("presence", ["available", "busy", "away", "offline"])
    .default("offline")
    .notNull(),
  title: varchar("title", { length: 255 }),
  department: varchar("department", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type AgentProfile = typeof agentProfiles.$inferSelect;
export type InsertAgentProfile = typeof agentProfiles.$inferInsert;

/** Contacts directory. ownerId NULL = org-wide directory entry. */
export const contacts = mysqlTable("contacts", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  company: varchar("company", { length: 255 }),
  phone: varchar("phone", { length: 32 }).notNull(),
  email: varchar("email", { length: 320 }),
  tag: mysqlEnum("tag", ["vip", "lead", "customer", "supplier"])
    .default("customer")
    .notNull(),
  favorite: boolean("favorite").default(false).notNull(),
  ownerId: bigint("ownerId", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Contact = typeof contacts.$inferSelect;
export type InsertContact = typeof contacts.$inferInsert;

/**
 * Call sessions. `simAnswerAt` / `simEndAt` drive the server-side simulated
 * telephony engine (lazy tick) — a real provider replaces these with webhooks.
 */
export const calls = mysqlTable("calls", {
  id: serial("id").primaryKey(),
  direction: mysqlEnum("direction", ["inbound", "outbound"]).notNull(),
  status: mysqlEnum("status", [
    "dialing",
    "ringing",
    "active",
    "held",
    "completed",
    "missed",
    "failed",
  ]).notNull(),
  fromNumber: varchar("fromNumber", { length: 32 }).notNull(),
  toNumber: varchar("toNumber", { length: 32 }).notNull(),
  contactName: varchar("contactName", { length: 255 }),
  agentId: bigint("agentId", { mode: "number", unsigned: true }),
  extensionId: bigint("extensionId", { mode: "number", unsigned: true }),
  contactId: bigint("contactId", { mode: "number", unsigned: true }),
  /** Real-provider correlation IDs (NULL for simulated calls). */
  twilioSid: varchar("twilioSid", { length: 64 }),
  clientCallId: varchar("clientCallId", { length: 80 }),
  /** Speakerphone / listen-live audit flags requested by the user. */
  speakerphoneAttempted: boolean("speakerphoneAttempted").default(false).notNull(),
  speakerphoneUsed: boolean("speakerphoneUsed").default(false).notNull(),
  listenLiveAttempted: boolean("listenLiveAttempted").default(false).notNull(),
  listenLiveUsed: boolean("listenLiveUsed").default(false).notNull(),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  answeredAt: timestamp("answeredAt"),
  endedAt: timestamp("endedAt"),
  durationSec: int("durationSec").default(0).notNull(),
  muted: boolean("muted").default(false).notNull(),
  /** Supreme-flag review marker (speakerphone strike ladder exhausted). */
  flagged: boolean("flagged").default(false).notNull(),
  flagReason: varchar("flagReason", { length: 255 }),
  hasRecording: boolean("hasRecording").default(false).notNull(),
  note: text("note"),
  simAnswerAt: timestamp("simAnswerAt"),
  simEndAt: timestamp("simEndAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  twilioSidIdx: index("idx_calls_twilio_sid").on(table.twilioSid),
  clientCallIdIdx: index("idx_calls_client_call_id").on(table.clientCallId),
}));
export type Call = typeof calls.$inferSelect;
export type InsertCall = typeof calls.$inferInsert;

/**
 * Append-only telephony event stream — one row per state transition.
 * THIS is the integration surface for the user's future live-analysis
 * logic/tools: consume callEvents (per call or globally) and emit analysis.
 */
export const callEvents = mysqlTable("call_events", {
  id: serial("id").primaryKey(),
  callId: bigint("callId", { mode: "number", unsigned: true }).notNull(),
  type: varchar("type", { length: 40 }).notNull(),
  payload: text("payload"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type CallEvent = typeof callEvents.$inferSelect;
export type InsertCallEvent = typeof callEvents.$inferInsert;

/** Call recordings (metadata only in the simulated system). */
export const recordings = mysqlTable("recordings", {
  id: serial("id").primaryKey(),
  callId: bigint("callId", { mode: "number", unsigned: true }).notNull(),
  durationSec: int("durationSec").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Recording = typeof recordings.$inferSelect;
export type InsertRecording = typeof recordings.$inferInsert;

/** Key-value system settings (telephony profile, routing, integrations). */
export const settings = mysqlTable("settings", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 128 }).notNull().unique(),
  value: text("value"),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type Setting = typeof settings.$inferSelect;
export type InsertSetting = typeof settings.$inferInsert;

// TODO: Add your tables here. See docs/Database.md for schema examples and patterns.

/* -------------------------------------------------------------------------- */
/* CallVerify port — phone-number verification sessions (Twilio orchestrated)  */
/* -------------------------------------------------------------------------- */

/**
 * Verification session lifecycle (ported from piecebyte's CallVerify):
 * INITIATED → CALLER_HOLDING → LEG_A_DIALING → CALL_ACCEPTED → CALLEE_READY
 *   → LEG_B_DIALING → LEG_B_ANSWERED → one of
 *   {COMPLETED, MERGE_DETECTED, VOIP_DETECTED, CALL_WAITING_OFF, FAILED}.
 * Call-leg identity is tracked via Twilio Call SIDs (replaces Asterisk channels).
 */
export const verificationSessions = mysqlTable(
  "verification_sessions",
  {
    id: serial("id").primaryKey(),
    /** uuid-no-dashes public session identifier (used in webhook URLs) */
    sessionId: varchar("sessionId", { length: 64 }).notNull().unique(),
    /** optional — when absent the caller leg + CALLER_HOLDING are skipped */
    callerNumber: varchar("callerNumber", { length: 32 }),
    calleeNumber: varchar("calleeNumber", { length: 32 }).notNull(),
    legBNumber: varchar("legBNumber", { length: 32 }),
    ringTestNumber: varchar("ringTestNumber", { length: 32 }),
    state: varchar("state", { length: 32 }).notNull(),
    /**
     * Guarded inmate-call mode marker (additive, nullable). TRUE when the
     * session was created via verification.initiateGuarded (caller leg = the
     * agent's browser softphone, `client:user-N`). Guarded sessions bridge
     * caller + callee live (state BRIDGED) once verification passes instead
     * of the notify-* verdict announcements. NULL/false = legacy behavior.
     */
    guarded: boolean("guarded"),
    callerCallSid: varchar("callerCallSid", { length: 64 }),
    legACallSid: varchar("legACallSid", { length: 64 }),
    legBCallSid: varchar("legBCallSid", { length: 64 }),
    ringTestCallSid: varchar("ringTestCallSid", { length: 64 }),
    legBOriginatedAt: timestamp("legBOriginatedAt"),
    toneDetected: boolean("toneDetected").default(false).notNull(),
    toneDetectedAt: timestamp("toneDetectedAt"),
    /** true once an SMS has been dispatched — prevents duplicate sends */
    smsSent: boolean("smsSent").default(false).notNull(),
    /**
     * GUARDED MODE ONLY: the explicit voice-ID <Record> clip ("my voice
     * identifies me") — Twilio recording URL (auth-protected) + duration so
     * the call-review UI can play it back through the audio proxy.
     */
    voiceRecordingUrl: varchar("voiceRecordingUrl", { length: 512 }),
    voiceRecordingDurationSec: int("voiceRecordingDurationSec"),
    voiceRecordedAt: timestamp("voiceRecordedAt"),
    /**
     * GUARDED MODE ONLY: save-only voice ID ("my voice identifies me") — the
     * phrase is recorded and the voiceprint profile is built, but NO voice
     * matching is performed. The capture is stamped here against the session
     * (and thereby the Leg B call it originates) and is valid for the SAME
     * UTC calendar day as the call only (see voiceIdFreshForToday) — a fresh
     * capture is required each day; a prior-day capture is never reused.
     */
    voiceIdCapturedAt: timestamp("voiceIdCapturedAt", { fsp: 3 }),
    voiceIdRecordingSid: varchar("voiceIdRecordingSid", { length: 64 }),
    /**
     * GUARDED MODE ONLY: the live bridge conference recording (record-from-
     * start) — the full two-way conversation for call review.
     */
    bridgeRecordingSid: varchar("bridgeRecordingSid", { length: 64 }),
    bridgeRecordingUrl: varchar("bridgeRecordingUrl", { length: 512 }),
    bridgeRecordingDurationSec: int("bridgeRecordingDurationSec"),
    bridgeRecordedAt: timestamp("bridgeRecordedAt"),
    /**
     * Two-phase Call Waiting challenge (corrected architecture) — persisted so
     * a restart can reconstruct readiness/phase without process memory:
     *  - streamSid / streamReadyAt: the relay's stream-ready acknowledgement;
     *  - streamReadyBy: readiness deadline set at Leg B answer (a miss is
     *    DETECTION_FAILED, never a silent pass);
     *  - challengeStartedAt / promptLightDurationMs / promptEndsAt: Phase 1
     *    (prompt-light) window, started ONLY after stream-ready;
     *  - detectionPhase: AWAITING_STREAM_READY | PROMPT_LIGHT | LOUD_DTMF.
     */
    streamSid: varchar("streamSid", { length: 64 }),
    // Millisecond precision is required: the Phase 1 boundary is derived from
    // an exact measured WAV duration and must survive a process restart.
    streamReadyAt: timestamp("streamReadyAt", { fsp: 3 }),
    streamReadyBy: timestamp("streamReadyBy", { fsp: 3 }),
    challengeStartedAt: timestamp("challengeStartedAt", { fsp: 3 }),
    promptLightDurationMs: int("promptLightDurationMs"),
    promptEndsAt: timestamp("promptEndsAt", { fsp: 3 }),
    detectionPhase: varchar("detectionPhase", { length: 32 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
    failureReason: varchar("failureReason", { length: 512 }),
  },
  (table) => ({
    sessionIdIdx: index("idx_verification_session_id").on(table.sessionId),
    stateIdx: index("idx_verification_state").on(table.state),
  }),
);
export type VerificationSession = typeof verificationSessions.$inferSelect;
export type InsertVerificationSession = typeof verificationSessions.$inferInsert;

/** Append-only per-session event timeline (ported from session_events). */
export const verificationEvents = mysqlTable(
  "verification_events",
  {
    id: serial("id").primaryKey(),
    sessionId: varchar("sessionId", { length: 64 }).notNull(),
    eventType: varchar("eventType", { length: 64 }).notNull(),
    details: varchar("details", { length: 512 }),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
  },
  (table) => ({
    sessionIdIdx: index("idx_verification_events_session_id").on(
      table.sessionId,
    ),
  }),
);
export type VerificationEvent = typeof verificationEvents.$inferSelect;
export type InsertVerificationEvent = typeof verificationEvents.$inferInsert;

//
// Example:
// export const posts = mysqlTable("posts", {
//   id: serial("id").primaryKey(),
//   title: varchar("title", { length: 255 }).notNull(),
//   content: text("content"),
//   createdAt: timestamp("created_at").notNull().defaultNow(),
// });
//
// Note: FK columns referencing a serial() PK must use:
//   bigint("columnName", { mode: "number", unsigned: true }).notNull()
