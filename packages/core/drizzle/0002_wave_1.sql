CREATE TABLE "community_languages" (
	"community_id" uuid NOT NULL,
	"language" text NOT NULL,
	CONSTRAINT "community_languages_community_id_language_pk" PRIMARY KEY("community_id","language")
);
--> statement-breakpoint
CREATE TABLE "age_declarations" (
	"actor_id" uuid PRIMARY KEY NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_bans" (
	"community_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone,
	"banned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_bans_community_id_actor_id_pk" PRIMARY KEY("community_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE "community_removals" (
	"community_id" uuid PRIMARY KEY NOT NULL,
	"reason" text,
	"removed_by" uuid,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN "nsfl" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN "discoverable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN "indexable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN "posting_warning" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "url_content_type" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "alt_text" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "nsfl" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "modlog" ADD COLUMN "public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "community_languages" ADD CONSTRAINT "community_languages_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "age_declarations" ADD CONSTRAINT "age_declarations_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_bans" ADD CONSTRAINT "community_bans_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_bans" ADD CONSTRAINT "community_bans_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_bans" ADD CONSTRAINT "community_bans_banned_by_actors_id_fk" FOREIGN KEY ("banned_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_removals" ADD CONSTRAINT "community_removals_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_removals" ADD CONSTRAINT "community_removals_removed_by_actors_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_bans_actor" ON "community_bans" USING btree ("actor_id");