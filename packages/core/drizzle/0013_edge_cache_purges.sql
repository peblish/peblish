CREATE TABLE "edge_purges" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "edge_purges_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tag" text NOT NULL,
	"send" smallint DEFAULT 1 NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edge_status" (
	"name" text PRIMARY KEY NOT NULL,
	"verified_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "edge_purges_owed" ON "edge_purges" USING btree ("tag","send") WHERE "edge_purges"."claim_token" is null;--> statement-breakpoint
CREATE INDEX "edge_purges_due" ON "edge_purges" USING btree ("due_at");