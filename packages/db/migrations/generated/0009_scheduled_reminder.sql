CREATE TYPE "public"."reminder_channel" AS ENUM('WHATSAPP', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."reminder_kind" AS ENUM('FOLLOW_UP', 'APPOINTMENT');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "scheduled_reminder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" "reminder_kind" NOT NULL,
	"encounter_id" uuid,
	"appointment_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"channel" "reminder_channel" DEFAULT 'WHATSAPP' NOT NULL,
	"status" "reminder_status" DEFAULT 'PENDING' NOT NULL,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"communication_id" uuid,
	"notify_clinic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_reminder" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduled_reminder" ADD CONSTRAINT "scheduled_reminder_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_reminder" ADD CONSTRAINT "scheduled_reminder_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_reminder_due_idx" ON "scheduled_reminder" USING btree ("clinic_id","due_at") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX "scheduled_reminder_patient_idx" ON "scheduled_reminder" USING btree ("clinic_id","patient_id","due_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_reminder_encounter_uq" ON "scheduled_reminder" USING btree ("encounter_id","kind") WHERE encounter_id IS NOT NULL AND status IN ('PENDING', 'SENDING', 'SENT');--> statement-breakpoint
CREATE POLICY "scheduled_reminder_tenant_isolation" ON "scheduled_reminder" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);