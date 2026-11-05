CREATE TEMP TABLE `allocation_reference_preflight` (`value` INTEGER NOT NULL);
--> statement-breakpoint
CREATE TEMP TRIGGER `allocation_reference_preflight_guard`
BEFORE INSERT ON `allocation_reference_preflight`
WHEN
	(
		EXISTS (
			SELECT 1 FROM `allocation_reviews` r
			LEFT JOIN `allocation_batches` b ON b.`id`=r.`batch_id`
			WHERE b.`id` IS NULL
		)
		OR EXISTS (
			SELECT 1 FROM `allocation_workspace` w
			LEFT JOIN `allocation_batches` b ON b.`id`=w.`last_batch_id`
			WHERE w.`last_batch_id` IS NOT NULL AND b.`id` IS NULL
		)
		OR EXISTS (
			SELECT 1 FROM `allocation_events` e
			LEFT JOIN `allocation_batches` b ON b.`id`=e.`batch_id`
			WHERE e.`batch_id` IS NOT NULL AND b.`id` IS NULL
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'allocation reference migration found existing orphan rows');
END;
--> statement-breakpoint
INSERT INTO `allocation_reference_preflight` (`value`) VALUES (1);
--> statement-breakpoint
DROP TRIGGER `allocation_reference_preflight_guard`;
--> statement-breakpoint
DROP TABLE `allocation_reference_preflight`;
--> statement-breakpoint
CREATE TRIGGER `allocation_reviews_batch_insert_guard`
BEFORE INSERT ON `allocation_reviews`
WHEN NOT EXISTS (SELECT 1 FROM `allocation_batches` WHERE `id` = NEW.`batch_id`)
BEGIN
	SELECT RAISE(ABORT, 'allocation review batch does not exist');
END;
--> statement-breakpoint
CREATE TRIGGER `allocation_reviews_batch_update_guard`
BEFORE UPDATE OF `batch_id` ON `allocation_reviews`
WHEN NOT EXISTS (SELECT 1 FROM `allocation_batches` WHERE `id` = NEW.`batch_id`)
BEGIN
	SELECT RAISE(ABORT, 'allocation review batch does not exist');
END;
--> statement-breakpoint
CREATE TRIGGER `allocation_workspace_last_batch_insert_guard`
BEFORE INSERT ON `allocation_workspace`
WHEN NEW.`last_batch_id` IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM `allocation_batches` WHERE `id` = NEW.`last_batch_id`)
BEGIN
	SELECT RAISE(ABORT, 'allocation workspace batch does not exist');
END;
--> statement-breakpoint
CREATE TRIGGER `allocation_workspace_last_batch_update_guard`
BEFORE UPDATE OF `last_batch_id` ON `allocation_workspace`
WHEN NEW.`last_batch_id` IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM `allocation_batches` WHERE `id` = NEW.`last_batch_id`)
BEGIN
	SELECT RAISE(ABORT, 'allocation workspace batch does not exist');
END;
--> statement-breakpoint
CREATE TRIGGER `allocation_events_batch_insert_guard`
BEFORE INSERT ON `allocation_events`
WHEN NEW.`batch_id` IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM `allocation_batches` WHERE `id` = NEW.`batch_id`)
BEGIN
	SELECT RAISE(ABORT, 'allocation event batch does not exist');
END;
--> statement-breakpoint
CREATE TRIGGER `allocation_events_batch_update_guard`
BEFORE UPDATE OF `batch_id` ON `allocation_events`
WHEN NEW.`batch_id` IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM `allocation_batches` WHERE `id` = NEW.`batch_id`)
BEGIN
	SELECT RAISE(ABORT, 'allocation event batch does not exist');
END;
--> statement-breakpoint
CREATE TRIGGER `allocation_batches_delete_guard`
BEFORE DELETE ON `allocation_batches`
WHEN EXISTS (SELECT 1 FROM `allocation_reviews` WHERE `batch_id` = OLD.`id`)
	OR EXISTS (SELECT 1 FROM `allocation_workspace` WHERE `last_batch_id` = OLD.`id`)
	OR EXISTS (SELECT 1 FROM `allocation_events` WHERE `batch_id` = OLD.`id`)
BEGIN
	SELECT RAISE(ABORT, 'allocation batch still has references');
END;
