-- The account features' side tables, all empty: saved posts, sidebar pins, thread follows and
-- thread visit markers (owner-only, branch 5). Nothing existing is rewritten. The foreign keys
-- take a SHARE ROW EXCLUSIVE lock on actors and posts for an instant (no rows to check), so the
-- lock wait is bounded for this transaction: behind a long write transaction on either it fails
-- and rolls back whole instead of queueing every write to those tables behind it; run migrate
-- again later.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "community_pins" (
	"owner_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "community_pins_owner_id_community_id_pk" PRIMARY KEY("owner_id","community_id"),
	CONSTRAINT "community_pins_position" CHECK ("community_pins"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "saved_posts" (
	"owner_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_posts_owner_id_post_id_pk" PRIMARY KEY("owner_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "thread_visits" (
	"owner_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"last_visit_at" timestamp with time zone NOT NULL,
	"previous_visit_at" timestamp with time zone,
	CONSTRAINT "thread_visits_owner_id_post_id_pk" PRIMARY KEY("owner_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "thread_watches" (
	"owner_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_watches_owner_id_post_id_pk" PRIMARY KEY("owner_id","post_id")
);
--> statement-breakpoint
ALTER TABLE "community_pins" ADD CONSTRAINT "community_pins_owner_id_actors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_pins" ADD CONSTRAINT "community_pins_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_posts" ADD CONSTRAINT "saved_posts_owner_id_actors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_posts" ADD CONSTRAINT "saved_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_visits" ADD CONSTRAINT "thread_visits_owner_id_actors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_visits" ADD CONSTRAINT "thread_visits_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_watches" ADD CONSTRAINT "thread_watches_owner_id_actors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_watches" ADD CONSTRAINT "thread_watches_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_pins_owner_position" ON "community_pins" USING btree ("owner_id","position");--> statement-breakpoint
CREATE INDEX "community_pins_community" ON "community_pins" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "saved_posts_owner_saved" ON "saved_posts" USING btree ("owner_id","saved_at" DESC NULLS LAST,"post_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "saved_posts_post" ON "saved_posts" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "thread_visits_post" ON "thread_visits" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "thread_watches_post" ON "thread_watches" USING btree ("post_id","since","owner_id");