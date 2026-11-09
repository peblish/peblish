-- Guard (hand-written, not generated): a hold recorded before this migration has no authority, and
-- from here on only an AFP hold keeps an image's bytes, so the next purge would delete bytes a hold
-- protects. Stop while any hold is in force; nothing deployed has one.
DO $$
DECLARE
  held bigint;
BEGIN
  SELECT count(*) INTO held FROM "media_evidence" WHERE "hold_reference" IS NOT NULL AND "hold_until" > now();
  IF held > 0 THEN
    RAISE EXCEPTION '% media_evidence % a preservation hold in force. 0010_wave_3_fixes adds hold_authority, and only an AFP hold keeps the image bytes after it. Add a data fix to this migration to classify each active hold''s authority (afp, ncmec or nca) before applying it, or the next purge may delete bytes the hold protects.',
      held, CASE WHEN held = 1 THEN 'row has' ELSE 'rows have' END;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "media_evidence" DROP CONSTRAINT "media_evidence_media_id_unique";--> statement-breakpoint
ALTER TABLE "media_evidence" ADD COLUMN "hold_authority" text;--> statement-breakpoint
ALTER TABLE "media_evidence" ADD COLUMN "purge_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_scans" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "media_scans" ADD COLUMN "purge_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_scans" ADD COLUMN "purge_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "media_evidence_media" ON "media_evidence" USING btree ("media_id","created_at");--> statement-breakpoint
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_hold_authority" CHECK ("media_evidence"."hold_authority" in ('afp', 'ncmec', 'nca'));