-- Corrected Call Waiting two-phase architecture: persisted readiness/phase
-- state on verification_sessions so the challenge timeline survives restarts.
-- All columns additive + nullable (existing rows unaffected).
ALTER TABLE `verification_sessions`
	ADD COLUMN `streamSid` varchar(64),
	ADD COLUMN `streamReadyAt` timestamp,
	ADD COLUMN `streamReadyBy` timestamp,
	ADD COLUMN `challengeStartedAt` timestamp,
	ADD COLUMN `promptLightDurationMs` int,
	ADD COLUMN `promptEndsAt` timestamp,
	ADD COLUMN `detectionPhase` varchar(32);
