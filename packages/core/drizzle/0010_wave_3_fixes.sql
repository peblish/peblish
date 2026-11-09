ALTER TABLE "media_evidence" DROP CONSTRAINT "media_evidence_media_id_unique";--> statement-breakpoint
ALTER TABLE "media_evidence" ADD COLUMN "hold_authority" text;--> statement-breakpoint
ALTER TABLE "media_evidence" ADD COLUMN "purge_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_scans" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "media_scans" ADD COLUMN "purge_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_scans" ADD COLUMN "purge_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "media_evidence_media" ON "media_evidence" USING btree ("media_id","created_at");--> statement-breakpoint
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_hold_authority" CHECK ("media_evidence"."hold_authority" in ('afp', 'ncmec', 'nca'));