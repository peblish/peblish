CREATE TABLE "throttles" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "throttles_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "totp_steps" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"step" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "totp_steps" ADD CONSTRAINT "totp_steps_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;