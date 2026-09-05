import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { createOAuthCallbackHandler } from "./kimi/auth";
import { statusCallbackHandler, voiceWebhookHandler } from "./twilio-voice";
import {
  promptLightHandler,
  speakerphoneTerminatedHandler,
  speakerphoneWarningHandler,
  verificationGatherHandler,
  verificationGatherLegAAcceptHandler,
  verificationConferenceHandler,
  verificationGatherLegAReadyHandler,
  verificationSmsInboundHandler,
  verificationStatusHandler,
  verificationVersionHandler,
  verificationToneHandler,
  verificationTwimlHandler,
  verificationVoiceprintHandler,
} from "./verification-webhooks";
import {
  verificationBridgeRecordingHandler,
  verificationRecordingAudioHandler,
  verificationRecordingHandler,
} from "./verification-record";
import { testCalleeBotHandler, testCalleeBotRecordHandler } from "./test-bot";
import {
  verificationStreamDetectedHandler,
  verificationStreamFailedHandler,
  verificationStreamReadyHandler,
} from "./verification-stream";
import { Paths } from "@contracts/constants";

const app = new Hono<{ Bindings: HttpBindings }>();

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));
app.get(Paths.oauthCallback, createOAuthCallbackHandler());
// Twilio Voice webhooks (Twilio → us; no session cookie, validated by config)
app.post("/api/voice/twiml", voiceWebhookHandler);
app.post("/api/voice/status", statusCallbackHandler);
// CallVerify port — verification engine webhooks (Twilio → us)
app.post("/api/verify/twiml/:kind", verificationTwimlHandler);
app.post("/api/verify/status/:leg", verificationStatusHandler);
app.post("/api/verify/gather/merge", verificationGatherHandler);
app.post("/api/verify/gather/leg-a-accept", verificationGatherLegAAcceptHandler);
app.post("/api/verify/gather/leg-a-ready", verificationGatherLegAReadyHandler);
app.post("/api/verify/recording/merge", verificationRecordingHandler);
// GUARDED MODE ONLY: bridge conference recording callback + call-review playback.
app.post("/api/verify/recording/bridge", verificationBridgeRecordingHandler);
app.get("/api/verify/recording/:sid/:kind", verificationRecordingAudioHandler);
// GUARDED MODE ONLY: save-only voice-ID <Record> action (capture stamp +
// immediate second-call handoff — no verification, no transcription).
app.post("/api/verify/voiceprint", verificationVoiceprintHandler);
// TEST-ONLY scripted callee for end-to-end guarded-call self-tests.
app.post("/api/test/callee-bot", testCalleeBotHandler);
app.get("/api/test/callee-bot", testCalleeBotHandler);
app.post("/api/test/callee-bot-record", testCalleeBotRecordHandler);
app.post("/api/verify/stream-detected", verificationStreamDetectedHandler);
// Relay readiness/failure callbacks (x-verify-secret authenticated): the
// Leg A challenge starts only on stream-ready; failures are never a pass.
app.post("/api/verify/stream-ready", verificationStreamReadyHandler);
app.post("/api/verify/stream-failed", verificationStreamFailedHandler);
// Two-way AI SMS: Crazytel Virtual Mobile Number inbound webhook (JSON
// {from, to, text}) — replies with model-specific call-waiting walkthroughs.
app.post("/api/verify/sms/inbound", verificationSmsInboundHandler);
// Bridge conference lifecycle/participant events (bridge supervisor).
app.post("/api/verify/conference", verificationConferenceHandler);
// Deployment marker — which commit is live (RENDER_GIT_COMMIT).
app.get("/api/verify/version", verificationVersionHandler);
// Serve the in-band DTMF verification tone with a proper audio/wav Content-Type
// (the generic static server returns octet-stream; Twilio refuses it — error 12300).
app.get("/api/verify/tone.wav", verificationToneHandler);
// Phase 1 challenge asset (prompt + light DTMF-8 watermark), audio/wav,
// no-store, measured duration surfaced via X-Prompt-Light-Duration-Ms.
app.get("/api/verify/prompt-light.wav", promptLightHandler);
// Speakerphone strike ladder: strike-3 warning (conference announce — the
// recipient hears it, the muted inmate hears it receive-only) and the
// supreme-flag termination notice (announced to both live parties).
app.get("/api/verify/speakerphone-warning.wav", speakerphoneWarningHandler);
app.get("/api/verify/speakerphone-terminated.wav", speakerphoneTerminatedHandler);
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  const { attachVerificationStreamServer } = await import("./verification-stream");

  // Self-migrate the MySQL schema on boot so a fresh deploy needs no manual
  // `drizzle-kit migrate` step. No-op (with a warning) when DATABASE_URL is
  // absent — the server still serves the SPA.
  if (process.env.DATABASE_URL) {
    try {
      const { migrate } = await import("drizzle-orm/mysql2/migrator");
      const { getDb } = await import("./queries/connection");
      await migrate(getDb(), { migrationsFolder: "db/migrations" });
      console.log("Database schema is up to date (migrations applied).");
    } catch (err) {
      console.error("Database migration failed — continuing boot:", err);
    }
  } else {
    console.warn("DATABASE_URL not set — skipping migrations; running in no-history mode (calls still work).");
  }

  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
  // Twilio Media Streams (Leg B audio fork → Goertzel merge-tone detector).
  attachVerificationStreamServer(server as unknown as import("http").Server);
}
