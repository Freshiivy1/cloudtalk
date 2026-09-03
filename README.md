# CloudTalk — VoIP calling platform with CallVerify

Browser-based calling built on Twilio Voice, with the **CallVerify** engine:
a prison-phone-style verification flow that proves a callee is on a real
cellular line by playing an in-band DTMF-8 tone (852 + 1336 Hz) on one leg and detecting the
instant the callee merges calls — **sub-0.5s, with the verdict spoken in-band
by the merge-relay** (see below).

**Stack:** Vite + React + TypeScript frontend · Hono (Node) API · tRPC ·
Drizzle ORM + MySQL · Twilio Voice (REST + TwiML + Media Streams).

---

## Pull & run — exact 1:1 reproduction

Everything below reproduces the system exactly as it currently runs.

### 1. Clone

```bash
git clone https://github.com/Freshiivy1/cloudtalk.git
cd cloudtalk
```

A fresh clone is byte-for-byte the full project (verified: 135+ files, hash
compared). The only thing not in git is `.env` — secrets never get committed.

### 2. Configure

```bash
cp .env.example .env
```

Fill `.env` with these values — this is the **current production set**:

| Variable | Current value / how to get it |
|---|---|
| `AUTH_DISABLED` | `true` — **no login page**; every visitor is admin |
| `ADMIN_USERNAME` | `admin` (only used if `AUTH_DISABLED` is off) |
| `ADMIN_PASSWORD` | your strong password (session login) |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `TWILIO_ACCOUNT_SID` | Twilio console → Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio console → Auth Token |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | Twilio console → API keys |
| `TWILIO_TWIML_APP_SID` | Twilio console → TwiML App SID |
| `TWILIO_CALLER_ID` | `+19043201432` — first call (Leg A) comes from this number |
| `TWILIO_CALLER_ID_LEG_B` | `+12195877734` — the verification "second call" (never the same number twice — avoids carrier spam flagging) |
| `VERIFY_STREAM_URL` | `wss://<your-merge-relay-host>/stream` (bare WebSocket URL — stream identity travels in `<Start><Stream>` `customParameters` with an HMAC token, never in the query string) |
| `VERIFY_STREAM_SECRET` | `openssl rand -hex 32` — must equal the relay's `STREAM_SECRET`. **Rotate any previously committed/shared value** — treat old values as compromised. |
| `DATABASE_URL` | MySQL DSN — needed for persisted verification sessions; migrations auto-apply on boot |

### 3. Run

```bash
npm install
npm run dev          # local dev (Vite + API)
```

Docker (production image — frontend build + API + static, all-in-one):

```bash
docker build -t cloudtalk .     # .env must exist — the Dockerfile copies it in
docker run -p 8080:8080 cloudtalk
```

### 4. Deploy the merge-relay (companion service — required for sub-0.5s)

```bash
git clone https://github.com/Freshiivy1/merge-relay.git
```

Deploy it on Render/Railway/Fly/VPS (see its README). Its env vars:

| Var | Current value |
|---|---|
| `CALLBACK_URL` | `https://<your-app-host>/api/verify/stream-detected` |
| `STREAM_SECRET` | `<same value as the app's VERIFY_STREAM_SECRET>` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | same Twilio creds — lets the relay tear down Leg A on detection |

### 5. Verify the 1:1 system works

```bash
curl https://merge-relay-a7ws.onrender.com/health   # {"ok":true,...}
curl https://merge-relay-a7ws.onrender.com/stats    # live counters
```

Then from the CloudTalk softphone, toggle **Guarded inmate call** and dial. The guarded flow is IVR + voice-ID + second-call verification:

1. The browser places an outbound Twilio Voice SDK call carrying the guarded session id — the caller hears “Please wait while we connect your call.” and stays parked in a non-blocking wait loop.
2. The callee hears the inmate-call warning and must press **1** to accept: “You are receiving a call from an inmate… please press 1 if you accept.”
3. After acceptance, the callee is asked to say the voice-ID phrase: **“my voice identifies me.”** The recording is processed into the relayguard voice baseline (`VOICEPRINT_CAPTURED`, best-effort).
4. The callee must press **1 again** to receive the second verification call. Leg B is originated only by this second press; the voiceprint recording callback never sends the next call automatically. The callee must **not end the current call** and must accept the next call.
5. Leg B runs the second-call/merge verification while Leg A plays the pure in-band DTMF-8 tone loop (852 Hz + 1336 Hz — no spoken “guard test” audio).
6. If the callee merges the calls, the tone leaks into Leg B and the session ends as `MERGE_DETECTED` (relay path sub-second; record-chunk fallback typically ~1.5–2.5s). If no merge is detected during the watch window, the caller and callee are bridged.
7. While BRIDGED, relayguard speakerphone scoring runs on ~1s windows and voice-match comparison runs live. Suspicious windows inject callee-only challenge noise and never hang up the call; a clean window logs `SPEAKERPHONE_CLEARED` and stops re-injection on the next live-analysis poll.
8. Watch it live from the softphone’s **Live analysis** panel or open `/app/live-analysis/<sessionId>` for the full result page.

The guarded challenge-noise probe is deterministic and matches the detector contract exactly: **70% relayguard level, 4-second seamless loop, seed `0x5eed`, bass-free 500 Hz–6 kHz band, +4 dB presence at 2 kHz**. The checked-in assets are:

- `public/relayguard-challenge-noise-70pct-44k.mp3` / `.wav` — 44.1 kHz phone/VoIP playback and lossless reference
- `public/relayguard-challenge-noise-70pct-16k.mp3` / `.wav` — telephony-grade callee path (`/api/verify/challenge-noise.wav` serves the 16 kHz WAV)

The classic admin CallVerify flow (Leg A IVR → Leg B probe → merge/voip/call-waiting verdict) remains available under `/admin/verification` for non-guarded verification only.

---

## Repo layout

- `src/` — React frontend
- `api/` — Hono server (`boot.ts` entry), tRPC routers, CallVerify engine
  (`verification.ts`, `verification-webhooks.ts`, `verification-stream.ts`)
- `db/` — Drizzle schema + migrations (auto-applied on boot)
- `public/` — static assets incl. `verify-tone.wav` (pure DTMF-8 merge tone, 852 + 1336 Hz) and the exact relayguard challenge-noise WAV/MP3 probes
- `Dockerfile` — all-in-one production image
- `.env.example` — every required variable with placeholders

## Notes

- **Never commit `.env`** — it is git-ignored on purpose.
- If the relay is unreachable, the engine automatically falls back to the
  1-second record-chunk detector (~2s detection) — nothing breaks.
- Twilio strips query strings from `<Stream>` URLs; the session id travels as
  a `<Parameter>` (both repos handle this — do not "simplify" it away).
