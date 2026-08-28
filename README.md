# CloudTalk — VoIP calling platform with CallVerify

Browser-based calling built on Twilio Voice, with the **CallVerify** engine:
a prison-phone-style verification flow that proves a callee is on a real
cellular line by playing an in-band DTMF-9 tone on one leg and detecting the
instant the callee merges calls (sub-0.5s via the merge-relay WebSocket
service).

**Stack:** Vite + React + TypeScript frontend · Hono (Node) API · tRPC ·
Drizzle ORM + MySQL · Twilio Voice (REST + TwiML + Media Streams).

## Clone & run

```bash
git clone https://github.com/Freshiivy1/cloudtalk.git
cd cloudtalk
cp .env.example .env    # then fill in your real values (see below)
npm install
npm run dev             # local dev (Vite + API)
```

### Docker (production)

```bash
cp .env.example .env    # REQUIRED before build — the Dockerfile copies .env
docker build -t cloudtalk .
docker run -p 8080:8080 cloudtalk
```

> `.env` is git-ignored on purpose — **never commit real secrets**.
> On boot the server auto-applies `db/migrations` when `DATABASE_URL` is set.

## Required environment variables

| Variable | Purpose |
|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Env-based admin login (or use Kimi OAuth vars instead) |
| `SESSION_SECRET` | Session cookie signing (`openssl rand -hex 32`) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio REST credentials |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | Twilio API key pair |
| `TWILIO_TWIML_APP_SID` | TwiML App for the voice client |
| `TWILIO_CALLER_ID` | Verified caller ID calls originate from (E.164) |
| `VERIFY_STREAM_URL` | Bare `wss://` base URL of your deployed merge-relay |
| `VERIFY_STREAM_SECRET` | Shared secret — must equal the relay's `STREAM_SECRET` |
| `DATABASE_URL` | MySQL DSN (optional; needed for persisted call records) |

## Merge detection (sub-0.5s)

Real-time merge detection needs a WebSocket host. Deploy the companion
service **[Freshiivy1/merge-relay](https://github.com/Freshiivy1/merge-relay)**
(any Node 18+ host with WS support), then set:

- app: `VERIFY_STREAM_URL=wss://<relay-host>` and `VERIFY_STREAM_SECRET=<secret>`
- relay: `CALLBACK_URL=https://<app-host>/api/verify/stream-detected` and `STREAM_SECRET=<same secret>`

Leg B's TwiML then opens a Twilio Media Stream to the relay, which runs a
Goertzel detector (852 Hz + 1336 Hz) and posts back in ~300ms when the tone
crosses a merged call. Without `VERIFY_STREAM_URL` the app falls back to
1s `<Record>` chunks (slower, seconds-scale).

## Repo layout

- `src/` — React frontend
- `api/` — Hono server (`boot.ts` entry), tRPC routers, CallVerify engine
  (`verification.ts`, `verification-webhooks.ts`, `verification-stream.ts`)
- `db/` — Drizzle schema + migrations
- `public/` — static assets incl. `verify-tone.wav` (the in-band merge tone)
- `Dockerfile` — all-in-one production image (frontend build + API + static)
