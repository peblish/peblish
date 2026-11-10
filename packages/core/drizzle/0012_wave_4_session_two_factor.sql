CREATE TABLE "session_two_factor" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_two_factor" ADD CONSTRAINT "session_two_factor_session_id_auth_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_session_expires_at" ON "auth_session" USING btree ("expires_at");