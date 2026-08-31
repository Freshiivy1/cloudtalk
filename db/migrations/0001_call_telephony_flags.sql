ALTER TABLE `calls`
	ADD COLUMN `twilioSid` varchar(64),
	ADD COLUMN `clientCallId` varchar(80),
	ADD COLUMN `speakerphoneAttempted` boolean NOT NULL DEFAULT false,
	ADD COLUMN `speakerphoneUsed` boolean NOT NULL DEFAULT false,
	ADD COLUMN `listenLiveAttempted` boolean NOT NULL DEFAULT false,
	ADD COLUMN `listenLiveUsed` boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE INDEX `idx_calls_twilio_sid` ON `calls` (`twilioSid`);--> statement-breakpoint
CREATE INDEX `idx_calls_client_call_id` ON `calls` (`clientCallId`);
