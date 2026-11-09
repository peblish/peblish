CREATE TABLE "backfills" (
	"community_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"posts" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"note" text,
	CONSTRAINT "backfills_state" CHECK ("backfills"."state" in ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "instance_health" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"failing_since" timestamp with time zone,
	"dormant_since" timestamp with time zone,
	"revived_at" timestamp with time zone,
	"last_probe_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_health_state" CHECK ("instance_health"."state" in ('active', 'dormant'))
);
--> statement-breakpoint
ALTER TABLE "backfills" ADD CONSTRAINT "backfills_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_health" ADD CONSTRAINT "instance_health_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backfills_due" ON "backfills" USING btree ("next_attempt_at") WHERE "backfills"."state" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "actors_gated" ON "actors" USING btree ("id") WHERE "actors"."sensitive" or "actors"."nsfl";--> statement-breakpoint
CREATE INDEX "posts_score" ON "posts" USING btree (("upvotes" - "downvotes") desc nulls last,"id" desc nulls last);--> statement-breakpoint
CREATE INDEX "inbox_raw_actor" ON "inbox_raw" USING btree ("actor_ap_id","received_at");--> statement-breakpoint
CREATE INDEX "inbox_raw_processed" ON "inbox_raw" USING btree ("processed_at") WHERE "inbox_raw"."state" <> 'pending';--> statement-breakpoint
CREATE INDEX "deliveries_delivered" ON "deliveries" USING btree ("instance_id","settled_at") WHERE "deliveries"."state" = 'delivered';--> statement-breakpoint
CREATE INDEX "deliveries_settled" ON "deliveries" USING btree ("settled_at") WHERE "deliveries"."state" <> 'pending';