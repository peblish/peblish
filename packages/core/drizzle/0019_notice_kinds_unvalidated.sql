-- Widens the notice kinds to follow_accept and thread_reply (branch 5) without checking the rows
-- already there: NOT VALID skips the scan, so the ACCESS EXCLUSIVE lock this ALTER takes on the
-- live notifications table lasts an instant. The new CHECK holds for every row written from here
-- on; 0019 validates the old ones under a lock that lets reads and writes carry on. Every old row
-- holds one of the six earlier kinds, which the wider list keeps, so the validation cannot fail.
-- Apply 0019 in a later migrate run than this one: the migrator commits all pending files in one
-- transaction, and a VALIDATE in the same transaction would scan under this file's lock.
-- The lock wait is bounded for this transaction: behind a long transaction on notifications it
-- fails and rolls back whole instead of queueing every inbox query behind it; run migrate again.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind", ADD CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" in ('reply', 'mention', 'mod_remove', 'mod_restore', 'ban', 'unban', 'follow_accept', 'thread_reply')) NOT VALID;
