# Deploying CloudTalk to Render.com

This guide takes the GitHub repo **`Freshiivy1/cloudtalk`** from zero to a running
Docker web service on Render, **without** the Kimi platform (login is the
env-based username/password fallback — see [Login](#3-login-admin_username--admin_password)).

The repo already contains everything Render needs:

- `Dockerfile` — multi-stage build (Vite frontend → `dist/public`, esbuild server
  bundle → `dist/boot.js`). The server reads `process.env.PORT` (injected by
  Render) and defaults to 3000 (`EXPOSE 3000` is just documentation).
- `render.yaml` — Blueprint: `type: web`, `runtime: docker`, `healthCheckPath: /`.
- `.dockerignore` — keeps `node_modules`, `dist`, `.env`, `.git` out of the image.

> **Plan note:** `render.yaml` uses the `free` plan so the Blueprint applies
> without a card. Free instances **sleep after ~15 min idle** and cold-start for
> 30–60s, which breaks Twilio webhooks. Use **starter** for anything real.

---

## Order of operations (read first)

1. **Deploy the relay first.** The sibling repo `callverify-merge-relay` is a
   separate Render web service (same Docker flow). You need its public URL before
   setting `VERIFY_STREAM_URL` here.
2. Provision a MySQL 8 database (Render has **no** managed MySQL).
3. One-time schema setup against that database.
4. Create this app's Render web service and set all env vars.
5. Post-deploy checks + Twilio webhook wiring.

---

## 1. Database: external MySQL 8 + one-time schema setup

Render offers managed PostgreSQL only, so MySQL must come from elsewhere. Any
MySQL 8 / MariaDB 10.6+ host works; **Aiven's free plan** is a reliable option:

1. Sign up at https://aiven.io → **Create service** → **MySQL** → free plan
   (or use PlanetScale-less alternatives like Railway/AlwaysData — anything with
   a `mysql://` URL works).
2. From the service overview copy host, port, user, password. Create a database
   named `cloudtalk` if one isn't provided.

Build the connection string. If the provider enforces TLS (Aiven does), append an
ssl parameter — mysql2 accepts JSON in the query string (URL-encoded):

```
mysql://USER:PASSWORD@HOST:PORT/cloudtalk?ssl=%7B%22rejectUnauthorized%22%3Afalse%7D
```

(`%7B%22rejectUnauthorized%22%3Afalse%7D` decodes to `{"rejectUnauthorized":false}`.
For stricter verification, download the provider CA and use
`{"ca":"<PEM contents>"}` instead.) The **same string** is used at runtime
(`DATABASE_URL` env var) and for the one-time schema setup below.

### One-time schema setup (pick ONE)

**Option A — drizzle-kit push (recommended).** From a local clone of the repo:

```bash
npm ci
DATABASE_URL='mysql://USER:PASSWORD@HOST:PORT/cloudtalk?ssl=%7B%22rejectUnauthorized%22%3Afalse%7D' \
  npm run db:push
```

drizzle-kit reads `DATABASE_URL` via `drizzle.config.ts` and pushes
`db/schema.ts` directly (it uses mysql2 under the hood, so the `?ssl=...` query
works unchanged). Confirm the prompt; it prints the created tables.

**Option B — apply the checked-in migration manually.** `db/migrations/0000_flippant_skaar.sql`
contains the full `CREATE TABLE` set:

```bash
mysql --ssl-mode=REQUIRED -h HOST -P PORT -u USER -p cloudtalk \
  < db/migrations/0000_flippant_skaar.sql
```

Either way this is a **one-time** step — the Docker container does not run
migrations on boot.

---

## 2. Create the Render web service

**Via Blueprint (easiest):** Render dashboard → **New +** → **Blueprint** →
connect GitHub → select `Freshiivy1/cloudtalk`. Render reads `render.yaml` and
creates the service; you then fill in the `sync: false` env vars (below) in the
dashboard.

**Manually:** **New +** → **Web Service** → repo `Freshiivy1/cloudtalk` →
Runtime **Docker** → set Health Check Path to `/` → pick plan (see plan note).

The first deploy takes a few minutes (Docker build: `npm ci` → `vite build` →
esbuild server bundle).

---

## 3. Environment variables

Set these in Render → your service → **Environment** (all are marked
`sync: false` in `render.yaml`, i.e. dashboard-only secrets):

| Key | What / where to get it |
|---|---|
| `DATABASE_URL` | MySQL 8 connection string from step 1 (with `?ssl=...` if TLS-enforced). |
| `SESSION_SECRET` | Any long random string: `openssl rand -hex 32`. **Required in production** — it signs the `kimi_sid` session JWT. |
| `PUBLIC_BASE_URL` | This service's public origin, e.g. `https://cloudtalk.onrender.com`. Used to build absolute Twilio webhook URLs. No trailing slash. |
| `TWILIO_ACCOUNT_SID` | Twilio Console dashboard — see **TWILIO_SETUP.md** (steps 2–5 cover all five Twilio values). |
| `TWILIO_AUTH_TOKEN` | Twilio Console dashboard (TWILIO_SETUP.md step 2). |
| `TWILIO_API_KEY_SID` | Console → API keys & tokens, starts `SK…` (TWILIO_SETUP.md step 3). |
| `TWILIO_API_KEY_SECRET` | Shown once when the API key is created (TWILIO_SETUP.md step 3). |
| `TWILIO_TWIML_APP_SID` | Console → Voice → TwiML Apps (TWILIO_SETUP.md step 4). |
| `TWILIO_CALLER_ID` | Verified caller ID / Twilio number, E.164, e.g. `+15551234567` (TWILIO_SETUP.md step 5). |
| `VERIFY_STREAM_URL` | WebSocket URL of the **callverify-merge-relay** service deployed first, e.g. `wss://callverify-merge-relay.onrender.com/stream`. |
| `VERIFY_STREAM_SECRET` | Shared secret — must match the relay's own secret env var. |
| `ADMIN_USERNAME` | Off-platform login username (see below). |
| `ADMIN_PASSWORD` | Off-platform login password. Use a strong value; it is never logged and compared in constant time. |

### 3. Login (ADMIN_USERNAME / ADMIN_PASSWORD)

On the Kimi platform, sign-in was OAuth ("Sign in with Kimi"). Off-platform that
provider doesn't exist, so this app ships a fallback: when `ADMIN_USERNAME` and
`ADMIN_PASSWORD` are set, `/login` renders a username/password form (the Kimi
button only appears if the `VITE_KIMI_*` build vars exist). A successful login
creates a `users` row (`unionId = local:<username>`, role `admin`) and sets the
same `kimi_sid` session cookie the OAuth flow used. If neither auth method is
configured, `/login` shows an "auth not configured" notice.

### 4. Relay first, then these two

`VERIFY_STREAM_URL` / `VERIFY_STREAM_SECRET` can only be finalized **after** the
`callverify-merge-relay` service exists (its Render URL is the stream URL), and
`PUBLIC_BASE_URL` after this service's URL is known. Setting them and redeploying
(Render redeploys automatically on env changes) is fine.

---

## 5. Post-deploy checks

1. **App up:** `curl -i https://<your-service>.onrender.com/` → `200` and HTML
   (this is also the health check path).
2. **Login:** open `https://<your-service>.onrender.com/login`, sign in with
   `ADMIN_USERNAME` / `ADMIN_PASSWORD` → you should land on the softphone.
3. **Verification tone:** `curl -i https://<your-service>.onrender.com/api/verify/tone.wav`
   → `200` with `Content-Type: audio/wav` (Twilio fetches this during verification
   calls and rejects non-audio types).
4. **Twilio webhook URLs** — Twilio Console → **Voice → TwiML Apps → cloudtalk**:
   - Voice request URL: `{PUBLIC_BASE_URL}/api/voice/twiml` (HTTP POST)
   - The verification engine builds its own callback URLs from `PUBLIC_BASE_URL`,
     so nothing else needs pasting in the Console.
5. **Relay:** check the relay service logs show this app connected with the
   shared secret; place a test verification call from the admin verification page.

---

## Troubleshooting

- **Deploy OK but `/login` says "auth not configured"** — `ADMIN_USERNAME` /
  `ADMIN_PASSWORD` missing or empty; set both and redeploy.
- **"SESSION_SECRET is required in production"** in logs — set `SESSION_SECRET`.
- **DB connection errors on boot/first query** — wrong `DATABASE_URL`, missing
  `?ssl=...` for TLS-enforcing providers, or provider firewall (Aiven: allow
  `0.0.0.0/0` or Render's outbound IPs).
- **Tables missing (`Table 'cloudtalk.users' doesn't exist`)** — the one-time
  schema setup in step 1 wasn't run against this database.
- **Twilio error 12300 / calls fail immediately** — TwiML App voice URL not set
  to `{PUBLIC_BASE_URL}/api/voice/twiml`, or the free instance was asleep
  (upgrade to starter).
