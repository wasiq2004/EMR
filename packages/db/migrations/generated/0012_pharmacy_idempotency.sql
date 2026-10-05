ALTER TABLE "goods_receipt" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_idempotency_uq" ON "goods_receipt" USING btree ("clinic_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_sale_idempotency_uq" ON "pharmacy_sale" USING btree ("clinic_id","idempotency_key") WHERE idempotency_key IS NOT NULL;