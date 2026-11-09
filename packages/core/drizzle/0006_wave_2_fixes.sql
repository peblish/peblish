CREATE TABLE "object_rechecks" (
	"object_id" uuid PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "object_rechecks_checked" ON "object_rechecks" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "inbox_dedupe_seen" ON "inbox_dedupe" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "deletion_ledger_subject" ON "deletion_ledger" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "throttles_window" ON "throttles" USING btree ("window_start");