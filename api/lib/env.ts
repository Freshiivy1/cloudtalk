/**
 * Typed access to process.env with .env loaded (dotenv).
 *
 * Only `env.isProduction` is consumed by the boot path; the remaining fields
 * are exposed (optional) so call sites can rely on one typed module instead of
 * sprinkling `process.env` reads. Anything Twilio/PUBLIC_BASE_URL related is
 * still read directly via process.env in the verification engine so tests can
 * mutate env vars at runtime.
 */
import "dotenv/config";

const e = process.env;

export const env = {
  /** NODE_ENV === "production" gates the static-file server + WS attach. */
  isProduction: e.NODE_ENV === "production",
  nodeEnv: e.NODE_ENV ?? "development",
  port: e.PORT ?? "3000",

  /** MySQL connection string (mysql://…) */
  databaseUrl: e.DATABASE_URL,

  /** Public origin used to build absolute webhook URLs. */
  publicBaseUrl: e.PUBLIC_BASE_URL,

  /** Twilio */
  twilioAccountSid: e.TWILIO_ACCOUNT_SID,
  twilioAuthToken: e.TWILIO_AUTH_TOKEN,
  twilioApiKeySid: e.TWILIO_API_KEY_SID,
  twilioApiKeySecret: e.TWILIO_API_KEY_SECRET,
  twilioTwimlAppSid: e.TWILIO_TWIML_APP_SID,
  twilioCallerId: e.TWILIO_CALLER_ID,

  /** External merge-detection relay (WebSocket host). */
  verifyStreamUrl: e.VERIFY_STREAM_URL,
  verifyStreamSecret: e.VERIFY_STREAM_SECRET,

  /** Session cookie signing secret (api/kimi/auth.ts). */
  sessionSecret: e.SESSION_SECRET,

  /** Kimi platform OAuth (see api/kimi/auth.ts for assumptions). */
  kimiAuthUrl: e.KIMI_AUTH_URL ?? e.VITE_KIMI_AUTH_URL,
  kimiAppId: e.KIMI_APP_ID ?? e.VITE_APP_ID,
} as const;

export type Env = typeof env;
