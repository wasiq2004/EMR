ALTER TABLE "appointment" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_idempotency_uq" ON "appointment" USING btree ("clinic_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_idempotency_uq" ON "patient" USING btree ("clinic_id","idempotency_key") WHERE idempotency_key IS NOT NULL;