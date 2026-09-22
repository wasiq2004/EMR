-- EDITED BY HAND after generation, and this is the only edit.
--
-- drizzle-kit emitted CREATE TYPE consultation_mode and the ALTER TABLE that
-- adds the column, because its snapshot did not know 0003_consultation_mode.sql
-- had already introduced them. Both are removed here so that change has ONE
-- owner: 0003, which is where the reasoning for it lives and which is guarded
-- so it is safe on a database that already has the column.
--
-- Leaving them in breaks every existing database on the next deploy, and
-- duplicating them means two files can disagree about the default.

CREATE TYPE "public"."broadcast_exclusion_reason" AS ENUM('NO_MOBILE', 'NO_CONSENT', 'OPTED_OUT', 'DUPLICATE_NUMBER', 'DECEASED_OR_MERGED');--> statement-breakpoint
CREATE TYPE "public"."broadcast_purpose" AS ENUM('CLINICAL', 'MARKETING');--> statement-breakpoint
CREATE TYPE "public"."broadcast_status" AS ENUM('DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED', 'SENT', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."message_template_status" AS ENUM('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');--> statement-breakpoint
CREATE TABLE "broadcast" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" "broadcast_purpose" NOT NULL,
	"status" "broadcast_status" DEFAULT 'DRAFT' NOT NULL,
	"template_id" uuid NOT NULL,
	"template_variables" jsonb,
	"audience_filter" jsonb,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"read_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"exclusion_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcast" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "broadcast_recipient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"mobile_e164" text NOT NULL,
	"communication_id" uuid,
	"status" "communication_status" DEFAULT 'QUEUED' NOT NULL,
	"failure_reason" text,
	"consent_id" uuid,
	"sent_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"category" text,
	"status" "message_template_status" DEFAULT 'DRAFT' NOT NULL,
	"status_reason" text,
	"body" text NOT NULL,
	"header_text" text,
	"footer_text" text,
	"buttons" jsonb,
	"variables" jsonb,
	"purpose" "broadcast_purpose" DEFAULT 'CLINICAL' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_template_id_message_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_broadcast_id_broadcast_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcast"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_clinic_status_idx" ON "broadcast" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "broadcast_scheduled_idx" ON "broadcast" USING btree ("scheduled_for") WHERE status = 'SCHEDULED';--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_recipient_uq" ON "broadcast_recipient" USING btree ("broadcast_id","patient_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipient_status_idx" ON "broadcast_recipient" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_name_uq" ON "message_template" USING btree ("clinic_id","name","language");--> statement-breakpoint
CREATE INDEX "message_template_status_idx" ON "message_template" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE POLICY "broadcast_tenant_isolation" ON "broadcast" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "broadcast_recipient_tenant_isolation" ON "broadcast_recipient" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_template_tenant_isolation" ON "message_template" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);