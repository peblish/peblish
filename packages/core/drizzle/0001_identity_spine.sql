CREATE TABLE "actor_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"algorithm" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"private_key_pem" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_keys_key_id_unique" UNIQUE("key_id"),
	CONSTRAINT "actor_keys_algorithm" CHECK ("actor_keys"."algorithm" in ('rsa', 'ed25519'))
);
--> statement-breakpoint
CREATE TABLE "actors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ap_id" text NOT NULL,
	"kind" text NOT NULL,
	"local" boolean NOT NULL,
	"instance_id" uuid NOT NULL,
	"raw" jsonb,
	"name" text NOT NULL,
	"display_name" text,
	"summary_html" text,
	"summary_md" text,
	"inbox_url" text,
	"shared_inbox_url" text,
	"outbox_url" text,
	"followers_url" text,
	"featured_url" text,
	"moderators_url" text,
	"icon_url" text,
	"banner_url" text,
	"sensitive" boolean DEFAULT false NOT NULL,
	"bot" boolean DEFAULT false NOT NULL,
	"posting_restricted_to_mods" boolean DEFAULT false NOT NULL,
	"user_id" uuid,
	"imported_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"fetched_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actors_ap_id_unique" UNIQUE("ap_id"),
	CONSTRAINT "actors_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "actors_local_name_chars" CHECK (not "actors"."local" or "actors"."imported_at" is not null or "actors"."name" ~ '^[A-Za-z0-9_]{1,50}$'),
	CONSTRAINT "actors_kind" CHECK ("actors"."kind" in ('Person', 'Group', 'Application', 'Service')),
	CONSTRAINT "actors_user_is_local_person" CHECK ("actors"."user_id" is null or ("actors"."local" and "actors"."kind" = 'Person'))
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_two_factor" (
	"id" uuid PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ap_id" text NOT NULL,
	"local" boolean NOT NULL,
	"instance_id" uuid NOT NULL,
	"raw" jsonb,
	"post_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"parent_id" uuid,
	"path" "ltree" NOT NULL,
	"body_md" text,
	"content_html" text,
	"language" text,
	"distinguished" boolean DEFAULT false NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"child_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_ap_id_unique" UNIQUE("ap_id"),
	CONSTRAINT "comments_depth" CHECK (nlevel("comments"."path") between 1 and 50)
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ap_id" text NOT NULL,
	"local" boolean NOT NULL,
	"instance_id" uuid NOT NULL,
	"raw" jsonb,
	"author_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"body_md" text,
	"content_html" text,
	"language" text,
	"sensitive" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"featured_community" boolean DEFAULT false NOT NULL,
	"featured_local" boolean DEFAULT false NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_ap_id_unique" UNIQUE("ap_id")
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ap_id" text NOT NULL,
	"local" boolean NOT NULL,
	"instance_id" uuid NOT NULL,
	"raw" jsonb,
	"voter_id" uuid NOT NULL,
	"post_id" uuid,
	"comment_id" uuid,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_ap_id_unique" UNIQUE("ap_id"),
	CONSTRAINT "votes_one_target" CHECK (num_nonnulls("votes"."post_id", "votes"."comment_id") = 1),
	CONSTRAINT "votes_value" CHECK ("votes"."value" in (1, -1))
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ap_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_ap_id" text NOT NULL,
	"object_ap_id" text,
	"local" boolean NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_ap_id_unique" UNIQUE("ap_id")
);
--> statement-breakpoint
CREATE TABLE "inbox_dedupe" (
	"activity_id" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_raw" (
	"id" uuid PRIMARY KEY NOT NULL,
	"activity_id" text,
	"activity_type" text,
	"actor_ap_id" text,
	"body" jsonb NOT NULL,
	"headers" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"error" text,
	"processed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_raw_state" CHECK ("inbox_raw"."state" in ('pending', 'applied', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"follower_id" uuid NOT NULL,
	"followee_id" uuid NOT NULL,
	"ap_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_ap_id_unique" UNIQUE("ap_id"),
	CONSTRAINT "follows_state" CHECK ("follows"."state" in ('pending', 'accepted'))
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"local" boolean DEFAULT false NOT NULL,
	"software" text,
	"software_version" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instances_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid,
	"kind" text NOT NULL,
	"storage_key" text,
	"remote_url" text,
	"mime_type" text,
	"byte_size" bigint,
	"width" integer,
	"height" integer,
	"sha256" text,
	"alt_text" text,
	"scan_state" text DEFAULT 'pending' NOT NULL,
	"scanned_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "media_kind" CHECK ("media"."kind" in ('upload', 'remote', 'thumbnail')),
	CONSTRAINT "media_scan_state" CHECK ("media"."scan_state" in ('pending', 'clean', 'quarantined', 'blocked', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "community_moderators" (
	"community_id" uuid NOT NULL,
	"moderator_id" uuid NOT NULL,
	"role" text DEFAULT 'moderator' NOT NULL,
	"source" text NOT NULL,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_moderators_community_id_moderator_id_pk" PRIMARY KEY("community_id","moderator_id"),
	CONSTRAINT "community_moderators_role" CHECK ("community_moderators"."role" in ('owner', 'moderator')),
	CONSTRAINT "community_moderators_source" CHECK ("community_moderators"."source" in ('local', 'remote'))
);
--> statement-breakpoint
CREATE TABLE "modlog" (
	"id" uuid PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"moderator_id" uuid,
	"community_id" uuid,
	"target_actor_id" uuid,
	"target_post_id" uuid,
	"target_comment_id" uuid,
	"target_ap_id" text,
	"reason" text,
	"authority" jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activity_ap_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ap_id" text,
	"local" boolean NOT NULL,
	"instance_id" uuid NOT NULL,
	"raw" jsonb,
	"reporter_id" uuid,
	"community_id" uuid,
	"target_actor_id" uuid,
	"target_post_id" uuid,
	"target_comment_id" uuid,
	"category" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_ap_id_unique" UNIQUE("ap_id"),
	CONSTRAINT "reports_status" CHECK ("reports"."status" in ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tx_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"type" text NOT NULL,
	"v" smallint NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_cursors" (
	"consumer" text PRIMARY KEY NOT NULL,
	"tx_id" "xid8" NOT NULL,
	"event_id" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"retry_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deletion_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_ap_id" text,
	"reason" text NOT NULL,
	"requested_by" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_ledger_subject_kind" CHECK ("deletion_ledger"."subject_kind" in ('user', 'actor', 'post', 'comment', 'media'))
);
--> statement-breakpoint
CREATE TABLE "invite_uses" (
	"invite_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_uses_invite_id_actor_id_pk" PRIMARY KEY("invite_id","actor_id"),
	CONSTRAINT "invite_uses_actor_id_unique" UNIQUE("actor_id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" uuid,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"note" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "invites_uses" CHECK ("invites"."max_uses" > 0 and "invites"."use_count" between 0 and "invites"."max_uses")
);
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actor_keys" ADD CONSTRAINT "actor_keys_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_two_factor" ADD CONSTRAINT "auth_two_factor_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_actors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_actors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_id_actors_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_actors_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_actors_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_owner_id_actors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderators" ADD CONSTRAINT "community_moderators_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderators" ADD CONSTRAINT "community_moderators_moderator_id_actors_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modlog" ADD CONSTRAINT "modlog_moderator_id_actors_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modlog" ADD CONSTRAINT "modlog_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_actors_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_actors_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_uses" ADD CONSTRAINT "invite_uses_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_uses" ADD CONSTRAINT "invite_uses_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_actors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_updated_by_actors_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actor_keys_one_per_algorithm" ON "actor_keys" USING btree ("actor_id","algorithm");--> statement-breakpoint
CREATE UNIQUE INDEX "actors_local_name_unique" ON "actors" USING btree (lower("name")) WHERE "actors"."local";--> statement-breakpoint
CREATE INDEX "actors_instance_name" ON "actors" USING btree ("instance_id",lower("name"));--> statement-breakpoint
CREATE INDEX "auth_account_user" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_two_factor_user" ON "auth_two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_two_factor_secret" ON "auth_two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "comments_post" ON "comments" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "comments_path" ON "comments" USING gist ("path");--> statement-breakpoint
CREATE INDEX "comments_author" ON "comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "posts_community_published" ON "posts" USING btree ("community_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_author_published" ON "posts" USING btree ("author_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_published" ON "posts" USING btree ("published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "votes_voter_post" ON "votes" USING btree ("voter_id","post_id") WHERE "votes"."post_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "votes_voter_comment" ON "votes" USING btree ("voter_id","comment_id") WHERE "votes"."comment_id" is not null;--> statement-breakpoint
CREATE INDEX "votes_post" ON "votes" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "votes_comment" ON "votes" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "activities_object" ON "activities" USING btree ("object_ap_id");--> statement-breakpoint
CREATE INDEX "inbox_raw_pending" ON "inbox_raw" USING btree ("received_at") WHERE "inbox_raw"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "inbox_raw_activity" ON "inbox_raw" USING btree ("activity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "follows_pair" ON "follows" USING btree ("follower_id","followee_id");--> statement-breakpoint
CREATE INDEX "follows_followee" ON "follows" USING btree ("followee_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "instances_one_local" ON "instances" USING btree ("local") WHERE "instances"."local";--> statement-breakpoint
CREATE INDEX "media_scan_pending" ON "media" USING btree ("created_at") WHERE "media"."scan_state" = 'pending';--> statement-breakpoint
CREATE INDEX "media_sha256" ON "media" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "community_moderators_moderator" ON "community_moderators" USING btree ("moderator_id");--> statement-breakpoint
CREATE INDEX "modlog_created" ON "modlog" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "modlog_community_created" ON "modlog" USING btree ("community_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_open" ON "reports" USING btree ("created_at") WHERE "reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "outbox_order" ON "outbox" USING btree ("tx_id","id");--> statement-breakpoint
-- Hand-written below this line (drizzle-kit does not model triggers). Regenerating 0001 must keep it.
-- The identity spine never changes once stored: federation addresses rows by ap_id.
CREATE FUNCTION peblish_immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ap_id IS DISTINCT FROM OLD.ap_id OR NEW.local IS DISTINCT FROM OLD.local OR NEW.instance_id IS DISTINCT FROM OLD.instance_id THEN
    RAISE EXCEPTION 'ap_id, local and instance_id of % are immutable', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER actors_immutable_identity BEFORE UPDATE ON "actors" FOR EACH ROW EXECUTE FUNCTION peblish_immutable_identity();
--> statement-breakpoint
CREATE TRIGGER posts_immutable_identity BEFORE UPDATE ON "posts" FOR EACH ROW EXECUTE FUNCTION peblish_immutable_identity();
--> statement-breakpoint
CREATE TRIGGER comments_immutable_identity BEFORE UPDATE ON "comments" FOR EACH ROW EXECUTE FUNCTION peblish_immutable_identity();
--> statement-breakpoint
CREATE TRIGGER votes_immutable_identity BEFORE UPDATE ON "votes" FOR EACH ROW EXECUTE FUNCTION peblish_immutable_identity();
--> statement-breakpoint
-- The modlog and the deletion ledger are append-only.
CREATE FUNCTION peblish_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER modlog_append_only BEFORE UPDATE OR DELETE ON "modlog" FOR EACH ROW EXECUTE FUNCTION peblish_append_only();
--> statement-breakpoint
CREATE TRIGGER deletion_ledger_append_only BEFORE UPDATE OR DELETE ON "deletion_ledger" FOR EACH ROW EXECUTE FUNCTION peblish_append_only();
