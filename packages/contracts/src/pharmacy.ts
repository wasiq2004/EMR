/**
 * The pharmacy contract.
 *
 * Two rules run through all of it, and both are enforced here rather than left
 * to the handlers:
 *
 * 1. A FINALISED PRESCRIPTION IS INPUT, NEVER OUTPUT. Nothing in this file
 *    describes a way to change a `medication_request`. What the counter records
 *    is a separate fact — what was handed over — and where it differs from the
 *    order, the difference is either a substitution (recorded, with a reason) or
 *    a clarification (asked, and answered by the prescriber).
 *
 * 2. MONEY IS PAISE AND TAX IS BASIS POINTS. 12% GST is 1200. There is no
 *    decimal anywhere in this file, because a rounding difference on a strip of
 *    tablets becomes a reconciliation argument at the end of the month.
 */

import { z } from 'zod';
import { IsoDate, IsoDateTime, Paise, Uuid } from './common';
import { PaymentMethod } from './enums';

/* ------------------------------------------------------------------------- *
 * Shared vocabulary
 * ------------------------------------------------------------------------- */

export const PurchaseOrderStatus = z.enum([
  'DRAFT',
  'AWAITING_APPROVAL',
  'PLACED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED',
]);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatus>;

export const DispenseStatus = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'CLARIFICATION_NEEDED',
  'READY',
  'PARTIAL',
  'DISPENSED',
  'CANCELLED',
]);
export type DispenseStatus = z.infer<typeof DispenseStatus>;

export const StockMovementType = z.enum([
  'OPENING_BALANCE',
  'RECEIPT',
  'DISPENSE',
  'SALE',
  'SALE_RETURN',
  'PURCHASE_RETURN',
  'ADJUSTMENT',
  'EXPIRY_WRITE_OFF',
  'DAMAGE_WRITE_OFF',
]);
export type StockMovementType = z.infer<typeof StockMovementType>;

export const ClarificationStatus = z.enum(['OPEN', 'ANSWERED', 'WITHDRAWN']);
export type ClarificationStatus = z.infer<typeof ClarificationStatus>;

/**
 * What a prescriber decided, as a code the counter can act on.
 *
 * A code and not only free text, because the pharmacist's next action differs
 * for each one and reading a sentence to decide it is exactly the ambiguity the
 * clarification loop exists to remove.
 */
export const ResolutionAction = z.enum([
  'CONFIRMED_AS_WRITTEN',
  'SUBSTITUTE_APPROVED',
  'DOSE_CLARIFIED',
  'CANCEL_THIS_ITEM',
  'PATIENT_TO_RETURN',
]);
export type ResolutionAction = z.infer<typeof ResolutionAction>;

export const DISPENSE_STATUS_LABEL: Record<DispenseStatus, string> = {
  PENDING: 'Waiting',
  IN_PROGRESS: 'Being prepared',
  CLARIFICATION_NEEDED: 'Waiting on doctor',
  READY: 'Ready to collect',
  PARTIAL: 'Partly dispensed',
  DISPENSED: 'Dispensed',
  CANCELLED: 'Cancelled',
};

export const PURCHASE_ORDER_STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  DRAFT: 'Draft',
  AWAITING_APPROVAL: 'Awaiting approval',
  PLACED: 'Placed',
  PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
};

export const STOCK_MOVEMENT_LABEL: Record<StockMovementType, string> = {
  OPENING_BALANCE: 'Opening balance',
  RECEIPT: 'Received',
  DISPENSE: 'Dispensed',
  SALE: 'Sold',
  SALE_RETURN: 'Sale returned',
  PURCHASE_RETURN: 'Returned to supplier',
  ADJUSTMENT: 'Adjusted',
  EXPIRY_WRITE_OFF: 'Written off — expired',
  DAMAGE_WRITE_OFF: 'Written off — damaged',
};

export const RESOLUTION_ACTION_LABEL: Record<ResolutionAction, string> = {
  CONFIRMED_AS_WRITTEN: 'Dispense as written',
  SUBSTITUTE_APPROVED: 'Substitution approved',
  DOSE_CLARIFIED: 'Dose clarified',
  CANCEL_THIS_ITEM: 'Do not dispense this item',
  PATIENT_TO_RETURN: 'Ask the patient to come back',
};

/** GST slabs India actually uses for medicines and devices. */
export const GST_RATES_BPS = [0, 500, 1200, 1800] as const;

/* ------------------------------------------------------------------------- *
 * Supplier
 * ------------------------------------------------------------------------- */

export const Supplier = z.object({
  id: Uuid,
  name: z.string(),
  gstin: z.string().nullable(),
  drugLicenceNumber: z.string().nullable(),
  contactPerson: z.string().nullable(),
  phoneE164: z.string().nullable(),
  email: z.string().nullable(),
  addressLine1: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  pincode: z.string().nullable(),
  paymentTermsDays: z.number().int().nullable(),
  notes: z.string().nullable(),
  isActive: z.boolean(),
  /** Denormalised for the list screen so it is not one query per row. */
  openOrderCount: z.number().int().optional(),
});
export type Supplier = z.infer<typeof Supplier>;

export const SaveSupplier = z.object({
  name: z.string().trim().min(2, 'Enter the supplier name'),
  /**
   * Fifteen characters when present, and optional.
   *
   * A clinic buying from an unregistered local distributor has no GSTIN to give,
   * and rejecting the supplier over it would mean the purchase is recorded
   * nowhere — which is worse than an incomplete supplier record.
   */
  gstin: z
    .string()
    .trim()
    .regex(/^[0-9A-Z]{15}$/, 'A GSTIN is 15 characters, digits and capitals')
    .nullish(),
  drugLicenceNumber: z.string().trim().nullish(),
  contactPerson: z.string().trim().nullish(),
  phoneE164: z.string().trim().nullish(),
  email: z.string().trim().email('That does not look like an email address').nullish(),
  addressLine1: z.string().trim().nullish(),
  city: z.string().trim().nullish(),
  state: z.string().trim().nullish(),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{5}$/, 'An Indian PIN code is six digits')
    .nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).nullish(),
  notes: z.string().trim().nullish(),
  isActive: z.boolean().default(true),
});
export type SaveSupplier = z.infer<typeof SaveSupplier>;

/* ------------------------------------------------------------------------- *
 * Product
 * ------------------------------------------------------------------------- */

export const PharmacyProduct = z.object({
  id: Uuid,
  catalogueItemId: Uuid.nullable(),
  name: z.string(),
  brandName: z.string().nullable(),
  moleculeName: z.string().nullable(),
  manufacturer: z.string().nullable(),
  strength: z.string().nullable(),
  dosageForm: z.string().nullable(),
  hsnCode: z.string().nullable(),
  gstRateBps: z.number().int(),
  packSize: z.number().int(),
  packUnit: z.string(),
  mrpPaise: Paise.nullable(),
  reorderLevel: z.number().int().nullable(),
  reorderQuantity: z.number().int().nullable(),
  drugSchedule: z.string().nullable(),
  requiresPrescription: z.boolean(),
  isNarcotic: z.boolean(),
  isActive: z.boolean(),
  /** Summed across batches with stock. Present on list and detail reads. */
  quantityOnHand: z.number().int().optional(),
  /** The earliest expiry holding stock, which is what a pharmacist needs to see. */
  earliestExpiry: IsoDate.nullable().optional(),
});
export type PharmacyProduct = z.infer<typeof PharmacyProduct>;

export const SaveProduct = z.object({
  catalogueItemId: Uuid.nullish(),
  name: z.string().trim().min(2, 'Enter the product name as printed on the box'),
  brandName: z.string().trim().nullish(),
  moleculeName: z.string().trim().nullish(),
  manufacturer: z.string().trim().nullish(),
  strength: z.string().trim().nullish(),
  dosageForm: z.string().trim().nullish(),
  hsnCode: z.string().trim().nullish(),
  gstRateBps: z
    .number()
    .int()
    .min(0)
    .max(10_000, 'A tax rate above 100% is not a tax rate')
    .default(1200),
  packSize: z.number().int().positive('A pack holds at least one').default(1),
  packUnit: z.string().trim().min(1).default('unit'),
  mrpPaise: Paise.min(0).nullish(),
  reorderLevel: z.number().int().min(0).nullish(),
  reorderQuantity: z.number().int().positive().nullish(),
  drugSchedule: z.string().trim().nullish(),
  requiresPrescription: z.boolean().default(false),
  isNarcotic: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type SaveProduct = z.infer<typeof SaveProduct>;

/* ------------------------------------------------------------------------- *
 * Stock
 * ------------------------------------------------------------------------- */

export const StockBatch = z.object({
  id: Uuid,
  productId: Uuid,
  productName: z.string(),
  batchNumber: z.string(),
  expiryDate: IsoDate,
  quantityOnHand: z.number().int(),
  unitCostPaise: Paise,
  mrpPaise: Paise.nullable(),
  supplierName: z.string().nullable(),
  receivedAt: IsoDateTime,
  /** Derived server-side against the clinic's own clock, not the browser's. */
  isExpired: z.boolean(),
  daysToExpiry: z.number().int(),
});
export type StockBatch = z.infer<typeof StockBatch>;

export const StockMovementRow = z.object({
  id: Uuid,
  productId: Uuid,
  productName: z.string(),
  stockBatchId: Uuid,
  batchNumber: z.string(),
  movementType: StockMovementType,
  quantityDelta: z.number().int(),
  balanceAfter: z.number().int(),
  reason: z.string().nullable(),
  referenceType: z.string().nullable(),
  referenceId: Uuid.nullable(),
  occurredAt: IsoDateTime,
  actorName: z.string().nullable(),
});
export type StockMovementRow = z.infer<typeof StockMovementRow>;

/**
 * A correction after a physical count.
 *
 * `reason` is required and length-checked, because an adjustment without an
 * explanation is the first thing an auditor asks about and "stock correction" is
 * not an answer.
 */
export const AdjustStock = z.object({
  stockBatchId: Uuid,
  /** Signed. The new balance, not the delta, would hide who counted what. */
  quantityDelta: z
    .number()
    .int()
    .refine((n) => n !== 0, 'An adjustment of zero changes nothing'),
  movementType: z
    .enum(['ADJUSTMENT', 'EXPIRY_WRITE_OFF', 'DAMAGE_WRITE_OFF'])
    .default('ADJUSTMENT'),
  reason: z.string().trim().min(8, 'Say what was counted and when, in a few words'),
});
export type AdjustStock = z.infer<typeof AdjustStock>;

export const OpeningBalance = z.object({
  productId: Uuid,
  batchNumber: z.string().trim().min(1, 'Enter the batch number from the pack'),
  expiryDate: IsoDate,
  quantity: z.number().int().positive('An opening balance is at least one unit'),
  unitCostPaise: Paise.min(0).default(0),
  mrpPaise: Paise.min(0).nullish(),
});
export type OpeningBalance = z.infer<typeof OpeningBalance>;

/* ------------------------------------------------------------------------- *
 * Purchasing
 * ------------------------------------------------------------------------- */

export const PurchaseOrderLine = z.object({
  id: Uuid.optional(),
  productId: Uuid,
  productName: z.string().optional(),
  quantityOrdered: z.number().int().positive('Order at least one'),
  quantityReceived: z.number().int().optional(),
  unitCostPaise: Paise.min(0),
  gstRateBps: z.number().int().min(0).max(10_000),
  lineTotalPaise: Paise.optional(),
});
export type PurchaseOrderLine = z.infer<typeof PurchaseOrderLine>;

export const PurchaseOrder = z.object({
  id: Uuid,
  supplierId: Uuid,
  supplierName: z.string(),
  orderNumber: z.string(),
  status: PurchaseOrderStatus,
  expectedAt: IsoDate.nullable(),
  placedAt: IsoDateTime.nullable(),
  placedByName: z.string().nullable(),
  approvedAt: IsoDateTime.nullable(),
  approvedByName: z.string().nullable(),
  subtotalPaise: Paise,
  taxPaise: Paise,
  totalPaise: Paise,
  notes: z.string().nullable(),
  cancelledReason: z.string().nullable(),
  lines: z.array(PurchaseOrderLine),
  createdAt: IsoDateTime,
});
export type PurchaseOrder = z.infer<typeof PurchaseOrder>;

export const SavePurchaseOrder = z.object({
  supplierId: Uuid,
  expectedAt: IsoDate.nullish(),
  notes: z.string().trim().nullish(),
  lines: z
    .array(
      PurchaseOrderLine.pick({
        productId: true,
        quantityOrdered: true,
        unitCostPaise: true,
        gstRateBps: true,
      }),
    )
    .min(1, 'An order needs at least one line'),
});
export type SavePurchaseOrder = z.infer<typeof SavePurchaseOrder>;

export const ReceiveGoodsLine = z.object({
  productId: Uuid,
  /**
   * Required, with no fallback.
   *
   * A batch number is the only thing that connects stock on the shelf to a
   * recall notice, and "UNKNOWN" as a default would make every recall a
   * full-shelf disposal.
   */
  batchNumber: z.string().trim().min(1, 'Enter the batch number from the pack'),
  expiryDate: IsoDate,
  quantity: z.number().int().positive('Receive at least one'),
  unitCostPaise: Paise.min(0),
  mrpPaise: Paise.min(0).nullish(),
  gstRateBps: z.number().int().min(0).max(10_000),
});
export type ReceiveGoodsLine = z.infer<typeof ReceiveGoodsLine>;

export const ReceiveGoods = z.object({
  /** Null for a direct purchase with no order raised first. */
  purchaseOrderId: Uuid.nullish(),
  supplierId: Uuid,
  supplierInvoiceNumber: z.string().trim().nullish(),
  supplierInvoiceDate: IsoDate.nullish(),
  notes: z.string().trim().nullish(),
  lines: z.array(ReceiveGoodsLine).min(1, 'Record at least one line'),
});
export type ReceiveGoods = z.infer<typeof ReceiveGoods>;

export const GoodsReceiptRow = z.object({
  id: Uuid,
  receiptNumber: z.string(),
  purchaseOrderId: Uuid.nullable(),
  purchaseOrderNumber: z.string().nullable(),
  supplierName: z.string(),
  supplierInvoiceNumber: z.string().nullable(),
  receivedAt: IsoDateTime,
  receivedByName: z.string().nullable(),
  totalPaise: Paise,
  lineCount: z.number().int(),
});
export type GoodsReceiptRow = z.infer<typeof GoodsReceiptRow>;

/* ------------------------------------------------------------------------- *
 * Dispensing
 * ------------------------------------------------------------------------- */

/**
 * One line of the queue.
 *
 * Carries the patient's NAME, AGE and ALLERGIES and nothing else clinical. That
 * list is not a compromise — it is precisely what is needed to hand the right
 * medicine to the right person, and the consultation note, the diagnosis and the
 * history are all absent because none of them are.
 */
export const DispenseQueueRow = z.object({
  id: Uuid,
  patientId: Uuid,
  patientName: z.string(),
  patientMrn: z.string(),
  patientAgeYears: z.number().int().nullable(),
  /** Shown as a warning strip at the counter, per the allergy-banner pattern. */
  allergySummary: z.array(z.string()),
  encounterId: Uuid,
  prescriberName: z.string(),
  status: DispenseStatus,
  queuedAt: IsoDateTime,
  /** Minutes since the prescription reached the counter. The queue sorts on it. */
  waitingMinutes: z.number().int(),
  itemCount: z.number().int(),
  dispensedItemCount: z.number().int(),
  openClarificationCount: z.number().int(),
});
export type DispenseQueueRow = z.infer<typeof DispenseQueueRow>;

export const DispenseLineDetail = z.object({
  id: Uuid,
  medicationRequestId: Uuid,
  /* What the doctor ordered. Read-only, always. */
  orderedDrugName: z.string(),
  orderedMolecule: z.string().nullable(),
  orderedStrength: z.string().nullable(),
  orderedDosageForm: z.string().nullable(),
  orderedRoute: z.string().nullable(),
  frequency: z.string(),
  durationDays: z.number().int().nullable(),
  instructions: z.string().nullable(),
  timingRelativeToFood: z.string().nullable(),

  /* What the counter did about it. */
  productId: Uuid.nullable(),
  productName: z.string().nullable(),
  stockBatchId: Uuid.nullable(),
  batchNumber: z.string().nullable(),
  expiryDate: IsoDate.nullable(),
  quantityPrescribed: z.number().nullable(),
  quantityDispensed: z.number().int(),
  isSubstitution: z.boolean(),
  substitutionReason: z.string().nullable(),
  unitPricePaise: Paise,
  gstRateBps: z.number().int(),
  lineTotalPaise: Paise,
  notDispensedReason: z.string().nullable(),

  /** Open questions on this specific item. */
  clarifications: z.array(
    z.object({
      id: Uuid,
      status: ClarificationStatus,
      question: z.string(),
      raisedByName: z.string().nullable(),
      raisedAt: IsoDateTime,
      answer: z.string().nullable(),
      answeredByName: z.string().nullable(),
      answeredAt: IsoDateTime.nullable(),
      resolutionAction: ResolutionAction.nullable(),
    }),
  ),

  /** Batches that could fill this line, nearest expiry first. */
  availableBatches: z
    .array(
      z.object({
        stockBatchId: Uuid,
        productId: Uuid,
        productName: z.string(),
        batchNumber: z.string(),
        expiryDate: IsoDate,
        quantityOnHand: z.number().int(),
        mrpPaise: Paise.nullable(),
        /** True when the product's molecule differs from the one prescribed. */
        isSubstitution: z.boolean(),
      }),
    )
    .optional(),
});
export type DispenseLineDetail = z.infer<typeof DispenseLineDetail>;

export const DispenseDetail = DispenseQueueRow.extend({
  notes: z.string().nullable(),
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  dispensedByName: z.string().nullable(),
  cancelledReason: z.string().nullable(),
  lines: z.array(DispenseLineDetail),
  /** The priced total, if a sale has been rung up against this dispense. */
  saleId: Uuid.nullable(),
  saleTotalPaise: Paise.nullable(),
});
export type DispenseDetail = z.infer<typeof DispenseDetail>;

/**
 * Recording what was handed over, one line at a time.
 *
 * Per line rather than per prescription, because that is how a counter works:
 * three items go out, the fourth is out of stock, and the pharmacist should not
 * have to re-enter the three to say so.
 */
export const FillLine = z.object({
  stockBatchId: Uuid.nullish(),
  quantityDispensed: z.number().int().min(0),
  /**
   * Set when the chosen product's molecule differs from the prescribed one.
   *
   * The server checks this rather than trusting it: a claim of "not a
   * substitution" on a different molecule is rejected, and a genuine
   * substitution with no reason is rejected too.
   */
  isSubstitution: z.boolean().default(false),
  substitutionReason: z.string().trim().nullish(),
  unitPricePaise: Paise.min(0).nullish(),
  notDispensedReason: z.string().trim().nullish(),
});
export type FillLine = z.infer<typeof FillLine>;

export const RaiseClarification = z.object({
  medicationRequestId: Uuid,
  question: z
    .string()
    .trim()
    .min(10, 'Ask the question the way you would on the phone'),
});
export type RaiseClarification = z.infer<typeof RaiseClarification>;

export const AnswerClarification = z.object({
  answer: z.string().trim().min(3, 'A one-word answer will not be clear later'),
  resolutionAction: ResolutionAction,
});
export type AnswerClarification = z.infer<typeof AnswerClarification>;

export const ClarificationRow = z.object({
  id: Uuid,
  status: ClarificationStatus,
  question: z.string(),
  answer: z.string().nullable(),
  resolutionAction: ResolutionAction.nullable(),
  raisedByName: z.string().nullable(),
  raisedAt: IsoDateTime,
  answeredByName: z.string().nullable(),
  answeredAt: IsoDateTime.nullable(),
  /* Enough context to answer it without opening the record. */
  medicationRequestId: Uuid,
  drugDisplayName: z.string(),
  strength: z.string().nullable(),
  frequency: z.string(),
  patientId: Uuid,
  patientName: z.string(),
  patientAgeYears: z.number().int().nullable(),
  prescriberName: z.string(),
  dispenseRecordId: Uuid.nullable(),
  waitingMinutes: z.number().int(),
});
export type ClarificationRow = z.infer<typeof ClarificationRow>;

/* ------------------------------------------------------------------------- *
 * Counter sales
 * ------------------------------------------------------------------------- */

export const SaleLine = z.object({
  productId: Uuid,
  productName: z.string().optional(),
  stockBatchId: Uuid,
  batchNumber: z.string().optional(),
  quantity: z.number().int().positive('Sell at least one'),
  unitPricePaise: Paise.min(0),
  gstRateBps: z.number().int().min(0).max(10_000),
  discountPaise: Paise.min(0).default(0),
  lineTotalPaise: Paise.optional(),
});
export type SaleLine = z.infer<typeof SaleLine>;

export const RecordSale = z.object({
  /** One of the two, or neither for a true walk-in. */
  patientId: Uuid.nullish(),
  buyerName: z.string().trim().nullish(),
  dispenseRecordId: Uuid.nullish(),
  lines: z.array(SaleLine).min(1, 'A sale needs at least one line'),
  discountPaise: Paise.min(0).default(0),
  discountReason: z.string().trim().nullish(),
  paymentMethod: PaymentMethod,
  paidPaise: Paise.min(0),
});
export type RecordSale = z.infer<typeof RecordSale>;

export const SaleRow = z.object({
  id: Uuid,
  saleNumber: z.string(),
  status: z.enum(['DRAFT', 'COMPLETED', 'CANCELLED']),
  patientId: Uuid.nullable(),
  patientName: z.string().nullable(),
  buyerName: z.string().nullable(),
  dispenseRecordId: Uuid.nullable(),
  subtotalPaise: Paise,
  discountPaise: Paise,
  taxPaise: Paise,
  totalPaise: Paise,
  paidPaise: Paise,
  paymentMethod: PaymentMethod.nullable(),
  soldAt: IsoDateTime.nullable(),
  soldByName: z.string().nullable(),
  isReturn: z.boolean(),
  returnOfSaleId: Uuid.nullable(),
  returnReason: z.string().nullable(),
  lineCount: z.number().int(),
});
export type SaleRow = z.infer<typeof SaleRow>;

export const ReturnSale = z.object({
  returnReason: z.string().trim().min(5, 'Say why it came back'),
  lines: z
    .array(
      z.object({
        productId: Uuid,
        stockBatchId: Uuid,
        quantity: z.number().int().positive('Return at least one'),
        unitPricePaise: Paise.min(0),
        gstRateBps: z.number().int().min(0).max(10_000),
      }),
    )
    .min(1, 'Choose what is being returned'),
});
export type ReturnSale = z.infer<typeof ReturnSale>;

/* ------------------------------------------------------------------------- *
 * Alerts and reporting
 * ------------------------------------------------------------------------- */

/**
 * The alert board.
 *
 * Every figure here is a count of things a pharmacist must do something about.
 * Deliberately not a set of charts: §10.1 of the blueprint is a work list, and a
 * pharmacist opening the software at 9am needs to know what is broken before
 * they need a trend.
 */
export const PharmacyAlerts = z.object({
  outOfStock: z.array(
    z.object({
      productId: Uuid,
      productName: z.string(),
      reorderLevel: z.number().int().nullable(),
      reorderQuantity: z.number().int().nullable(),
      /** Times dispensed or sold in the last 30 days — is this urgent? */
      recentMovement: z.number().int(),
    }),
  ),
  lowStock: z.array(
    z.object({
      productId: Uuid,
      productName: z.string(),
      quantityOnHand: z.number().int(),
      reorderLevel: z.number().int(),
      reorderQuantity: z.number().int().nullable(),
    }),
  ),
  expiringSoon: z.array(
    z.object({
      stockBatchId: Uuid,
      productId: Uuid,
      productName: z.string(),
      batchNumber: z.string(),
      expiryDate: IsoDate,
      daysToExpiry: z.number().int(),
      quantityOnHand: z.number().int(),
      valueAtCostPaise: Paise,
    }),
  ),
  expired: z.array(
    z.object({
      stockBatchId: Uuid,
      productId: Uuid,
      productName: z.string(),
      batchNumber: z.string(),
      expiryDate: IsoDate,
      quantityOnHand: z.number().int(),
      valueAtCostPaise: Paise,
    }),
  ),
  openClarifications: z.number().int(),
  waitingPrescriptions: z.number().int(),
  /** Oldest thing in the queue, in minutes. The one number that means "hurry". */
  oldestWaitingMinutes: z.number().int().nullable(),
});
export type PharmacyAlerts = z.infer<typeof PharmacyAlerts>;

export const PharmacyReport = z.object({
  rangeFrom: IsoDateTime,
  rangeTo: IsoDateTime,

  prescriptionsDispensed: z.number().int(),
  itemsDispensed: z.number().int(),
  /** §10.2's headline metric: how long a patient waits at the counter. */
  medianTurnaroundMinutes: z.number().int().nullable(),
  clarificationsRaised: z.number().int(),
  clarificationsAnswered: z.number().int(),
  substitutionCount: z.number().int(),

  salesTotalPaise: Paise,
  salesCount: z.number().int(),
  returnsTotalPaise: Paise,

  purchasesTotalPaise: Paise,
  receiptCount: z.number().int(),

  expiryLossPaise: Paise,
  damageLossPaise: Paise,

  topProducts: z.array(
    z.object({
      productId: Uuid,
      productName: z.string(),
      quantity: z.number().int(),
      valuePaise: Paise,
    }),
  ),
  /** Nothing has moved in the period, and stock is sitting on it. */
  nonMoving: z.array(
    z.object({
      productId: Uuid,
      productName: z.string(),
      quantityOnHand: z.number().int(),
      valueAtCostPaise: Paise,
      lastMovedAt: IsoDateTime.nullable(),
    }),
  ),
  dailyDispensing: z.array(
    z.object({ date: IsoDate, prescriptions: z.number().int(), items: z.number().int() }),
  ),
});
export type PharmacyReport = z.infer<typeof PharmacyReport>;

/* ------------------------------------------------------------------------- *
 * Pricing, shared by the server and the counter screen
 * ------------------------------------------------------------------------- */

/**
 * Line and document totals, in one place so the screen and the server agree.
 *
 * Tax is computed per line and then summed, not applied to the subtotal, because
 * a basket mixing a 5% device with a 12% medicine has no single rate. Rounding is
 * per line for the same reason — it is what a GST invoice has to show.
 *
 * A discount reduces the taxable value, so it is applied BEFORE tax. Doing it
 * after would overstate the tax collected, which is the kind of error that is
 * only discovered by someone official.
 */
export function computeSaleTotals(
  lines: { quantity: number; unitPricePaise: number; gstRateBps: number; discountPaise?: number }[],
  documentDiscountPaise = 0,
): { subtotalPaise: number; taxPaise: number; totalPaise: number } {
  let subtotal = 0;
  let tax = 0;

  for (const line of lines) {
    const gross = line.quantity * line.unitPricePaise;
    const net = gross - (line.discountPaise ?? 0);
    subtotal += net;
    tax += Math.round((net * line.gstRateBps) / 10_000);
  }

  /*
   * A document-level discount is spread across the tax base proportionally.
   * Applying it to the total instead would leave the tax computed on a value
   * nobody was charged.
   */
  if (documentDiscountPaise > 0 && subtotal > 0) {
    const factor = Math.max(0, (subtotal - documentDiscountPaise) / subtotal);
    tax = Math.round(tax * factor);
    subtotal = subtotal - documentDiscountPaise;
  }

  return { subtotalPaise: subtotal, taxPaise: tax, totalPaise: subtotal + tax };
}

/**
 * How many units a prescription actually needs.
 *
 * Returns null rather than guessing when the frequency is not a pattern it
 * recognises. A wrong quantity on a controlled medicine is worse than a blank
 * one a pharmacist has to fill in, so this only answers where it is sure.
 *
 * Handles the Indian convention directly: "1-0-1" is morning-noon-night, which
 * is two a day, and it is by far the most common way a frequency is written in
 * the clinics this product is for.
 */
export function suggestedQuantity(
  frequency: string,
  durationDays: number | null,
): number | null {
  if (!durationDays || durationDays <= 0) return null;

  const pattern = frequency.trim();

  /* "1-0-1", "1-1-1", "0-0-1", and the four-slot variant with a bedtime dose. */
  const slots = pattern.match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?)){2,3}$/);
  if (slots) {
    const perDay = pattern
      .split('-')
      .map((part) => Number(part.trim()))
      .reduce((sum, n) => sum + n, 0);
    if (perDay > 0) return Math.ceil(perDay * durationDays);
  }

  /* "OD", "BD", "TDS", "QID" — still written on paper and still typed in. */
  const perDay = { OD: 1, BD: 2, BID: 2, TDS: 3, TID: 3, QID: 4, QDS: 4, HS: 1 }[
    pattern.toUpperCase()
  ];
  if (perDay) return Math.ceil(perDay * durationDays);

  return null;
}
