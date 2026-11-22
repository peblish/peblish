-- A profile's comment count reads the person's live comments from this index alone, counted per
-- post, so each post's visibility is checked once (profiles/read.ts: countQueries). Building it
-- holds a SHARE lock on comments: reads carry on, but comment writes (new comments, edits,
-- deletions, removals, comment vote tallies) wait until the build ends, which takes longer the
-- more comments there are. The lock wait is bounded for this transaction: behind a long
-- transaction (a running dump) it fails and rolls back instead of queueing every comment write
-- behind it; run migrate again later.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "comments_author_post" ON "comments" USING btree ("author_id","post_id") WHERE "comments"."deleted_at" is null and "comments"."removed_at" is null;
