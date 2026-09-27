CREATE TYPE "public"."clarification_status" AS ENUM('OPEN', 'ANSWERED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."dispense_status" AS ENUM('PENDING', 'IN_PROGRESS', 'CLARIFICATION_NEEDED', 'READY', 'PARTIAL', 'DISPENSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."pharmacy_sale_status" AS ENUM('DRAFT', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('DRAFT', 'AWAITING_APPROVAL', 'PLACED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_type" AS ENUM('OPENING_BALANCE', 'RECEIPT', 'DISPENSE', 'SALE', 'SALE_RETURN', 'PURCHASE_RETURN', 'ADJUSTMENT', 'EXPIRY_WRITE_OFF', 'DAMAGE_WRITE_OFF');--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'PHARMACIST' BEFORE 'AUDITOR';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'RESEARCH_ANALYST' BEFORE 'AUDITOR';--> statement-breakpoint
CREATE TABLE "dispense_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"dispense_record_id" uuid NOT NULL,
	"medication_request_id" uuid NOT NULL,
	"product_id" uuid,
	"stock_batch_id" uuid,
	"quantity_prescribed" numeric(10, 2),
	"quantity_dispensed" integer DEFAULT 0 NOT NULL,
	"is_substitution" boolean DEFAULT false NOT NULL,
	"substitution_reason" text,
	"unit_price_paise" integer DEFAULT 0 NOT NULL,
	"gst_rate_bps" integer DEFAULT 0 NOT NULL,
	"line_total_paise" integer DEFAULT 0 NOT NULL,
	"not_dispensed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "dispense_line_qty_not_negative" CHECK (quantity_dispensed >= 0)
);
--> statement-breakpoint
ALTER TABLE "dispense_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "dispense_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"status" "dispense_status" DEFAULT 'PENDING' NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"dispensed_by" uuid,
	"notes" text,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dispense_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goods_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"supplier_id" uuid NOT NULL,
	"receipt_number" text NOT NULL,
	"supplier_invoice_number" text,
	"supplier_invoice_date" date,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by" uuid,
	"subtotal_paise" integer DEFAULT 0 NOT NULL,
	"tax_paise" integer DEFAULT 0 NOT NULL,
	"total_paise" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goods_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goods_receipt_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_number" text NOT NULL,
	"expiry_date" date NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost_paise" integer NOT NULL,
	"mrp_paise" integer,
	"gst_rate_bps" integer DEFAULT 0 NOT NULL,
	"line_total_paise" integer NOT NULL,
	"stock_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "goods_receipt_line_qty_positive" CHECK (quantity > 0)
);
--> statement-breakpoint
ALTER TABLE "goods_receipt_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pharmacy_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"catalogue_item_id" uuid,
	"name" text NOT NULL,
	"search_normalized" text NOT NULL,
	"brand_name" text,
	"molecule_name" text,
	"manufacturer" text,
	"strength" text,
	"dosage_form" text,
	"hsn_code" text,
	"gst_rate_bps" integer DEFAULT 0 NOT NULL,
	"pack_size" integer DEFAULT 1 NOT NULL,
	"pack_unit" text DEFAULT 'unit' NOT NULL,
	"mrp_paise" integer,
	"reorder_level" integer,
	"reorder_quantity" integer,
	"drug_schedule" text,
	"requires_prescription" boolean DEFAULT false NOT NULL,
	"is_narcotic" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pharmacy_product_gst_rate_sane" CHECK (gst_rate_bps BETWEEN 0 AND 10000),
	CONSTRAINT "pharmacy_product_pack_size_positive" CHECK (pack_size > 0)
);
--> statement-breakpoint
ALTER TABLE "pharmacy_product" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pharmacy_sale" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"sale_number" text NOT NULL,
	"status" "pharmacy_sale_status" DEFAULT 'DRAFT' NOT NULL,
	"patient_id" uuid,
	"dispense_record_id" uuid,
	"buyer_name" text,
	"subtotal_paise" integer DEFAULT 0 NOT NULL,
	"discount_paise" integer DEFAULT 0 NOT NULL,
	"discount_reason" text,
	"tax_paise" integer DEFAULT 0 NOT NULL,
	"total_paise" integer DEFAULT 0 NOT NULL,
	"paid_paise" integer DEFAULT 0 NOT NULL,
	"payment_method" "payment_method",
	"sold_by" uuid,
	"sold_at" timestamp with time zone,
	"is_return" boolean DEFAULT false NOT NULL,
	"return_of_sale_id" uuid,
	"return_reason" text,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pharmacy_sale_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"pharmacy_sale_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"stock_batch_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_paise" integer NOT NULL,
	"gst_rate_bps" integer DEFAULT 0 NOT NULL,
	"discount_paise" integer DEFAULT 0 NOT NULL,
	"line_total_paise" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pharmacy_sale_line_qty_not_zero" CHECK (quantity <> 0)
);
--> statement-breakpoint
ALTER TABLE "pharmacy_sale_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"status" "purchase_order_status" DEFAULT 'DRAFT' NOT NULL,
	"expected_at" date,
	"placed_at" timestamp with time zone,
	"placed_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"subtotal_paise" integer DEFAULT 0 NOT NULL,
	"tax_paise" integer DEFAULT 0 NOT NULL,
	"total_paise" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_order" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_ordered" integer NOT NULL,
	"quantity_received" integer DEFAULT 0 NOT NULL,
	"unit_cost_paise" integer NOT NULL,
	"gst_rate_bps" integer DEFAULT 0 NOT NULL,
	"line_total_paise" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_order_line_qty_positive" CHECK (quantity_ordered > 0),
	CONSTRAINT "purchase_order_line_received_not_negative" CHECK (quantity_received >= 0)
);
--> statement-breakpoint
ALTER TABLE "purchase_order_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rx_clarification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"medication_request_id" uuid NOT NULL,
	"dispense_record_id" uuid,
	"status" "clarification_status" DEFAULT 'OPEN' NOT NULL,
	"question" text NOT NULL,
	"raised_by" uuid,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer" text,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"resolution_action" text,
	"withdrawn_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rx_clarification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_number" text NOT NULL,
	"expiry_date" date NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"unit_cost_paise" integer DEFAULT 0 NOT NULL,
	"mrp_paise" integer,
	"supplier_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_batch_not_negative" CHECK (quantity_on_hand >= 0)
);
--> statement-breakpoint
ALTER TABLE "stock_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"stock_batch_id" uuid NOT NULL,
	"movement_type" "stock_movement_type" NOT NULL,
	"quantity_delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" text,
	"reference_type" text,
	"reference_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_delta_not_zero" CHECK (quantity_delta <> 0)
);
--> statement-breakpoint
ALTER TABLE "stock_movement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "supplier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"gstin" text,
	"drug_licence_number" text,
	"contact_person" text,
	"phone_e164" text,
	"email" text,
	"address_line1" text,
	"city" text,
	"state" text,
	"pincode" text,
	"payment_terms_days" integer,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "analyst_cohort" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"definition_version" integer DEFAULT 1 NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"chart_config" jsonb,
	"last_evaluated_at" timestamp with time zone,
	"last_evaluated_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analyst_cohort" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "analyst_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"cohort_id" uuid,
	"cohort_name" text NOT NULL,
	"definition_snapshot" jsonb NOT NULL,
	"definition_version" integer NOT NULL,
	"export_type" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"row_count" integer,
	"columns_included" jsonb,
	"object_key" text,
	"size_bytes" integer,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"download_expires_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analyst_export" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dispense_line" ADD CONSTRAINT "dispense_line_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_line" ADD CONSTRAINT "dispense_line_dispense_record_id_dispense_record_id_fk" FOREIGN KEY ("dispense_record_id") REFERENCES "public"."dispense_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_line" ADD CONSTRAINT "dispense_line_medication_request_id_medication_request_id_fk" FOREIGN KEY ("medication_request_id") REFERENCES "public"."medication_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_line" ADD CONSTRAINT "dispense_line_product_id_pharmacy_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_product"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_line" ADD CONSTRAINT "dispense_line_stock_batch_id_stock_batch_id_fk" FOREIGN KEY ("stock_batch_id") REFERENCES "public"."stock_batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_record" ADD CONSTRAINT "dispense_record_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_record" ADD CONSTRAINT "dispense_record_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_record" ADD CONSTRAINT "dispense_record_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_record" ADD CONSTRAINT "dispense_record_dispensed_by_app_user_id_fk" FOREIGN KEY ("dispensed_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_received_by_app_user_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_goods_receipt_id_goods_receipt_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_product_id_pharmacy_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_product" ADD CONSTRAINT "pharmacy_product_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_product" ADD CONSTRAINT "pharmacy_product_catalogue_item_id_drug_catalogue_item_id_fk" FOREIGN KEY ("catalogue_item_id") REFERENCES "public"."drug_catalogue_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD CONSTRAINT "pharmacy_sale_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD CONSTRAINT "pharmacy_sale_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD CONSTRAINT "pharmacy_sale_dispense_record_id_dispense_record_id_fk" FOREIGN KEY ("dispense_record_id") REFERENCES "public"."dispense_record"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD CONSTRAINT "pharmacy_sale_sold_by_app_user_id_fk" FOREIGN KEY ("sold_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale_line" ADD CONSTRAINT "pharmacy_sale_line_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale_line" ADD CONSTRAINT "pharmacy_sale_line_pharmacy_sale_id_pharmacy_sale_id_fk" FOREIGN KEY ("pharmacy_sale_id") REFERENCES "public"."pharmacy_sale"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale_line" ADD CONSTRAINT "pharmacy_sale_line_product_id_pharmacy_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale_line" ADD CONSTRAINT "pharmacy_sale_line_stock_batch_id_stock_batch_id_fk" FOREIGN KEY ("stock_batch_id") REFERENCES "public"."stock_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_placed_by_app_user_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_product_id_pharmacy_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_clarification" ADD CONSTRAINT "rx_clarification_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_clarification" ADD CONSTRAINT "rx_clarification_medication_request_id_medication_request_id_fk" FOREIGN KEY ("medication_request_id") REFERENCES "public"."medication_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_clarification" ADD CONSTRAINT "rx_clarification_dispense_record_id_dispense_record_id_fk" FOREIGN KEY ("dispense_record_id") REFERENCES "public"."dispense_record"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_clarification" ADD CONSTRAINT "rx_clarification_raised_by_app_user_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_clarification" ADD CONSTRAINT "rx_clarification_answered_by_app_user_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batch" ADD CONSTRAINT "stock_batch_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batch" ADD CONSTRAINT "stock_batch_product_id_pharmacy_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batch" ADD CONSTRAINT "stock_batch_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_product_id_pharmacy_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_stock_batch_id_stock_batch_id_fk" FOREIGN KEY ("stock_batch_id") REFERENCES "public"."stock_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyst_cohort" ADD CONSTRAINT "analyst_cohort_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyst_export" ADD CONSTRAINT "analyst_export_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyst_export" ADD CONSTRAINT "analyst_export_cohort_id_analyst_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."analyst_cohort"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyst_export" ADD CONSTRAINT "analyst_export_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispense_line_request_uq" ON "dispense_line" USING btree ("clinic_id","medication_request_id");--> statement-breakpoint
CREATE INDEX "dispense_line_record_idx" ON "dispense_line" USING btree ("clinic_id","dispense_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispense_record_encounter_uq" ON "dispense_record" USING btree ("clinic_id","encounter_id");--> statement-breakpoint
CREATE INDEX "dispense_record_clinic_open_idx" ON "dispense_record" USING btree ("clinic_id","queued_at") WHERE status NOT IN ('DISPENSED', 'CANCELLED');--> statement-breakpoint
CREATE INDEX "dispense_record_clinic_patient_idx" ON "dispense_record" USING btree ("clinic_id","patient_id","queued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_clinic_number_uq" ON "goods_receipt" USING btree ("clinic_id","receipt_number");--> statement-breakpoint
CREATE INDEX "goods_receipt_clinic_supplier_idx" ON "goods_receipt" USING btree ("clinic_id","supplier_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "goods_receipt_clinic_order_idx" ON "goods_receipt" USING btree ("clinic_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_line_receipt_idx" ON "goods_receipt_line" USING btree ("clinic_id","goods_receipt_id");--> statement-breakpoint
CREATE INDEX "pharmacy_product_clinic_search_idx" ON "pharmacy_product" USING btree ("clinic_id","search_normalized");--> statement-breakpoint
CREATE INDEX "pharmacy_product_clinic_catalogue_idx" ON "pharmacy_product" USING btree ("clinic_id","catalogue_item_id");--> statement-breakpoint
CREATE INDEX "pharmacy_product_clinic_active_idx" ON "pharmacy_product" USING btree ("clinic_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_sale_clinic_number_uq" ON "pharmacy_sale" USING btree ("clinic_id","sale_number");--> statement-breakpoint
CREATE INDEX "pharmacy_sale_clinic_sold_idx" ON "pharmacy_sale" USING btree ("clinic_id","sold_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pharmacy_sale_clinic_patient_idx" ON "pharmacy_sale" USING btree ("clinic_id","patient_id");--> statement-breakpoint
CREATE INDEX "pharmacy_sale_line_sale_idx" ON "pharmacy_sale_line" USING btree ("clinic_id","pharmacy_sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_clinic_number_uq" ON "purchase_order" USING btree ("clinic_id","order_number");--> statement-breakpoint
CREATE INDEX "purchase_order_clinic_status_idx" ON "purchase_order" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "purchase_order_clinic_supplier_idx" ON "purchase_order" USING btree ("clinic_id","supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_order_line_order_idx" ON "purchase_order_line" USING btree ("clinic_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "rx_clarification_clinic_open_idx" ON "rx_clarification" USING btree ("clinic_id","raised_at") WHERE status = 'OPEN';--> statement-breakpoint
CREATE INDEX "rx_clarification_request_idx" ON "rx_clarification" USING btree ("clinic_id","medication_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_batch_uq" ON "stock_batch" USING btree ("clinic_id","product_id","batch_number","expiry_date");--> statement-breakpoint
CREATE INDEX "stock_batch_clinic_product_idx" ON "stock_batch" USING btree ("clinic_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_batch_clinic_expiry_idx" ON "stock_batch" USING btree ("clinic_id","expiry_date") WHERE quantity_on_hand > 0;--> statement-breakpoint
CREATE INDEX "stock_movement_clinic_batch_idx" ON "stock_movement" USING btree ("clinic_id","stock_batch_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_movement_clinic_product_idx" ON "stock_movement" USING btree ("clinic_id","product_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_movement_clinic_type_idx" ON "stock_movement" USING btree ("clinic_id","movement_type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_clinic_name_uq" ON "supplier" USING btree ("clinic_id","name");--> statement-breakpoint
CREATE INDEX "supplier_clinic_active_idx" ON "supplier" USING btree ("clinic_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "analyst_cohort_clinic_name_uq" ON "analyst_cohort" USING btree ("clinic_id","name");--> statement-breakpoint
CREATE INDEX "analyst_cohort_clinic_shared_idx" ON "analyst_cohort" USING btree ("clinic_id","is_shared");--> statement-breakpoint
CREATE INDEX "analyst_export_clinic_requested_idx" ON "analyst_export" USING btree ("clinic_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "analyst_export_clinic_cohort_idx" ON "analyst_export" USING btree ("clinic_id","cohort_id");--> statement-breakpoint
CREATE POLICY "dispense_line_tenant_isolation" ON "dispense_line" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "dispense_record_tenant_isolation" ON "dispense_record" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "goods_receipt_tenant_isolation" ON "goods_receipt" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "goods_receipt_line_tenant_isolation" ON "goods_receipt_line" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pharmacy_product_tenant_isolation" ON "pharmacy_product" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pharmacy_sale_tenant_isolation" ON "pharmacy_sale" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pharmacy_sale_line_tenant_isolation" ON "pharmacy_sale_line" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "purchase_order_tenant_isolation" ON "purchase_order" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "purchase_order_line_tenant_isolation" ON "purchase_order_line" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "rx_clarification_tenant_isolation" ON "rx_clarification" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stock_batch_tenant_isolation" ON "stock_batch" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stock_movement_tenant_isolation" ON "stock_movement" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "supplier_tenant_isolation" ON "supplier" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "analyst_cohort_tenant_isolation" ON "analyst_cohort" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "analyst_export_tenant_isolation" ON "analyst_export" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);