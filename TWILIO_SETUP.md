# Twilio Setup Checklist — Real Calling for CloudTalk

Goal: collect **5 values** and paste them back to me. ~15–20 minutes.

---

## Step 1 — Create the account
1. Go to **https://www.twilio.com/try-twilio** and sign up (email + password).
2. Verify your email, then verify **your own mobile number** (Twilio sends an SMS code).
   - Bonus: this verified number can later be used as a caller ID, and on a trial
     account it's the only number you're allowed to call.
3. When asked "What are you building?" pick **Voice** → "With code" → Node.js (answers don't matter).

## Step 2 — Grab the account credentials
On the Twilio Console dashboard (https://console.twilio.com):
- **Account SID** — starts with `ACxxxxxxxx…`
- **Auth Token** — click "Show" to reveal it

## Step 3 — Create an API key (used to sign browser call tokens)
1. Console → **Account** → **API keys & tokens** → **Create API key**.
2. Name it `cloudtalk`, type **Standard**, create.
3. Copy:
   - **API Key SID** — starts with `SKxxxxxxxx…`
   - **API Key Secret** — shown **only once**, copy it immediately.

## Step 4 — Create a TwiML App (call routing config)
1. Console → **Voice** → **TwiML Apps** → **Create new TwiML App**.
2. Name: `cloudtalk`.
3. Voice request URL: leave the default placeholder for now — **I'll give you the
   exact webhook URL to paste here after I build the server endpoints** (the preview
   URL depends on publishing).
4. Save, then copy the **TwiML App SID** — starts with `APxxxxxxxx…`.

## Step 5 — Get a caller ID / number
Choose one:
- **Option A (trial-friendly):** verify your own Australian mobile as an outbound
  caller ID — Console → **Phone Numbers** → **Verified Caller IDs** → add your +61 number.
  Calls will show your mobile as the caller ID. Free.
- **Option B (production):** buy a real +61 number — Console → **Phone Numbers** →
  **Buy a number** → country Australia → capability Voice (~AU$1.50–5/month).
  Requires a funded (upgraded) account.

## Step 6 — Trial vs paid (important)
- **Trial account:** free credit included, but you can **only call numbers you've
  verified** and calls start with a Twilio announcement. Fine for testing.
- **Upgraded account:** add a card + ~$20 credit to call any Australian number
  (~US$0.02–0.10/min depending on landline vs mobile).

---

## Send me these 5 values when done:
1. `Account SID` (AC…)
2. `Auth Token`
3. `API Key SID` (SK…)
4. `API Key Secret`
5. `TwiML App SID` (AP…) + your verified caller ID or purchased +61 number

Paste them in this chat — I'll put them straight into the server's environment
config (they never ship to the browser) and wire up the real calling provider.

> Security note: treat the Auth Token and API Secret like passwords. If you ever
> think they've leaked, rotate them in the Twilio console in one click.
