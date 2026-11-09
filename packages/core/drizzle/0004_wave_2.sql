CREATE TABLE "community_rules" (
	"community_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"body_md" text,
	"body_html" text,
	CONSTRAINT "community_rules_community_id_position_pk" PRIMARY KEY("community_id","position"),
	CONSTRAINT "community_rules_position" CHECK ("community_rules"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"activity_ap_id" text NOT NULL,
	"activity_type" text NOT NULL,
	"object_ap_id" text,
	"sender_id" uuid NOT NULL,
	"inbox_url" text NOT NULL,
	"instance_id" uuid,
	"body" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_activity_inbox" UNIQUE("activity_ap_id","inbox_url"),
	CONSTRAINT "deliveries_state" CHECK ("deliveries"."state" in ('pending', 'delivered', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "community_rules" ADD CONSTRAINT "community_rules_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_sender_id_actors_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_due" ON "deliveries" USING btree ("next_attempt_at") WHERE "deliveries"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "deliveries_object" ON "deliveries" USING btree ("object_ap_id");--> statement-breakpoint
CREATE INDEX "deliveries_instance" ON "deliveries" USING btree ("instance_id","state");