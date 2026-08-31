-- Additive, nullable guarded-mode marker on verification_sessions.
-- TRUE = session created via verification.initiateGuarded (softphone caller leg);
-- such sessions bridge caller+callee live (BRIDGED) after verification passes.
-- NULL/false rows keep the legacy verify-then-announce behavior unchanged.
ALTER TABLE `verification_sessions`
	ADD COLUMN `guarded` boolean;--> statement-breakpoint
