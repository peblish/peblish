CREATE TABLE "outbox_skipped" (
	"consumer" text NOT NULL,
	"event_id" bigint NOT NULL,
	"type" text NOT NULL,
	"error" text,
	"failures" integer NOT NULL,
	"first_failure_at" timestamp with time zone NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL,
	"skipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_skipped_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
ALTER TABLE "outbox_cursors" ADD COLUMN "failing_event_id" bigint;--> statement-breakpoint
ALTER TABLE "outbox_cursors" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_cursors" ADD COLUMN "first_failure_at" timestamp with time zone;