-- Validates the notice-kind CHECK that 0018 added NOT VALID: VALIDATE CONSTRAINT scans the old
-- rows under SHARE UPDATE EXCLUSIVE, which lets inbox reads and writes carry on meanwhile. It only
-- spares the table when it runs in a migrate run after the one that applied 0018 (the migrator
-- applies every pending file in one transaction); applied together, the scan holds 0018's lock.
-- The lock wait is bounded for this transaction, as in 0018.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_kind";
