CREATE TABLE "practitioner_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"location_id" uuid,
	"weekday" integer NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"slot_minutes" integer DEFAULT 15 NOT NULL,
	"capacity_per_slot" integer DEFAULT 1 NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "practitioner_schedule_weekday_valid" CHECK (weekday BETWEEN 0 AND 6),
	CONSTRAINT "practitioner_schedule_ends_after_start" CHECK (ends_at > starts_at),
	CONSTRAINT "practitioner_schedule_slot_sane" CHECK (slot_minutes BETWEEN 5 AND 240),
	CONSTRAINT "practitioner_schedule_capacity_positive" CHECK (capacity_per_slot >= 1)
);
--> statement-breakpoint
ALTER TABLE "practitioner_schedule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "schedule_exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"practitioner_id" uuid,
	"on_date" date NOT NULL,
	"is_available" boolean DEFAULT false NOT NULL,
	"starts_at" time,
	"ends_at" time,
	"slot_minutes" integer,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "schedule_exception_hours_paired" CHECK ((starts_at IS NULL) = (ends_at IS NULL)),
	CONSTRAINT "schedule_exception_ends_after_start" CHECK (starts_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
ALTER TABLE "schedule_exception" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "practitioner_schedule" ADD CONSTRAINT "practitioner_schedule_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_schedule" ADD CONSTRAINT "practitioner_schedule_practitioner_id_app_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_schedule" ADD CONSTRAINT "practitioner_schedule_location_id_clinic_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."clinic_location"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exception" ADD CONSTRAINT "schedule_exception_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exception" ADD CONSTRAINT "schedule_exception_practitioner_id_app_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "practitioner_schedule_lookup_idx" ON "practitioner_schedule" USING btree ("clinic_id","practitioner_id","weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_exception_uq" ON "schedule_exception" USING btree ("clinic_id",coalesce("practitioner_id", '00000000-0000-0000-0000-000000000000'::uuid),"on_date");--> statement-breakpoint
CREATE INDEX "schedule_exception_date_idx" ON "schedule_exception" USING btree ("clinic_id","on_date");--> statement-breakpoint
CREATE POLICY "practitioner_schedule_tenant_isolation" ON "practitioner_schedule" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "schedule_exception_tenant_isolation" ON "schedule_exception" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);