# CloudTalk — Execution Plan (updated)

## Completed
- Stage 1-3: Design → scaffold → pages (delivered, versioned)
- Backend graft (db+auth), real contacts, AU dialing, Twilio live calling (LIVE · TWILIO)
- Mobile-responsive pass (version bbbb959)

## Stage 4 — CallVerify port: Asterisk/Java → Twilio/TypeScript (IN PROGRESS)
Source of truth: uploaded Java files in /mnt/agents/upload/ (SessionService state machine, VerificationController API, AmiService origination, application.yml config).

Sub-agent (coder, branch `verification-port`):
1. DB: verificationSessions + verificationEvents tables (drizzle, db:push)
2. api/verification.ts — Twilio port of the state machine (12 states, terminal set, transitions, SMS window, leg orchestration via Twilio REST + TwiML webhooks + status callbacks + native AMD + DTMF-leak merge detection + optional caller conference leg + Crazytel SMS)
3. tRPC verification router (initiate/list/get/events/terminate/confirmVoicemail) + Hono webhook routes in boot.ts
4. Frontend AdminVerification.tsx — dedicated /admin/verification page: initiate form, live session monitor (3s polling), state-flow viz, event timeline, terminate + confirm-voicemail actions; nav entry
5. npm run check + build, commit

Main agent after: merge → rebuild dist in shared repo → build_version → instruct user: publish site, then set PUBLIC_BASE_URL (env) so webhooks resolve.
