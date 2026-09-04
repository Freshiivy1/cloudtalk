ALTER TABLE `calls` ADD `flagged` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `calls` ADD `flagReason` varchar(255);