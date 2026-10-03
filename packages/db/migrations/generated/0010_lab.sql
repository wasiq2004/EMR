CREATE TYPE "public"."lab_interpretation" AS ENUM('NORMAL', 'LOW', 'HIGH', 'CRITICAL', 'ABNORMAL');--> statement-breakpoint
CREATE TYPE "public"."lab_order_status" AS ENUM('ORDERED', 'RESULTED', 'REVIEWED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "lab_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"catalogue_item_id" uuid,
	"test_name" text NOT NULL,
	"unit" text,
	"status" "lab_order_status" DEFAULT 'ORDERED' NOT NULL,
	"clinical_note" text,
	"is_urgent" boolean DEFAULT false NOT NULL,
	"ordered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ordered_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lab_order" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lab_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"lab_order_id" uuid NOT NULL,
	"value_numeric" numeric(14, 4),
	"value_text" text,
	"unit" text,
	"reference_low" numeric(12, 4),
	"reference_high" numeric(12, 4),
	"interpretation" "lab_interpretation",
	"specimen_at" timestamp with time zone,
	"resulted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"performed_by" text,
	"lab_note" text,
	"document_id" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_reason" text,
	"entered_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "lab_result_has_a_value" CHECK (value_numeric IS NOT NULL OR coalesce(trim(value_text), '') <> '')
);
--> statement-breakpoint
ALTER TABLE "lab_result" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lab_test_catalogue_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"code" text,
	"code_system" text,
	"name" text NOT NULL,
	"search_normalized" text NOT NULL,
	"category" text,
	"unit" text,
	"reference_low" numeric(12, 4),
	"reference_high" numeric(12, 4),
	"price_paise" bigint,
	"catalogue_version" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lab_test_catalogue_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_ordered_by_app_user_id_fk" FOREIGN KEY ("ordered_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result" ADD CONSTRAINT "lab_result_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result" ADD CONSTRAINT "lab_result_lab_order_id_lab_order_id_fk" FOREIGN KEY ("lab_order_id") REFERENCES "public"."lab_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result" ADD CONSTRAINT "lab_result_document_id_document_reference_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document_reference"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result" ADD CONSTRAINT "lab_result_entered_by_app_user_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_test_catalogue_item" ADD CONSTRAINT "lab_test_catalogue_item_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_order_clinic_patient_idx" ON "lab_order" USING btree ("clinic_id","patient_id","ordered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "lab_order_awaiting_idx" ON "lab_order" USING btree ("clinic_id","is_urgent" DESC NULLS LAST,"ordered_at") WHERE status IN ('ORDERED', 'RESULTED') AND reviewed_at IS NULL;--> statement-breakpoint
CREATE INDEX "lab_result_clinic_order_idx" ON "lab_result" USING btree ("clinic_id","lab_order_id","resulted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "lab_result_live_uq" ON "lab_result" USING btree ("lab_order_id") WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE INDEX "lab_test_catalogue_search_trgm_idx" ON "lab_test_catalogue_item" USING gin ("clinic_id" uuid_ops,"search_normalized" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "lab_test_catalogue_uq" ON "lab_test_catalogue_item" USING btree ("clinic_id","name");--> statement-breakpoint
CREATE POLICY "lab_order_tenant_isolation" ON "lab_order" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "lab_result_tenant_isolation" ON "lab_result" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "lab_test_catalogue_item_shared_read" ON "lab_test_catalogue_item" AS PERMISSIVE FOR SELECT TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id IN (
      nullif(current_setting('app.clinic_id', true), '')::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    ));--> statement-breakpoint
CREATE POLICY "lab_test_catalogue_item_own_insert" ON "lab_test_catalogue_item" AS PERMISSIVE FOR INSERT TO "emr_app", "emr_readonly", "emr_worker_messaging" WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "lab_test_catalogue_item_own_update" ON "lab_test_catalogue_item" AS PERMISSIVE FOR UPDATE TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "lab_test_catalogue_item_own_delete" ON "lab_test_catalogue_item" AS PERMISSIVE FOR DELETE TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);