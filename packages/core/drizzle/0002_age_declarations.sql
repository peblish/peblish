CREATE TABLE "age_declarations" (
	"actor_id" uuid PRIMARY KEY NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "age_declarations" ADD CONSTRAINT "age_declarations_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;