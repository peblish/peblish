-- Deletes the remote activities rows (nothing reads them; the pipeline stopped writing them) and
-- drops the two columns 0015 took off the definitions. The DELETE only takes row locks, so local
-- activity inserts carry on while it runs; the exclusive locks of the drops come last and are short.
-- The lock wait is bounded for this transaction: behind a long transaction (a running dump) or in a
-- deadlock it fails and rolls back whole instead of queueing every activities query behind it; run
-- migrate again later. Delete the remote rows in batches beforehand to keep the DELETE itself short.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DELETE FROM "activities" WHERE NOT "local";--> statement-breakpoint
ALTER TABLE "activities" DROP CONSTRAINT "activities_inbox_raw_id_inbox_raw_id_fk";--> statement-breakpoint
DROP INDEX "activities_inbox_raw";--> statement-breakpoint
ALTER TABLE "votes" DROP COLUMN "raw";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "inbox_raw_id";
