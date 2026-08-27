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
  verificationGatherHandler,
  verificationGatherLegAAcceptHandler,
  verificationGatherLegAReadyHandler,
  verificationStatusHandler,
  verificationToneHandler,
  verificationTwimlHandler,
} from "./verification-webhooks";
import { verificationRecordingHandler } from "./verification-record";
import { verificationStreamDetectedHandler } from "./verification-stream";
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
app.post("/api/verify/stream-detected", verificationStreamDetectedHandler);
// Serve the in-band DTMF verification tone with a proper audio/wav Content-Type
// (the generic static server returns octet-stream; Twilio refuses it — error 12300).
app.get("/api/verify/tone.wav", verificationToneHandler);
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
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
  // Twilio Media Streams (Leg B audio fork → Goertzel merge-tone detector).
  attachVerificationStreamServer(server as unknown as import("http").Server);
}
