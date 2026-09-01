-- Additive, nullable call-review recording fields on verification_sessions.
-- voice*: the explicit voice-ID <Record> clip ("my voice identifies me").
-- bridge*: the live guarded-bridge conference recording (record-from-start) —
-- the full two-way conversation. Both are Twilio recording URLs played back
-- through the authenticated /api/verify/recording/:sid/:kind proxy.
ALTER TABLE `verification_sessions`
	ADD COLUMN `voiceRecordingUrl` varchar(512),
	ADD COLUMN `voiceRecordingDurationSec` int,
	ADD COLUMN `voiceRecordedAt` timestamp,
	ADD COLUMN `bridgeRecordingSid` varchar(64),
	ADD COLUMN `bridgeRecordingUrl` varchar(512),
	ADD COLUMN `bridgeRecordingDurationSec` int,
	ADD COLUMN `bridgeRecordedAt` timestamp;
