ALTER TABLE `processing_jobs` ADD COLUMN `batch_number` integer;
--> statement-breakpoint
WITH `ordered_jobs` AS (
  SELECT `id`, ROW_NUMBER() OVER (ORDER BY `created_at`, `id`) AS `number`
  FROM `processing_jobs`
)
UPDATE `processing_jobs`
SET `batch_number` = (
  SELECT `number` FROM `ordered_jobs` WHERE `ordered_jobs`.`id` = `processing_jobs`.`id`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processing_jobs_batch_number_unique` ON `processing_jobs` (`batch_number`);
--> statement-breakpoint
CREATE TABLE `processing_job_sequence` (
  `id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
  `next_number` integer NOT NULL CHECK (`next_number` >= 1)
);
--> statement-breakpoint
INSERT INTO `processing_job_sequence` (`id`, `next_number`)
SELECT 1, COALESCE(MAX(`batch_number`), 0) + 1 FROM `processing_jobs`;
