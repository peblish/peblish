-- Hand-written (drizzle-kit does not model triggers). The media evidence log and the published
-- page revisions are append-only, like the deletion ledger in 0001: no update, delete or truncate.
CREATE TRIGGER media_evidence_log_append_only BEFORE UPDATE OR DELETE ON "media_evidence_log" FOR EACH ROW EXECUTE FUNCTION peblish_append_only();
--> statement-breakpoint
CREATE TRIGGER media_evidence_log_no_truncate BEFORE TRUNCATE ON "media_evidence_log" FOR EACH STATEMENT EXECUTE FUNCTION peblish_append_only();
--> statement-breakpoint
CREATE TRIGGER page_revisions_append_only BEFORE UPDATE OR DELETE ON "page_revisions" FOR EACH ROW EXECUTE FUNCTION peblish_append_only();
--> statement-breakpoint
CREATE TRIGGER page_revisions_no_truncate BEFORE TRUNCATE ON "page_revisions" FOR EACH STATEMENT EXECUTE FUNCTION peblish_append_only();
