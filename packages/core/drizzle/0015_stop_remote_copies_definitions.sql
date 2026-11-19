-- Changes nothing in the database. The Drizzle definitions stop naming votes.raw and
-- activities.inbox_raw_id (with its FK and the activities_inbox_raw index), so inserts from this
-- release on leave both columns out; the snapshot records that. A later migration deletes the
-- remote activities rows and drops both columns once no older process still names them:
--   ALTER TABLE "activities" DROP CONSTRAINT "activities_inbox_raw_id_inbox_raw_id_fk";
--   DROP INDEX "activities_inbox_raw";
--   ALTER TABLE "votes" DROP COLUMN "raw";
--   ALTER TABLE "activities" DROP COLUMN "inbox_raw_id";
SELECT 1;
