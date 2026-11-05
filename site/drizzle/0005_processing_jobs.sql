CREATE TABLE `processing_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL REFERENCES `app_users`(`id`) ON DELETE RESTRICT,
  `parent_job_id` text REFERENCES `processing_jobs`(`id`) ON DELETE RESTRICT,
  `status` text NOT NULL CHECK (`status` IN ('draft', 'prepared', 'adopted', 'discarded')),
  `revision` integer NOT NULL,
  `data_key` text NOT NULL,
  `source_fingerprint` text NOT NULL,
  `product` text,
  `total_cents` integer,
  `quantity` integer,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `adopted_at` text,
  `adopted_by` text,
  `discarded_at` text,
  `discard_reason` text
);
--> statement-breakpoint
CREATE INDEX `processing_jobs_owner_created` ON `processing_jobs` (`owner_id`, `created_at` DESC, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `processing_jobs_single_active_child` ON `processing_jobs` (`parent_job_id`) WHERE `parent_job_id` IS NOT NULL AND `status` <> 'discarded';
--> statement-breakpoint
CREATE TABLE `processing_job_events` (
  `id` text PRIMARY KEY NOT NULL,
  `job_id` text NOT NULL REFERENCES `processing_jobs`(`id`) ON DELETE RESTRICT,
  `actor_id` text NOT NULL REFERENCES `app_users`(`id`) ON DELETE RESTRICT,
  `event_type` text NOT NULL,
  `revision` integer NOT NULL,
  `created_at` text NOT NULL,
  `detail_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `processing_job_events_job_created` ON `processing_job_events` (`job_id`, `created_at`, `id`);
--> statement-breakpoint
CREATE TABLE `processing_active_sources` (
  `owner_id` text NOT NULL REFERENCES `app_users`(`id`) ON DELETE RESTRICT,
  `source_sha256` text NOT NULL,
  `balance_fingerprint` text NOT NULL,
  `job_id` text NOT NULL REFERENCES `processing_jobs`(`id`) ON DELETE RESTRICT,
  `created_at` text NOT NULL,
  PRIMARY KEY (`owner_id`, `source_sha256`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processing_active_sources_owner_sha` ON `processing_active_sources` (`owner_id`, `source_sha256`);
--> statement-breakpoint
CREATE UNIQUE INDEX `processing_active_sources_owner_balance` ON `processing_active_sources` (`owner_id`, `balance_fingerprint`);
