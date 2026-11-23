-- A profile's comment count reads the person's live comments from this index alone, counted per
-- post, so each post's visibility is checked once (profiles/read.ts: countQueries).
--
-- Building it here takes a SHARE lock on comments and holds it until the migrator's transaction
-- commits: reads carry on, but every comment write (new comments, edits, deletions, removals,
-- comment vote tallies) waits for the whole build, which grows with the number of live comments.
-- The 5 s lock_timeout bounds only the wait to acquire the lock (behind a long transaction such as
-- a running dump it fails and rolls back instead of queueing comment writes behind it), not the
-- build. A large site builds the index first, by hand and outside any transaction, so writes never
-- wait:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "comments_author_post" ON "comments" USING btree ("author_id","post_id") WHERE "comments"."deleted_at" is null and "comments"."removed_at" is null;
-- and this migration then does nothing. A concurrent build that fails leaves an invalid index of
-- this name: drop it and build again before migrating.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_author_post" ON "comments" USING btree ("author_id","post_id") WHERE "comments"."deleted_at" is null and "comments"."removed_at" is null;
