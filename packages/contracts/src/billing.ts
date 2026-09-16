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
  /** A retried request must not take the payment twice. */
  idempotencyKey: z.string(),
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
