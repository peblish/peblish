CREATE TABLE "site_bans" (
	"actor_id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone,
	"banned_by" uuid,
	"activity_ap_id" text,
	"remove_content" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_bans_source" CHECK ("site_bans"."source" in ('local', 'remote'))
);
--> statement-breakpoint
CREATE TABLE "community_blocks" (
	"blocker_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_blocks_blocker_id_community_id_pk" PRIMARY KEY("blocker_id","community_id")
);
--> statement-breakpoint
CREATE TABLE "instance_blocks" (
	"blocker_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_blocks_blocker_id_instance_id_pk" PRIMARY KEY("blocker_id","instance_id")
);
--> statement-breakpoint
CREATE TABLE "person_blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "person_blocks_not_self" CHECK ("person_blocks"."blocker_id" <> "person_blocks"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "media_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"media_id" uuid NOT NULL,
	"source" text NOT NULL,
	"classification" text NOT NULL,
	"match_type" text,
	"manifest" jsonb NOT NULL,
	"manifest_sha256" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"hold_reference" text,
	"hold_until" timestamp with time zone,
	"retain_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_evidence_media_id_unique" UNIQUE("media_id"),
	CONSTRAINT "media_evidence_source" CHECK ("media_evidence"."source" in ('provider', 'list')),
	CONSTRAINT "media_evidence_status" CHECK ("media_evidence"."status" in ('open', 'confirmed', 'released'))
);
--> statement-breakpoint
CREATE TABLE "media_evidence_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "media_evidence_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"evidence_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"event" text NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "media_blocklist" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'sha256' NOT NULL,
	"value" text NOT NULL,
	"category" text NOT NULL,
	"reason" text,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_blocklist_value" UNIQUE("kind","value"),
	CONSTRAINT "media_blocklist_kind" CHECK ("media_blocklist"."kind" in ('sha256')),
	CONSTRAINT "media_blocklist_category" CHECK ("media_blocklist"."category" in ('csam', 'intimate_image', 'violent', 'spam', 'other'))
);
--> statement-breakpoint
CREATE TABLE "media_scans" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"actor_id" uuid,
	"community_id" uuid,
	"post_id" uuid,
	"comment_id" uuid,
	"modlog_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" in ('reply', 'mention', 'mod_remove', 'mod_restore', 'ban', 'unban'))
);
--> statement-breakpoint
CREATE TABLE "page_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"language" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"published_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"slug" text NOT NULL,
	"language" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"published_revision" uuid,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_slug_language_pk" PRIMARY KEY("slug","language")
);
--> statement-breakpoint
CREATE TABLE "peer_controls" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"media" text DEFAULT 'quarantined' NOT NULL,
	"inbox_paused" boolean DEFAULT false NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"reason" text,
	"purged_at" timestamp with time zone,
	"changed_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "peer_controls_media" CHECK ("peer_controls"."media" in ('quarantined', 'approved', 'denied'))
);
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "number" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "reports_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "audience" text DEFAULT 'moderators' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "escalated_by" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "modlog_id" uuid;--> statement-breakpoint
ALTER TABLE "site_bans" ADD CONSTRAINT "site_bans_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_bans" ADD CONSTRAINT "site_bans_banned_by_actors_id_fk" FOREIGN KEY ("banned_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_blocks" ADD CONSTRAINT "community_blocks_blocker_id_actors_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_blocks" ADD CONSTRAINT "community_blocks_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_blocks" ADD CONSTRAINT "instance_blocks_blocker_id_actors_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_blocks" ADD CONSTRAINT "instance_blocks_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_blocks" ADD CONSTRAINT "person_blocks_blocker_id_actors_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_blocks" ADD CONSTRAINT "person_blocks_blocked_id_actors_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_decided_by_actors_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_blocklist" ADD CONSTRAINT "media_blocklist_added_by_actors_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_scans" ADD CONSTRAINT "media_scans_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_actors_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_published_by_actors_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_published_revision_page_revisions_id_fk" FOREIGN KEY ("published_revision") REFERENCES "public"."page_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_updated_by_actors_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_controls" ADD CONSTRAINT "peer_controls_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_controls" ADD CONSTRAINT "peer_controls_changed_by_actors_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_blocks_community" ON "community_blocks" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "instance_blocks_instance" ON "instance_blocks" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "person_blocks_blocked" ON "person_blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "media_evidence_status" ON "media_evidence" USING btree ("status");--> statement-breakpoint
CREATE INDEX "media_evidence_log_evidence" ON "media_evidence_log" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "media_scans_lease" ON "media_scans" USING btree ("lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_recipient_ref" ON "notifications" USING btree ("recipient_id","ref_id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_id" ON "notifications" USING btree ("recipient_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread" ON "notifications" USING btree ("recipient_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "page_revisions_page" ON "page_revisions" USING btree ("slug","language","created_at");--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_escalated_by_actors_id_fk" FOREIGN KEY ("escalated_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_author_published" ON "comments" USING btree ("author_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_purge" ON "media" USING btree ("scan_state") WHERE "media"."storage_key" is not null and "media"."scan_state" in ('blocked', 'failed');--> statement-breakpoint
CREATE INDEX "reports_queue" ON "reports" USING btree ("audience","community_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_open_once" ON "reports" USING btree ("reporter_id",coalesce("target_post_id", "target_comment_id", "target_actor_id")) WHERE "reports"."status" = 'open';--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_number_unique" UNIQUE("number");--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_audience" CHECK ("reports"."audience" in ('moderators', 'admins'));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolution" CHECK ("reports"."resolution" in ('resolved', 'dismissed', 'removed'));