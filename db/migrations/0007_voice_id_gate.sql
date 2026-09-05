-- Real voice-ID gate (task 11 C2) + canary challenge proof-of-life (C1).
-- The save-only "my voice identifies me" capture becomes a VERIFIED gate:
-- voiceIdState drives the "My voice identifies me" stage, voiceIdAttemptId
-- is the per-attempt idempotency key, and Leg B may originate only while
-- voiceIdState = 'VOICE_ID_VERIFIED'. legAChallengeLastConfirmedAt is stamped
-- by the canary loud-tone TwiML loop as proof the authorised merge challenge
-- is actively playing. Additive + nullable (existing rows unaffected).
ALTER TABLE `verification_sessions`
	ADD COLUMN `voiceIdState` varchar(32),
	ADD COLUMN `voiceIdAttempts` int DEFAULT 0,
	ADD COLUMN `voiceIdAttemptId` varchar(64),
	ADD COLUMN `voiceIdRetryKind` varchar(16),
	ADD COLUMN `legAChallengeLastConfirmedAt` timestamp(3);
