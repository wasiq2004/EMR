CREATE TYPE "public"."allergy_category" AS ENUM('MEDICATION', 'FOOD', 'ENVIRONMENT', 'BIOLOGIC');--> statement-breakpoint
CREATE TYPE "public"."allergy_criticality" AS ENUM('LOW', 'HIGH', 'UNABLE_TO_ASSESS');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_PROGRESS', 'FULFILLED', 'CANCELLED', 'NOSHOW');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('SUCCESS', 'MINOR_FAILURE', 'SERIOUS_FAILURE', 'MAJOR_FAILURE');--> statement-breakpoint
CREATE TYPE "public"."communication_channel" AS ENUM('WHATSAPP', 'SMS', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."communication_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."communication_status" AS ENUM('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED');--> statement-breakpoint
CREATE TYPE "public"."condition_clinical_status" AS ENUM('ACTIVE', 'RECURRENCE', 'RELAPSE', 'INACTIVE', 'REMISSION', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."condition_verification_status" AS ENUM('UNCONFIRMED', 'PROVISIONAL', 'DIFFERENTIAL', 'CONFIRMED', 'REFUTED', 'ENTERED_IN_ERROR');--> statement-breakpoint
CREATE TYPE "public"."consent_scope" AS ENUM('TREATMENT', 'DATA_PROCESSING', 'WHATSAPP_COMMUNICATION', 'MARKETING_COMMUNICATION', 'DATA_SHARING_THIRD_PARTY', 'ABDM_LINKAGE');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('DRAFT', 'ACTIVE', 'INACTIVE', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('OPEN', 'WAITING', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('CURRENT', 'SUPERSEDED', 'ENTERED_IN_ERROR');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('PRESCRIPTION', 'LAB_REPORT', 'IMAGING_REPORT', 'DISCHARGE_SUMMARY', 'REFERRAL_LETTER', 'CONSENT_FORM', 'INVOICE', 'PATIENT_UPLOAD', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."encounter_status" AS ENUM('PLANNED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED', 'ENTERED_IN_ERROR');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'BALANCED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."medication_request_status" AS ENUM('DRAFT', 'ACTIVE', 'ON_HOLD', 'STOPPED', 'COMPLETED', 'CANCELLED', 'ENTERED_IN_ERROR');--> statement-breakpoint
CREATE TYPE "public"."observation_status" AS ENUM('REGISTERED', 'PRELIMINARY', 'FINAL', 'AMENDED', 'CORRECTED', 'CANCELLED', 'ENTERED_IN_ERROR');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'UPI', 'CARD', 'NETBANKING', 'CHEQUE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."reaction_severity" AS ENUM('MILD', 'MODERATE', 'SEVERE');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('ROUTINE', 'URGENT', 'ASAP', 'STAT');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER_ADMIN', 'DOCTOR', 'RECEPTIONIST', 'NURSE_ASSISTANT', 'AUDITOR');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_message_kind" AS ENUM('TEMPLATE', 'SESSION');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"mobile_e164" text,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone,
	"role" "user_role" NOT NULL,
	"medical_registration_number" text,
	"medical_council" text,
	"qualifications" text,
	"specialty" text,
	"abdm_hpr_id" text,
	"signature_image_object_key" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret_encrypted" text,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "clinic" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"registration_number" text,
	"gstin" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"pincode" text,
	"contact_phone_e164" text,
	"contact_email" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"logo_object_key" text,
	"abdm_hfr_id" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspension_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinic" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "clinic_location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address_line1" text,
	"city" text,
	"state" text,
	"pincode" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinic_location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "refresh_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"previous_session_id" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"default_fee_paise" bigint DEFAULT 0 NOT NULL,
	"hsn_sac_code" text,
	"tax_rate_bps" integer DEFAULT 0 NOT NULL,
	"default_duration_minutes" integer,
	"practitioner_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"practitioner_id" uuid,
	"location_id" uuid,
	"status" "appointment_status" DEFAULT 'SCHEDULED' NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"called_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"queue_position" integer,
	"is_walk_in" boolean DEFAULT false NOT NULL,
	"reason_text" text,
	"notes" text,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"scope" "consent_scope" NOT NULL,
	"status" "consent_status" DEFAULT 'ACTIVE' NOT NULL,
	"policy_version" text NOT NULL,
	"capture_method" text NOT NULL,
	"presented_language" text DEFAULT 'en' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"evidence_object_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"mrn" text NOT NULL,
	"full_name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"mobile_e164" text,
	"mobile_belongs_to_relative" boolean DEFAULT false NOT NULL,
	"alternate_phone_e164" text,
	"email" text,
	"gender" "gender" DEFAULT 'UNKNOWN' NOT NULL,
	"date_of_birth" date,
	"age_years" integer,
	"age_recorded_at" date,
	"blood_group" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"pincode" text,
	"abha_number" text,
	"abha_address" text,
	"clinical_alert" text,
	"emergency_contact_name" text,
	"emergency_contact_phone_e164" text,
	"emergency_contact_relation" text,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deceased_date" date,
	"merged_into_patient_id" uuid,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "patient_merge_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"surviving_patient_id" uuid NOT NULL,
	"merged_patient_id" uuid NOT NULL,
	"reparented_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"merged_record_snapshot" jsonb NOT NULL,
	"performed_by" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient_merge_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "allergy_intolerance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"category" "allergy_category" NOT NULL,
	"criticality" "allergy_criticality" DEFAULT 'UNABLE_TO_ASSESS' NOT NULL,
	"substance_molecule_id" uuid,
	"substance_text" text NOT NULL,
	"substance_code" text,
	"reaction_description" text,
	"reaction_severity" "reaction_severity",
	"onset_date" timestamp with time zone,
	"refuted_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "condition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"clinical_status" "condition_clinical_status" DEFAULT 'ACTIVE' NOT NULL,
	"verification_status" "condition_verification_status" DEFAULT 'CONFIRMED' NOT NULL,
	"code" text,
	"code_system" text,
	"display_text" text NOT NULL,
	"is_chronic" boolean DEFAULT false NOT NULL,
	"onset_date" timestamp with time zone,
	"abatement_date" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "condition" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_reference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"status" "document_status" DEFAULT 'CURRENT' NOT NULL,
	"document_type" "document_type" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_sha256" text NOT NULL,
	"signature_value" text,
	"signed_by" uuid,
	"signed_at" timestamp with time zone,
	"virus_scan_status" text,
	"virus_scanned_at" timestamp with time zone,
	"supersedes_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_reference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "drug_catalogue_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"brand_name" text,
	"molecule_name" text NOT NULL,
	"search_normalized" text NOT NULL,
	"strength" text,
	"dosage_form" text,
	"route" text,
	"manufacturer" text,
	"drug_schedule" text,
	"is_narcotic" boolean DEFAULT false NOT NULL,
	"catalogue_version" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drug_catalogue_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "encounter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"appointment_id" uuid,
	"location_id" uuid,
	"status" "encounter_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"chief_complaint" text,
	"history_of_present_illness" text,
	"examination_notes" text,
	"assessment_notes" text,
	"plan_notes" text,
	"follow_up_after_days" integer,
	"follow_up_instructions" text,
	"is_finalized" boolean DEFAULT false NOT NULL,
	"finalized_at" timestamp with time zone,
	"finalized_by" uuid,
	"amends_encounter_id" uuid,
	"amendment_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "encounter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "encounter_internal_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"note" text NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "encounter_internal_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "encounter_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"specialty" text,
	"practitioner_id" uuid,
	"chief_complaint" text,
	"history_of_present_illness" text,
	"examination_notes" text,
	"assessment_notes" text,
	"plan_notes" text,
	"follow_up_after_days" integer,
	"prompted_observations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "encounter_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "medication_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"status" "medication_request_status" DEFAULT 'DRAFT' NOT NULL,
	"catalogue_item_id" uuid,
	"drug_display_name" text NOT NULL,
	"molecule_name" text,
	"strength" text,
	"dosage_form" text,
	"route" text,
	"frequency" text NOT NULL,
	"timing_relative_to_food" text,
	"duration_days" integer,
	"quantity" numeric(10, 2),
	"instructions" text,
	"reason_condition_id" uuid,
	"safety_warnings_shown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"safety_override_reason" text,
	"catalogue_version_at_prescribing" text,
	"authored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "medication_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "observation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"status" "observation_status" DEFAULT 'FINAL' NOT NULL,
	"code" text NOT NULL,
	"code_system" text DEFAULT 'http://loinc.org' NOT NULL,
	"display" text NOT NULL,
	"value_numeric" numeric(12, 4),
	"value_unit" text,
	"value_text" text,
	"reference_low" numeric(12, 4),
	"reference_high" numeric(12, 4),
	"interpretation" text,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "observation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "prescription_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"indication" text,
	"practitioner_id" uuid,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prescription_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid,
	"conversation_id" uuid,
	"encounter_id" uuid,
	"channel" "communication_channel" NOT NULL,
	"direction" "communication_direction" NOT NULL,
	"status" "communication_status" DEFAULT 'QUEUED' NOT NULL,
	"message_kind" "whatsapp_message_kind",
	"template_name" text,
	"template_language" text,
	"template_variables" jsonb,
	"body" text,
	"document_id" uuid,
	"provider_message_id" text,
	"provider_error_code" text,
	"provider_error_message" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"sent_by_user_id" uuid,
	"idempotency_key" text,
	"cost_paise" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "communication" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "share_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"otp_challenge_e164" text,
	"otp_verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"max_access_count" integer DEFAULT 10 NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by_user_id" uuid NOT NULL,
	"purpose" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"provider" text DEFAULT 'META_WHATSAPP' NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_verified" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "whatsapp_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_phone_e164" text NOT NULL,
	"verified_name" text,
	"access_token_encrypted" text NOT NULL,
	"quality_rating" text,
	"messaging_tier" text,
	"local_storage_region" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "whatsapp_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid,
	"counterparty_e164" text NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"window_expires_at" timestamp with time zone,
	"status" "conversation_status" DEFAULT 'OPEN' NOT NULL,
	"is_unread" boolean DEFAULT false NOT NULL,
	"assigned_to_user_id" uuid,
	"is_unlinked" boolean DEFAULT false NOT NULL,
	"billable_message_count" integer DEFAULT 0 NOT NULL,
	"is_opted_out" boolean DEFAULT false NOT NULL,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_conversation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_name" text,
	"actor_role" text,
	"actor_type" text DEFAULT 'USER' NOT NULL,
	"action" text NOT NULL,
	"outcome" "audit_outcome" DEFAULT 'SUCCESS' NOT NULL,
	"outcome_description" text,
	"resource_type" text,
	"resource_id" uuid,
	"resource_label" text,
	"patient_id" uuid,
	"ip_address" text,
	"user_agent" text,
	"request_id" text,
	"http_method" text,
	"http_path" text,
	"http_status" integer,
	"change_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "export_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"export_type" text NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"result_object_key" text,
	"result_size_bytes" bigint,
	"result_sha256" text,
	"download_expires_at" timestamp with time zone,
	"included_document_count" integer,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "export_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"source_object_key" text NOT NULL,
	"source_filename" text NOT NULL,
	"column_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"error_report_object_key" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"invoice_number" text NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal_paise" bigint DEFAULT 0 NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"discount_reason" text,
	"tax_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"paid_paise" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"issued_at" timestamp with time zone,
	"is_finalized" boolean DEFAULT false NOT NULL,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference_number" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by" uuid NOT NULL,
	"is_refund" boolean DEFAULT false NOT NULL,
	"refund_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"status" "task_status" DEFAULT 'REQUESTED' NOT NULL,
	"priority" "task_priority" DEFAULT 'ROUTINE' NOT NULL,
	"task_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"patient_id" uuid,
	"encounter_id" uuid,
	"focus_resource_type" text,
	"focus_resource_id" uuid,
	"assigned_to_user_id" uuid,
	"assigned_to_role" text,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"resolution_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_location" ADD CONSTRAINT "clinic_location_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_session" ADD CONSTRAINT "refresh_session_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_session" ADD CONSTRAINT "refresh_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_item" ADD CONSTRAINT "service_item_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_item" ADD CONSTRAINT "service_item_practitioner_id_app_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_practitioner_id_app_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_location_id_clinic_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."clinic_location"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_merged_into_patient_id_patient_id_fk" FOREIGN KEY ("merged_into_patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_log" ADD CONSTRAINT "patient_merge_log_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_log" ADD CONSTRAINT "patient_merge_log_surviving_patient_id_patient_id_fk" FOREIGN KEY ("surviving_patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_log" ADD CONSTRAINT "patient_merge_log_merged_patient_id_patient_id_fk" FOREIGN KEY ("merged_patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_signed_by_app_user_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_supersedes_document_id_document_reference_id_fk" FOREIGN KEY ("supersedes_document_id") REFERENCES "public"."document_reference"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drug_catalogue_item" ADD CONSTRAINT "drug_catalogue_item_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_practitioner_id_app_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_location_id_clinic_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."clinic_location"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_amends_encounter_id_encounter_id_fk" FOREIGN KEY ("amends_encounter_id") REFERENCES "public"."encounter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_internal_note" ADD CONSTRAINT "encounter_internal_note_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_internal_note" ADD CONSTRAINT "encounter_internal_note_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_internal_note" ADD CONSTRAINT "encounter_internal_note_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_internal_note" ADD CONSTRAINT "encounter_internal_note_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_template" ADD CONSTRAINT "encounter_template_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_template" ADD CONSTRAINT "encounter_template_practitioner_id_app_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_practitioner_id_app_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_catalogue_item_id_drug_catalogue_item_id_fk" FOREIGN KEY ("catalogue_item_id") REFERENCES "public"."drug_catalogue_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_reason_condition_id_condition_id_fk" FOREIGN KEY ("reason_condition_id") REFERENCES "public"."condition"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_template" ADD CONSTRAINT "prescription_template_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_template" ADD CONSTRAINT "prescription_template_practitioner_id_app_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_conversation_id_whatsapp_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."whatsapp_conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_document_id_document_reference_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document_reference"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_sent_by_user_id_app_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_document_id_document_reference_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document_reference"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_account" ADD CONSTRAINT "whatsapp_account_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_conversation" ADD CONSTRAINT "whatsapp_conversation_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_conversation" ADD CONSTRAINT "whatsapp_conversation_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_conversation" ADD CONSTRAINT "whatsapp_conversation_assigned_to_user_id_app_user_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_received_by_app_user_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assigned_to_user_id_app_user_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_user_clinic_idx" ON "app_user" USING btree ("clinic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_clinic_email_uq" ON "app_user" USING btree ("clinic_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_clinic_regno_uq" ON "app_user" USING btree ("clinic_id","medical_registration_number") WHERE medical_registration_number IS NOT NULL AND is_active = true;--> statement-breakpoint
CREATE INDEX "app_user_clinic_role_idx" ON "app_user" USING btree ("clinic_id","role") WHERE is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_slug_uq" ON "clinic" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "clinic_active_idx" ON "clinic" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "clinic_location_clinic_idx" ON "clinic_location" USING btree ("clinic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_location_primary_uq" ON "clinic_location" USING btree ("clinic_id") WHERE is_primary = true;--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_session_token_hash_uq" ON "refresh_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_session_user_idx" ON "refresh_session" USING btree ("clinic_id","user_id");--> statement-breakpoint
CREATE INDEX "refresh_session_expiry_idx" ON "refresh_session" USING btree ("expires_at") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "service_item_clinic_name_uq" ON "service_item" USING btree ("clinic_id","name");--> statement-breakpoint
CREATE INDEX "service_item_clinic_active_idx" ON "service_item" USING btree ("clinic_id","display_order") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "appointment_clinic_start_idx" ON "appointment" USING btree ("clinic_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "appointment_clinic_patient_idx" ON "appointment" USING btree ("clinic_id","patient_id","scheduled_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "appointment_clinic_practitioner_idx" ON "appointment" USING btree ("clinic_id","practitioner_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "appointment_live_queue_idx" ON "appointment" USING btree ("clinic_id","queue_position","arrived_at") WHERE status IN ('ARRIVED','IN_PROGRESS');--> statement-breakpoint
CREATE INDEX "consent_clinic_patient_idx" ON "consent" USING btree ("clinic_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_active_scope_uq" ON "consent" USING btree ("clinic_id","patient_id","scope") WHERE status = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "patient_clinic_mrn_uq" ON "patient" USING btree ("clinic_id","mrn");--> statement-breakpoint
CREATE INDEX "patient_clinic_mobile_idx" ON "patient" USING btree ("clinic_id","mobile_e164") WHERE mobile_e164 IS NOT NULL;--> statement-breakpoint
CREATE INDEX "patient_clinic_name_trgm_idx" ON "patient" USING gin ("clinic_id" uuid_ops,"name_normalized" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "patient_clinic_created_idx" ON "patient" USING btree ("clinic_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "patient_clinic_active_idx" ON "patient" USING btree ("clinic_id") WHERE is_active = true AND merged_into_patient_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_abha_uq" ON "patient" USING btree ("abha_number") WHERE abha_number IS NOT NULL;--> statement-breakpoint
CREATE INDEX "patient_clinic_tags_idx" ON "patient" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "patient_merge_log_clinic_idx" ON "patient_merge_log" USING btree ("clinic_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "patient_merge_log_surviving_idx" ON "patient_merge_log" USING btree ("clinic_id","surviving_patient_id");--> statement-breakpoint
CREATE INDEX "allergy_clinic_patient_active_idx" ON "allergy_intolerance" USING btree ("clinic_id","patient_id") WHERE refuted_at IS NULL;--> statement-breakpoint
CREATE INDEX "allergy_clinic_molecule_idx" ON "allergy_intolerance" USING btree ("clinic_id","substance_molecule_id") WHERE substance_molecule_id IS NOT NULL AND refuted_at IS NULL;--> statement-breakpoint
CREATE INDEX "condition_clinic_patient_idx" ON "condition" USING btree ("clinic_id","patient_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "condition_clinic_active_idx" ON "condition" USING btree ("clinic_id","patient_id") WHERE clinical_status = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "condition_clinic_encounter_idx" ON "condition" USING btree ("clinic_id","encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_reference_object_key_uq" ON "document_reference" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "document_reference_clinic_patient_idx" ON "document_reference" USING btree ("clinic_id","patient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "document_reference_clinic_encounter_idx" ON "document_reference" USING btree ("clinic_id","encounter_id");--> statement-breakpoint
CREATE INDEX "document_reference_clinic_type_idx" ON "document_reference" USING btree ("clinic_id","document_type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "drug_catalogue_search_trgm_idx" ON "drug_catalogue_item" USING gin ("clinic_id" uuid_ops,"search_normalized" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "drug_catalogue_clinic_molecule_idx" ON "drug_catalogue_item" USING btree ("clinic_id","molecule_name");--> statement-breakpoint
CREATE INDEX "encounter_clinic_patient_started_idx" ON "encounter" USING btree ("clinic_id","patient_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "encounter_clinic_practitioner_idx" ON "encounter" USING btree ("clinic_id","practitioner_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "encounter_clinic_open_idx" ON "encounter" USING btree ("clinic_id","practitioner_id") WHERE is_finalized = false AND status = 'IN_PROGRESS';--> statement-breakpoint
CREATE INDEX "encounter_internal_note_encounter_idx" ON "encounter_internal_note" USING btree ("clinic_id","encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_template_clinic_name_uq" ON "encounter_template" USING btree ("clinic_id","practitioner_id","name");--> statement-breakpoint
CREATE INDEX "encounter_template_clinic_usage_idx" ON "encounter_template" USING btree ("clinic_id","usage_count" DESC NULLS LAST) WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "medication_request_clinic_patient_idx" ON "medication_request" USING btree ("clinic_id","patient_id","authored_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "medication_request_clinic_encounter_idx" ON "medication_request" USING btree ("clinic_id","encounter_id");--> statement-breakpoint
CREATE INDEX "medication_request_clinic_active_idx" ON "medication_request" USING btree ("clinic_id","patient_id") WHERE status = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "observation_clinic_patient_code_idx" ON "observation" USING btree ("clinic_id","patient_id","code","effective_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observation_clinic_encounter_idx" ON "observation" USING btree ("clinic_id","encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_template_clinic_name_uq" ON "prescription_template" USING btree ("clinic_id","practitioner_id","name");--> statement-breakpoint
CREATE INDEX "prescription_template_clinic_usage_idx" ON "prescription_template" USING btree ("clinic_id","usage_count" DESC NULLS LAST) WHERE is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "communication_provider_message_id_uq" ON "communication" USING btree ("provider_message_id") WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "communication_idempotency_uq" ON "communication" USING btree ("clinic_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "communication_clinic_patient_idx" ON "communication" USING btree ("clinic_id","patient_id","queued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "communication_clinic_conversation_idx" ON "communication" USING btree ("clinic_id","conversation_id","queued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "communication_undelivered_idx" ON "communication" USING btree ("clinic_id","sent_at") WHERE status IN ('QUEUED','SENT') AND direction = 'OUTBOUND';--> statement-breakpoint
CREATE UNIQUE INDEX "share_link_token_hash_uq" ON "share_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_link_clinic_document_idx" ON "share_link" USING btree ("clinic_id","document_id");--> statement-breakpoint
CREATE INDEX "share_link_expiry_idx" ON "share_link" USING btree ("expires_at") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_event_provider_event_uq" ON "webhook_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_event_unprocessed_idx" ON "webhook_event" USING btree ("received_at") WHERE processed_at IS NULL;--> statement-breakpoint
CREATE INDEX "webhook_event_clinic_idx" ON "webhook_event" USING btree ("clinic_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_account_phone_number_id_uq" ON "whatsapp_account" USING btree ("phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_account_clinic_uq" ON "whatsapp_account" USING btree ("clinic_id") WHERE is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_conversation_clinic_counterparty_uq" ON "whatsapp_conversation" USING btree ("clinic_id","counterparty_e164");--> statement-breakpoint
CREATE INDEX "whatsapp_conversation_clinic_activity_idx" ON "whatsapp_conversation" USING btree ("clinic_id","last_inbound_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "whatsapp_conversation_unread_idx" ON "whatsapp_conversation" USING btree ("clinic_id") WHERE is_unread = true;--> statement-breakpoint
CREATE INDEX "whatsapp_conversation_unlinked_idx" ON "whatsapp_conversation" USING btree ("clinic_id","last_inbound_at" DESC NULLS LAST) WHERE is_unlinked = true;--> statement-breakpoint
CREATE INDEX "whatsapp_conversation_status_idx" ON "whatsapp_conversation" USING btree ("clinic_id","status") WHERE status <> 'CLOSED';--> statement-breakpoint
CREATE INDEX "audit_event_clinic_occurred_idx" ON "audit_event" USING btree ("clinic_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_clinic_patient_idx" ON "audit_event" USING btree ("clinic_id","patient_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_clinic_actor_idx" ON "audit_event" USING btree ("clinic_id","actor_user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_clinic_resource_idx" ON "audit_event" USING btree ("clinic_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_event_failures_idx" ON "audit_event" USING btree ("clinic_id","occurred_at" DESC NULLS LAST) WHERE outcome <> 'SUCCESS';--> statement-breakpoint
CREATE INDEX "audit_event_request_idx" ON "audit_event" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "export_job_clinic_idx" ON "export_job" USING btree ("clinic_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "export_job_expiry_idx" ON "export_job" USING btree ("download_expires_at") WHERE status = 'COMPLETED';--> statement-breakpoint
CREATE INDEX "import_job_clinic_idx" ON "import_job" USING btree ("clinic_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_clinic_number_uq" ON "invoice" USING btree ("clinic_id","invoice_number");--> statement-breakpoint
CREATE INDEX "invoice_clinic_patient_idx" ON "invoice" USING btree ("clinic_id","patient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invoice_clinic_unpaid_idx" ON "invoice" USING btree ("clinic_id","issued_at") WHERE status = 'ISSUED' AND paid_paise < total_paise;--> statement-breakpoint
CREATE INDEX "payment_clinic_invoice_idx" ON "payment" USING btree ("clinic_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payment_clinic_received_idx" ON "payment" USING btree ("clinic_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_clinic_open_idx" ON "task" USING btree ("clinic_id","priority","due_at") WHERE status IN ('REQUESTED','ACCEPTED','IN_PROGRESS');--> statement-breakpoint
CREATE INDEX "task_clinic_assignee_idx" ON "task" USING btree ("clinic_id","assigned_to_user_id","status");--> statement-breakpoint
CREATE INDEX "task_clinic_patient_idx" ON "task" USING btree ("clinic_id","patient_id");--> statement-breakpoint
CREATE POLICY "app_user_tenant_isolation" ON "app_user" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "clinic_location_tenant_isolation" ON "clinic_location" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "refresh_session_tenant_isolation" ON "refresh_session" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "service_item_tenant_isolation" ON "service_item" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "appointment_tenant_isolation" ON "appointment" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "consent_tenant_isolation" ON "consent" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "patient_tenant_isolation" ON "patient" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "patient_merge_log_tenant_isolation" ON "patient_merge_log" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "allergy_intolerance_tenant_isolation" ON "allergy_intolerance" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "condition_tenant_isolation" ON "condition" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "document_reference_tenant_isolation" ON "document_reference" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "drug_catalogue_item_shared_read" ON "drug_catalogue_item" AS PERMISSIVE FOR SELECT TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id IN (
      nullif(current_setting('app.clinic_id', true), '')::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    ));--> statement-breakpoint
CREATE POLICY "drug_catalogue_item_own_insert" ON "drug_catalogue_item" AS PERMISSIVE FOR INSERT TO "emr_app", "emr_readonly", "emr_worker_messaging" WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "drug_catalogue_item_own_update" ON "drug_catalogue_item" AS PERMISSIVE FOR UPDATE TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "drug_catalogue_item_own_delete" ON "drug_catalogue_item" AS PERMISSIVE FOR DELETE TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "encounter_tenant_isolation" ON "encounter" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "encounter_internal_note_tenant_isolation" ON "encounter_internal_note" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "encounter_template_tenant_isolation" ON "encounter_template" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "medication_request_tenant_isolation" ON "medication_request" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "observation_tenant_isolation" ON "observation" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "prescription_template_tenant_isolation" ON "prescription_template" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_tenant_isolation" ON "communication" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "share_link_tenant_isolation" ON "share_link" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "webhook_event_tenant_isolation" ON "webhook_event" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "whatsapp_account_tenant_isolation" ON "whatsapp_account" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "whatsapp_conversation_tenant_isolation" ON "whatsapp_conversation" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_event_tenant_read" ON "audit_event" AS PERMISSIVE FOR SELECT TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_event_tenant_append" ON "audit_event" AS PERMISSIVE FOR INSERT TO "emr_app", "emr_readonly", "emr_worker_messaging" WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "export_job_tenant_isolation" ON "export_job" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "import_job_tenant_isolation" ON "import_job" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "invoice_tenant_isolation" ON "invoice" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_tenant_isolation" ON "payment" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "task_tenant_isolation" ON "task" AS PERMISSIVE FOR ALL TO "emr_app", "emr_readonly", "emr_worker_messaging" USING (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid) WITH CHECK (clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid);