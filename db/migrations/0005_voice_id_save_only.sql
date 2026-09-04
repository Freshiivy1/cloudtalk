-- Save-only voice ID ("my voice identifies me"): the callee's phrase is
-- recorded and the voiceprint profile built, but NO voice matching is
-- performed. The capture is stamped on verification_sessions (and thereby
-- the Leg B call it originates) and is valid for the SAME calendar day as
-- the call only — a fresh capture is required each day. Additive + nullable
-- (existing rows unaffected).
ALTER TABLE `verification_sessions`
	ADD COLUMN `voiceIdCapturedAt` timestamp(3),
	ADD COLUMN `voiceIdRecordingSid` varchar(64);
