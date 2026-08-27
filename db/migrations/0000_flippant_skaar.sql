CREATE TABLE `agent_profiles` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`extensionId` bigint unsigned,
	`presence` enum('available','busy','away','offline') NOT NULL DEFAULT 'offline',
	`title` varchar(255),
	`department` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_profiles_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `call_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`callId` bigint unsigned NOT NULL,
	`type` varchar(40) NOT NULL,
	`payload` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `call_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `calls` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`direction` enum('inbound','outbound') NOT NULL,
	`status` enum('dialing','ringing','active','held','completed','missed','failed') NOT NULL,
	`fromNumber` varchar(32) NOT NULL,
	`toNumber` varchar(32) NOT NULL,
	`contactName` varchar(255),
	`agentId` bigint unsigned,
	`extensionId` bigint unsigned,
	`contactId` bigint unsigned,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`answeredAt` timestamp,
	`endedAt` timestamp,
	`durationSec` int NOT NULL DEFAULT 0,
	`muted` boolean NOT NULL DEFAULT false,
	`hasRecording` boolean NOT NULL DEFAULT false,
	`note` text,
	`simAnswerAt` timestamp,
	`simEndAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `calls_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`company` varchar(255),
	`phone` varchar(32) NOT NULL,
	`email` varchar(320),
	`tag` enum('vip','lead','customer','supplier') NOT NULL DEFAULT 'customer',
	`favorite` boolean NOT NULL DEFAULT false,
	`ownerId` bigint unsigned,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `extensions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`number` varchar(8) NOT NULL,
	`label` varchar(255),
	`status` enum('idle','ringing','in_call','held','offline') NOT NULL DEFAULT 'idle',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `extensions_id` PRIMARY KEY(`id`),
	CONSTRAINT `extensions_number_unique` UNIQUE(`number`)
);
--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`callId` bigint unsigned NOT NULL,
	`durationSec` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `recordings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`key` varchar(128) NOT NULL,
	`value` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `settings_key_unique` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`unionId` varchar(255) NOT NULL,
	`name` varchar(255),
	`email` varchar(320),
	`avatar` text,
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	`lastSignInAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_unionId_unique` UNIQUE(`unionId`)
);
--> statement-breakpoint
CREATE TABLE `verification_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`sessionId` varchar(64) NOT NULL,
	`eventType` varchar(64) NOT NULL,
	`details` varchar(512),
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `verification_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `verification_sessions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`sessionId` varchar(64) NOT NULL,
	`callerNumber` varchar(32),
	`calleeNumber` varchar(32) NOT NULL,
	`legBNumber` varchar(32),
	`ringTestNumber` varchar(32),
	`state` varchar(32) NOT NULL,
	`callerCallSid` varchar(64),
	`legACallSid` varchar(64),
	`legBCallSid` varchar(64),
	`ringTestCallSid` varchar(64),
	`legBOriginatedAt` timestamp,
	`toneDetected` boolean NOT NULL DEFAULT false,
	`toneDetectedAt` timestamp,
	`smsSent` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`failureReason` varchar(512),
	CONSTRAINT `verification_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `verification_sessions_sessionId_unique` UNIQUE(`sessionId`)
);
--> statement-breakpoint
CREATE INDEX `idx_verification_events_session_id` ON `verification_events` (`sessionId`);--> statement-breakpoint
CREATE INDEX `idx_verification_session_id` ON `verification_sessions` (`sessionId`);--> statement-breakpoint
CREATE INDEX `idx_verification_state` ON `verification_sessions` (`state`);