ALTER TYPE "public"."appointment_status" ADD VALUE 'CHECKED_OUT' BEFORE 'CANCELLED';--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "checked_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "checked_out_by" uuid;