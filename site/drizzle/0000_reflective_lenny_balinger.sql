CREATE TABLE `allocation_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`product` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`version_at_creation` integer NOT NULL,
	`status` text NOT NULL,
	`data_key` text NOT NULL,
	`total_cents` integer NOT NULL,
	`quantity` integer NOT NULL,
	`review_digest` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `allocation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`batch_id` text,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	`detail_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `allocation_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`reviewer_run_id` text NOT NULL,
	`status` text NOT NULL,
	`review_digest` text NOT NULL,
	`data_key` text NOT NULL,
	`submitted_at` text NOT NULL,
	`submitted_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allocation_reviews_batch_reviewer` ON `allocation_reviews` (`batch_id`,`reviewer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `allocation_reviews_batch_run` ON `allocation_reviews` (`batch_id`,`reviewer_run_id`);--> statement-breakpoint
CREATE TABLE `allocation_workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`data_key` text,
	`last_batch_id` text,
	`updated_at` text NOT NULL
);
