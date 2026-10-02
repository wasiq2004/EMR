/**
 * Billing-Lite: service catalogue, invoices, payments.
 *
 * Explicitly NOT an accounting system — no ledger, no GST filing, no TDS. That
 * boundary belongs in the contract as well as the code, because this is where
 * scope expands silently.
 *
 * Every amount is an integer count of paise.
 */

import { z } from 'zod';
import { AuditFields, IsoDateTime, Paise, Uuid } from './common';
import { InvoiceStatus, PaymentMethod } from './enums';

export const ServiceItem = z.object({
  id: Uuid,
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  defaultFeePaise: Paise,
  hsnSacCode: z.string().nullable(),
  /** Basis points: 1800 = 18%. Integer, so no float rounding. */
  taxRateBps: z.number().int(),
  /** Lets a new consultation book a longer slot than a follow-up. */
  defaultDurationMinutes: z.number().int().nullable(),
  practitionerId: Uuid.nullable(),
  isActive: z.boolean(),
  displayOrder: z.number().int(),
});
export type ServiceItem = z.infer<typeof ServiceItem>;

/**
 * Saving a service.
 *
 * `defaultFeePaise` and `taxRateBps` are integers for the same reason they are
 * everywhere else in this contract: a rounding difference on a consultation fee
 * becomes a reconciliation argument at the end of the month.
 */
export const SaveServiceItem = z.object({
  id: Uuid.optional(),
  name: z.string().trim().min(2, 'Name the service as it should appear on an invoice'),
  code: z.string().trim().nullish(),
  description: z.string().trim().nullish(),
  defaultFeePaise: Paise.min(0),
  hsnSacCode: z.string().trim().nullish(),
  /** Basis points. 18% is 1800. */
  taxRateBps: z.number().int().min(0).max(10_000).default(0),
  /**
   * Lets a new consultation book a longer slot than a follow-up. Null means the
   * clinic's default applies.
   */
  defaultDurationMinutes: z.number().int().positive().max(480).nullish(),
  /** Set when only one doctor offers this. Null means anybody can. */
  practitionerId: Uuid.nullish(),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().min(0).default(0),
});
export type SaveServiceItem = z.infer<typeof SaveServiceItem>;

export const InvoiceLine = z.object({
  serviceItemId: Uuid.nullable().default(null),
  description: z.string().trim().min(1, 'Describe the charge'),
  quantity: z.number().int().positive().default(1),
  unitPricePaise: Paise,
  amountPaise: Paise,
  hsnSac: z.string().nullable().default(null),
});
export type InvoiceLine = z.infer<typeof InvoiceLine>;

export const Payment = z.object({
  id: Uuid,
  invoiceId: Uuid,
  patientId: Uuid,
  amountPaise: Paise,
  method: PaymentMethod,
  /** UPI reference, cheque number, card auth code. */
  referenceNumber: z.string().nullable(),
  receivedAt: IsoDateTime,
  receivedByName: z.string(),
  /** Refunds are negative rows, never deletions of the original payment. */
  isRefund: z.boolean(),
  refundReason: z.string().nullable(),
});
export type Payment = z.infer<typeof Payment>;

export const Invoice = z.object({
  id: Uuid,
  patientId: Uuid,
  patientName: z.string(),
  encounterId: Uuid.nullable(),
  /** Sequential per clinic per financial year, e.g. "INV-2026-0142". */
  invoiceNumber: z.string(),
  status: InvoiceStatus,
  lineItems: z.array(InvoiceLine),
  subtotalPaise: Paise,
  discountPaise: Paise,
  discountReason: z.string().nullable(),
  taxPaise: Paise,
  totalPaise: Paise,
  paidPaise: Paise,
  currency: z.string(),
  issuedAt: IsoDateTime.nullable(),
  /** Issued invoices are immutable; corrections are credit notes. */
  isFinalized: z.boolean(),
  cancelledReason: z.string().nullable(),
  payments: z.array(Payment).default([]),
}).extend(AuditFields.shape);
export type Invoice = z.infer<typeof Invoice>;

export const DraftInvoice = z.object({
  patientId: Uuid,
  encounterId: Uuid.nullable().default(null),
  lineItems: z.array(InvoiceLine).min(1, 'Add at least one charge'),
  discountPaise: Paise.default(0),
  discountReason: z.string().nullable().default(null),
});
export type DraftInvoice = z.infer<typeof DraftInvoice>;

export const RecordPayment = z.object({
  invoiceId: Uuid,
  amountPaise: Paise.refine((v) => v !== 0, 'Enter an amount'),
  method: PaymentMethod,
  referenceNumber: z.string().nullable().default(null),
  isRefund: z.boolean().default(false),
  refundReason: z.string().nullable().default(null),
  /**
   * A retried request must not take the payment twice.
   *
   * Required, and non-empty: an empty string is not null, so the database's
   * unique index would treat it as a real key and the FIRST empty-keyed payment
   * in a clinic would block every one after it.
   */
  idempotencyKey: z.string().min(8, 'A payment needs a unique key'),
});
export type RecordPayment = z.infer<typeof RecordPayment>;

/** Discounts are applied before tax, which is how a clinic expects to read it. */
export function computeInvoiceTotals(
  lines: InvoiceLine[],
  discountPaise: number,
  taxRateBps = 0,
): { subtotalPaise: number; taxPaise: number; totalPaise: number } {
  const subtotalPaise = lines.reduce((sum, l) => sum + l.amountPaise, 0);
  const taxable = Math.max(0, subtotalPaise - discountPaise);
  const taxPaise = Math.round((taxable * taxRateBps) / 10_000);
  return { subtotalPaise, taxPaise, totalPaise: taxable + taxPaise };
}
