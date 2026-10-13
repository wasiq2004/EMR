ALTER TABLE "appointment" ADD COLUMN "is_emergency" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "attendant_name" text;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "attendant_phone_e164" text;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "registration_bypass_reason" text;--> statement-breakpoint
CREATE INDEX "appointment_queue_order_idx" ON "appointment" USING btree ("clinic_id","is_emergency" DESC NULLS LAST,"queue_position","arrived_at");