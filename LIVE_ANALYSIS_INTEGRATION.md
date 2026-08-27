# CloudTalk — Live Analysis Integration Points

When you're ready to add your live-analysis logic and tools, these are the hook points built for them:

## 1. The event stream (primary hook)
Every telephony state transition (real or simulated) is appended to the
`call_events` table via `logCallEvent()` in `api/simulator.ts`.

- Consume globally: `trpc.admin.dashboard.eventFeed({ limit })`
  (polls every ~2.5s in the UI; the backend lazy-ticks the simulator on each call)
- Consume per call: `trpc.telephony.calls.getById({ id })` → `events[]`
- Event types: `incoming_call`, `call_ringing`, `call_active`, `call_held`,
  `call_resumed`, `call_muted`, `call_unmuted`, `dtmf`, `call_ended`
- To emit your own analysis events, insert rows into `call_events` with your
  own `type` (e.g. `analysis.sentiment`) — they'll show up in the same feed.

## 2. The Live Analysis dock (UI surface)
`src/components/admin/AnalysisDock.tsx` on the admin dashboard (`/admin`) has
three dashed-violet module slots: **Sentiment**, **Transcription**, **Alerts**,
registered in a small module registry in that file. Replace a slot's
placeholder with your live component — the layout, tickers, and event feed are
already wired.

## 3. The Integrations tab (configuration surface)
`/admin/settings` → Integrations tab persists module config through
`admin.settings.set` under keys:
- `integrations.analysisEnabled`
- `integrations.analysisEndpoint`
- plus the keyword alert rules key used by the Alerts module card.

## 4. Swapping simulated → real telephony
- Client: `src/lib/telephony.ts` — implement the `TelephonyProvider` interface
  against a real SDK (SIP.js / Twilio Voice) and swap it in `useTelephony()`.
  All UI consumes the interface, nothing else changes.
- Server: replace the lazy-tick engine in `api/simulator.ts` with webhook
  endpoints that call `logCallEvent()` + update `calls` rows. The softphone
  reporter (`src/hooks/useTelephonyReporter.ts`) already mirrors UI-driven
  calls into the same tables.
