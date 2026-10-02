CREATE TABLE "diagnosis_catalogue_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"code" text NOT NULL,
	"code_system" text NOT NULL,
	"display_text" text NOT NULL,
	"search_normalized" text NOT NULL,
	"category" text,
	"is_chronic_by_default" boolean DEFAULT false NOT NULL,
	"catalogue_version" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diagnosis_catalogue_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "diagnosis_catalogue_item" ADD CONSTRAINT "diagnosis_catalogue_item_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagnosis_catalogue_search_trgm_idx" ON "diagnosis_catalogue_item" USING gin ("clinic_id" uuid_ops,"search_normalized" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "diagnosis_catalogue_clinic_code_idx" ON "diagnosis_catalogue_item" USING btree ("clinic_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "diagnosis_catalogue_uq" ON "diagnosis_catalogue_item" USING btree ("clinic_id","code","display_text");--> statement-breakpoint
CREATE POLICY "diagnosis_catalogue_item_shared_read" ON "diagnosis_catalogue_item" AS PERMISSIVE FOR SELECT TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id IN (
      nullif(current_setting('app.clinic_id', true), '')::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    ));--> statement-breakpoint
CREATE POLICY "diagnosis_catalogue_item_own_insert" ON "diagnosis_catalogue_item" AS PERMISSIVE FOR INSERT TO "emr_app", "emr_readonly", "emr_worker_messaging" WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "diagnosis_catalogue_item_own_update" ON "diagnosis_catalogue_item" AS PERMISSIVE FOR UPDATE TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "diagnosis_catalogue_item_own_delete" ON "diagnosis_catalogue_item" AS PERMISSIVE FOR DELETE TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);