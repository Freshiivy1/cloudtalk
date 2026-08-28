# CloudTalk — VoIP calling platform with CallVerify

Browser-based calling built on Twilio Voice, with the **CallVerify** engine:
a prison-phone-style verification flow that proves a callee is on a real
cellular line by playing an in-band DTMF-9 tone on one leg and detecting the
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
| `VERIFY_STREAM_URL` | `wss://merge-relay-a7ws.onrender.com` (bare base URL — the app appends `?sid=` itself) |
| `VERIFY_STREAM_SECRET` | `k7X9mQ2vR8pL4wN6jH3fB5tY1zA0cV8b` — must equal the relay's `STREAM_SECRET` |
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
| `STREAM_SECRET` | `k7X9mQ2vR8pL4wN6jH3fB5tY1zA0cV8b` (= app's `VERIFY_STREAM_SECRET`) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | same Twilio creds — lets the relay tear down Leg A on detection |

### 5. Verify the 1:1 system works

```bash
curl https://merge-relay-a7ws.onrender.com/health   # {"ok":true,...}
curl https://merge-relay-a7ws.onrender.com/stats    # live counters
```

Then from the CloudTalk dashboard, start a verification. The whole flow runs
by itself — no external orchestration:

1. **Leg A** calls the callee from `TWILIO_CALLER_ID`, plays the inmate prompt,
   gathers press-1.
2. First press-1 → **Leg B** originates instantly from `TWILIO_CALLER_ID_LEG_B`
   (rings during prompt 2, so it arrives with the second "ready" press).
3. Callee answers Leg B → Leg A starts the continuous in-band DTMF-9 tone.
4. Callee merges the calls → the tone leaks into Leg B's duplex stream → the
   relay's Goertzel detector fires after ~300ms and **speaks the verdict
   straight into the call** while tearing down Leg A. Merge→verdict ≈ 0.3–0.4s.
5. The relay also POSTs `/api/verify/stream-detected` → the app marks the
   session `MERGE_DETECTED` and redirects the initiator's leg to the verdict.

---

## Repo layout

- `src/` — React frontend
- `api/` — Hono server (`boot.ts` entry), tRPC routers, CallVerify engine
  (`verification.ts`, `verification-webhooks.ts`, `verification-stream.ts`)
- `db/` — Drizzle schema + migrations (auto-applied on boot)
- `public/` — static assets incl. `verify-tone.wav` (the in-band merge tone)
- `Dockerfile` — all-in-one production image
- `.env.example` — every required variable with placeholders

## Notes

- **Never commit `.env`** — it is git-ignored on purpose.
- If the relay is unreachable, the engine automatically falls back to the
  1-second record-chunk detector (~2s detection) — nothing breaks.
- Twilio strips query strings from `<Stream>` URLs; the session id travels as
  a `<Parameter>` (both repos handle this — do not "simplify" it away).
