CREATE TYPE "public"."platform_role" AS ENUM('SUPPORT', 'OPERATOR', 'PLATFORM_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "clinic_usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"day" date NOT NULL,
	"active_users" integer DEFAULT 0 NOT NULL,
	"patients_registered" integer DEFAULT 0 NOT NULL,
	"patients_total" integer DEFAULT 0 NOT NULL,
	"appointments" integer DEFAULT 0 NOT NULL,
	"encounters" integer DEFAULT 0 NOT NULL,
	"prescriptions" integer DEFAULT 0 NOT NULL,
	"messages_sent" integer DEFAULT 0 NOT NULL,
	"messages_failed" integer DEFAULT 0 NOT NULL,
	"documents_uploaded" integer DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinic_usage_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_platform_user_id" uuid,
	"actor_name" text,
	"actor_role" text,
	"action" text NOT NULL,
	"outcome" text DEFAULT 'SUCCESS' NOT NULL,
	"target_clinic_id" uuid,
	"target_clinic_name" text,
	"reason" text,
	"change_summary" jsonb,
	"ip_address" text,
	"user_agent" text,
	"request_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "platform_role" DEFAULT 'SUPPORT' NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret_encrypted" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"plan" text DEFAULT 'pilot' NOT NULL,
	"status" "subscription_status" DEFAULT 'TRIAL' NOT NULL,
	"monthly_price_paise" integer DEFAULT 0 NOT NULL,
	"max_practitioners" integer,
	"max_patients" integer,
	"included_messages_per_month" integer,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinic_usage_daily" ADD CONSTRAINT "clinic_usage_daily_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_usage_daily_uq" ON "clinic_usage_daily" USING btree ("clinic_id","day");--> statement-breakpoint
CREATE INDEX "clinic_usage_day_idx" ON "clinic_usage_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "platform_audit_occurred_idx" ON "platform_audit_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "platform_audit_clinic_idx" ON "platform_audit_event" USING btree ("target_clinic_id","occurred_at");--> statement-breakpoint
CREATE INDEX "platform_audit_actor_idx" ON "platform_audit_event" USING btree ("actor_platform_user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_user_email_uq" ON "platform_user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_clinic_uq" ON "subscription" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "subscription_status_idx" ON "subscription" USING btree ("status");--> statement-breakpoint
CREATE POLICY "clinic_usage_daily_tenant_isolation" ON "clinic_usage_daily" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subscription_tenant_isolation" ON "subscription" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);