-- Corrected Call Waiting two-phase architecture: persisted readiness/phase
-- state on verification_sessions so the challenge timeline survives restarts.
-- All columns additive + nullable (existing rows unaffected).
ALTER TABLE `verification_sessions`
	ADD COLUMN `streamSid` varchar(64),
	-- Millisecond precision is required for the exact measured prompt boundary.
	ADD COLUMN `streamReadyAt` timestamp(3),
	ADD COLUMN `streamReadyBy` timestamp(3),
	ADD COLUMN `challengeStartedAt` timestamp(3),
	ADD COLUMN `promptLightDurationMs` int,
	ADD COLUMN `promptEndsAt` timestamp(3),
	ADD COLUMN `detectionPhase` varchar(32);
