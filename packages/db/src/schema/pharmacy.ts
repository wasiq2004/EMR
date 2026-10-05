/**
 * The pharmacy.
 *
 * Thirteen tables, and the shape of them is the whole design, so it is worth
 * saying what they are before the code says it less clearly.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. A finalised prescription is read-only.
 * The pharmacy consumes `medication_request` rows and never writes them. What a
 * pharmacist records is a SEPARATE FACT — what was actually handed over, from
 * which batch, by whom — which may legitimately differ from what was ordered
 * (substitution, partial fill, refusal) and must never be achieved by editing
 * the order. `dispense_line` therefore carries both `quantityPrescribed` and
 * `quantityDispensed`, and the difference between them is the clinically
 * interesting number.
 *
 * WHERE THE TWO DISAGREE, THE MECHANISM IS A RECORD, NOT A PHONE CALL.
 * `rx_clarification` is a question raised at the counter and answered by the
 * prescriber. It is the blueprint's auditable alternative to the WhatsApp
 * message that currently resolves these everywhere else.
 *
 * ONE LEDGER FOR STOCK. `stock_movement` records every reason a quantity
 * changed — receipt, dispense, sale, either kind of return, a correction after a
 * physical count, expiry and damage — as a signed delta against a batch with a
 * reference to its cause. `stock_batch.quantity_on_hand` is a cached balance;
 * the ledger is the truth, and the two are reconcilable by summing. The
 * alternative of a table per reason gives five places for the count to go wrong.
 *
 * MONEY IS ALWAYS AN INTEGER COUNT OF PAISE, as everywhere else in this
 * schema, and tax rates are basis points for the same reason — 12% GST is 1200,
 * never 0.12.
 *
 * A NOTE ON PRODUCTS VS THE DRUG CATALOGUE. `drug_catalogue_item` is what a
 * doctor prescribes from: a molecule, a strength, a form. `pharmacy_product` is
 * what a pharmacy sells: a pack of a particular brand, with an MRP, a GST rate
 * and an HSN code. They are not the same thing — one prescription for
 * "Amoxicillin 500mg" can be filled from any of four products — so the link is a
 * nullable reference rather than an identity. It is nullable in the other
 * direction too: gauze, syringes and a glucometer are products with no
 * catalogue entry at all.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  auditColumns,
  clarificationStatusEnum,
  clinicIdColumn,
  dispenseStatusEnum,
  paymentMethodEnum,
  pharmacySaleStatusEnum,
  primaryKeyColumn,
  purchaseOrderStatusEnum,
  stockMovementTypeEnum,
  tenantPolicy,
} from './shared';
import { appUser, clinic } from './tenancy';
import { patient } from './patient';
import { drugCatalogueItem, encounter, medicationRequest } from './clinical';

/* ------------------------------------------------------------------------- *
 * Supplier
 * ------------------------------------------------------------------------- */

export const supplier = pgTable(
  'supplier',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    name: text('name').notNull(),
    /**
     * GST identification number.
     *
     * Not validated beyond length: a clinic buying from an unregistered local
     * distributor has no GSTIN to give, and refusing the supplier over it would
     * mean the purchase is recorded nowhere.
     */
    gstin: text('gstin'),
    drugLicenceNumber: text('drug_licence_number'),

    contactPerson: text('contact_person'),
    phoneE164: text('phone_e164'),
    email: text('email'),

    addressLine1: text('address_line1'),
    city: text('city'),
    state: text('state'),
    pincode: text('pincode'),

    /** Net payment days. Drives nothing automatically; shown on the order. */
    paymentTermsDays: integer('payment_terms_days'),

    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    uniqueIndex('supplier_clinic_name_uq').on(t.clinicId, t.name),
    index('supplier_clinic_active_idx').on(t.clinicId, t.isActive),
    tenantPolicy('supplier'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Product — what the pharmacy sells
 * ------------------------------------------------------------------------- */

export const pharmacyProduct = pgTable(
  'pharmacy_product',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    /**
     * The molecule this product dispenses, when it dispenses one.
     *
     * Nullable in both senses described at the top of this file. When it IS set,
     * it is what lets a prescription for a molecule offer the brands actually on
     * the shelf — the blueprint's "no unverified AI-created drug catalogue"
     * requirement, met by mapping to the reviewed catalogue instead of inventing
     * entries at the counter.
     */
    catalogueItemId: uuid('catalogue_item_id'),

    /** What is printed on the box, which is what the pharmacist searches for. */
    name: text('name').notNull(),
    searchNormalized: text('search_normalized').notNull(),

    brandName: text('brand_name'),
    moleculeName: text('molecule_name'),
    manufacturer: text('manufacturer'),
    strength: text('strength'),
    dosageForm: text('dosage_form'),

    /** Harmonised System code, needed on a GST invoice. */
    hsnCode: text('hsn_code'),
    /** Basis points. 12% is 1200. Never a float. */
    gstRateBps: integer('gst_rate_bps').notNull().default(0),

    /**
     * How the product is counted.
     *
     * `packSize` with `packUnit` because "1 strip of 15" and "15 tablets" are
     * the same stock and different words, and a pharmacist reconciling a
     * physical count needs the one printed on the shelf.
     */
    packSize: integer('pack_size').notNull().default(1),
    packUnit: text('pack_unit').notNull().default('unit'),

    /** Maximum retail price, per pack. The ceiling a sale may charge. */
    mrpPaise: integer('mrp_paise'),

    /**
     * Reorder thresholds, held on the product rather than in a rules table.
     *
     * A separate `reorder_rule` table would be one row per product forever, and
     * the rule has never been more complicated than a level and a quantity.
     */
    reorderLevel: integer('reorder_level'),
    reorderQuantity: integer('reorder_quantity'),

    /**
     * Schedule H / H1 / X under the Drugs and Cosmetics Rules.
     *
     * Copied onto the product rather than read through the catalogue link,
     * because a product with no catalogue entry can still be scheduled and the
     * counter must not be able to sell it without a prescription on a
     * technicality.
     */
    drugSchedule: text('drug_schedule'),
    requiresPrescription: boolean('requires_prescription').notNull().default(false),
    isNarcotic: boolean('is_narcotic').notNull().default(false),

    isActive: boolean('is_active').notNull().default(true),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({
      columns: [t.catalogueItemId],
      foreignColumns: [drugCatalogueItem.id],
    }).onDelete('set null'),

    index('pharmacy_product_clinic_search_idx').on(t.clinicId, t.searchNormalized),
    index('pharmacy_product_clinic_catalogue_idx').on(t.clinicId, t.catalogueItemId),
    index('pharmacy_product_clinic_active_idx').on(t.clinicId, t.isActive),
    check('pharmacy_product_gst_rate_sane', sql`gst_rate_bps BETWEEN 0 AND 10000`),
    check('pharmacy_product_pack_size_positive', sql`pack_size > 0`),
    tenantPolicy('pharmacy_product'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Purchasing
 * ------------------------------------------------------------------------- */

export const purchaseOrder = pgTable(
  'purchase_order',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    supplierId: uuid('supplier_id').notNull(),

    /** Sequential per clinic per year, e.g. PO-2026-0031. */
    orderNumber: text('order_number').notNull(),
    status: purchaseOrderStatusEnum('status').notNull().default('DRAFT'),

    expectedAt: date('expected_at'),

    placedAt: timestamp('placed_at', { withTimezone: true }),
    placedBy: uuid('placed_by'),

    /**
     * Approval, separate from placing.
     *
     * Null on a placed order means the clinic does not use the approval step —
     * it granted `purchaseOrder:approve` to whoever raises orders. That is a
     * legitimate configuration for a two-person clinic and the column records
     * which way it was done rather than pretending an approval happened.
     */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by'),

    subtotalPaise: integer('subtotal_paise').notNull().default(0),
    taxPaise: integer('tax_paise').notNull().default(0),
    totalPaise: integer('total_paise').notNull().default(0),

    notes: text('notes'),
    cancelledReason: text('cancelled_reason'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.supplierId], foreignColumns: [supplier.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.placedBy], foreignColumns: [appUser.id] }).onDelete('set null'),
    foreignKey({ columns: [t.approvedBy], foreignColumns: [appUser.id] }).onDelete('set null'),

    uniqueIndex('purchase_order_clinic_number_uq').on(t.clinicId, t.orderNumber),
    index('purchase_order_clinic_status_idx').on(t.clinicId, t.status),
    index('purchase_order_clinic_supplier_idx').on(t.clinicId, t.supplierId),
    tenantPolicy('purchase_order'),
  ],
).enableRLS();

export const purchaseOrderLine = pgTable(
  'purchase_order_line',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    productId: uuid('product_id').notNull(),

    quantityOrdered: integer('quantity_ordered').notNull(),
    /**
     * Running total across receipts, maintained as goods arrive.
     *
     * Denormalised deliberately: "what is still outstanding on this order" is
     * the question the purchasing screen is for, and deriving it by joining
     * every receipt line on every render is the wrong trade.
     */
    quantityReceived: integer('quantity_received').notNull().default(0),

    unitCostPaise: integer('unit_cost_paise').notNull(),
    gstRateBps: integer('gst_rate_bps').notNull().default(0),
    lineTotalPaise: integer('line_total_paise').notNull(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({
      columns: [t.purchaseOrderId],
      foreignColumns: [purchaseOrder.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.productId], foreignColumns: [pharmacyProduct.id] }).onDelete(
      'restrict',
    ),

    index('purchase_order_line_order_idx').on(t.clinicId, t.purchaseOrderId),
    check('purchase_order_line_qty_positive', sql`quantity_ordered > 0`),
    check(
      'purchase_order_line_received_not_negative',
      sql`quantity_received >= 0`,
    ),
    tenantPolicy('purchase_order_line'),
  ],
).enableRLS();

/**
 * Goods receipt — the ONLY thing in this schema that creates stock.
 *
 * Deliberately a separate document from the order, because the two differ in
 * practice: a receipt can arrive against no order at all (a local purchase), can
 * cover part of an order, and carries facts the order never had — the batch
 * number and the expiry date, which are the whole reason pharmacy stock is
 * tracked at batch level rather than as a single count.
 */
export const goodsReceipt = pgTable(
  'goods_receipt',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    /** Null for a direct purchase with no order raised first. */
    purchaseOrderId: uuid('purchase_order_id'),
    supplierId: uuid('supplier_id').notNull(),

    receiptNumber: text('receipt_number').notNull(),
    supplierInvoiceNumber: text('supplier_invoice_number'),
    supplierInvoiceDate: date('supplier_invoice_date'),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    receivedBy: uuid('received_by'),

    subtotalPaise: integer('subtotal_paise').notNull().default(0),
    taxPaise: integer('tax_paise').notNull().default(0),
    totalPaise: integer('total_paise').notNull().default(0),

    notes: text('notes'),

    /**
     * The client's key for this one operation, so a retry cannot repeat it.
     *
     * A pharmacy counter is the worst place for an at-least-once write. The
     * terminal gets tapped twice because the first tap did not visibly do
     * anything, or the request times out and the assistant tries again with a
     * patient waiting — and a duplicate looks exactly as real as the original.
     * The same reasoning, and the same mechanism, as `payment.idempotency_key`
     * in migration `0010`.
     *
     * Nullable, because rows written before this column existed have no key and
     * inventing one would be a lie about what happened. The unique index is
     * partial for the same reason.
     */
    idempotencyKey: text('idempotency_key'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({
      columns: [t.purchaseOrderId],
      foreignColumns: [purchaseOrder.id],
    }).onDelete('set null'),
    foreignKey({ columns: [t.supplierId], foreignColumns: [supplier.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.receivedBy], foreignColumns: [appUser.id] }).onDelete('set null'),

    uniqueIndex('goods_receipt_clinic_number_uq').on(t.clinicId, t.receiptNumber),
    index('goods_receipt_clinic_supplier_idx').on(t.clinicId, t.supplierId, t.receivedAt.desc()),
    index('goods_receipt_clinic_order_idx').on(t.clinicId, t.purchaseOrderId),
    /*
     * One per key per clinic.
     *
     * A receipt CREATES STOCK. Recording the same delivery twice puts medicine on the shelf that is not there, and the shortfall is found at the next count with no way to tell which receipt was the phantom.
     *
     * The database enforces this, not the service: a check-then-insert in
     * application code loses to two concurrent requests, which is precisely the
     * double-tap this exists to stop.
     */
    uniqueIndex('goods_receipt_idempotency_uq')
      .on(t.clinicId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    tenantPolicy('goods_receipt'),
  ],
).enableRLS();

export const goodsReceiptLine = pgTable(
  'goods_receipt_line',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    goodsReceiptId: uuid('goods_receipt_id').notNull(),
    productId: uuid('product_id').notNull(),

    batchNumber: text('batch_number').notNull(),
    expiryDate: date('expiry_date').notNull(),

    quantity: integer('quantity').notNull(),
    unitCostPaise: integer('unit_cost_paise').notNull(),
    mrpPaise: integer('mrp_paise'),
    gstRateBps: integer('gst_rate_bps').notNull().default(0),
    lineTotalPaise: integer('line_total_paise').notNull(),

    /** The batch this line created or added to. Set by the receiving service. */
    stockBatchId: uuid('stock_batch_id'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({
      columns: [t.goodsReceiptId],
      foreignColumns: [goodsReceipt.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.productId], foreignColumns: [pharmacyProduct.id] }).onDelete(
      'restrict',
    ),

    index('goods_receipt_line_receipt_idx').on(t.clinicId, t.goodsReceiptId),
    check('goods_receipt_line_qty_positive', sql`quantity > 0`),
    tenantPolicy('goods_receipt_line'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Stock
 * ------------------------------------------------------------------------- */

/**
 * A batch on the shelf.
 *
 * Batch-level rather than product-level because expiry is a property of the
 * batch, and expiry is the thing that makes pharmacy stock different from any
 * other inventory: the value goes to zero on a known date, and dispensing the
 * wrong one is a patient-safety event rather than an accounting error.
 */
export const stockBatch = pgTable(
  'stock_batch',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    productId: uuid('product_id').notNull(),

    batchNumber: text('batch_number').notNull(),
    expiryDate: date('expiry_date').notNull(),

    /**
     * A CACHED BALANCE. `stock_movement` is the truth.
     *
     * Held here because every dispense needs it and summing the ledger per
     * product per screen would not survive a busy counter. The two are
     * reconcilable, and the reconciliation is exposed on the stock screen rather
     * than left as a thing only the database knows.
     */
    quantityOnHand: integer('quantity_on_hand').notNull().default(0),

    unitCostPaise: integer('unit_cost_paise').notNull().default(0),
    mrpPaise: integer('mrp_paise'),

    supplierId: uuid('supplier_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.productId], foreignColumns: [pharmacyProduct.id] }).onDelete(
      'restrict',
    ),
    foreignKey({ columns: [t.supplierId], foreignColumns: [supplier.id] }).onDelete('set null'),

    /*
     * One row per product per batch per expiry.
     *
     * Expiry is in the key, not only the batch number, because suppliers reuse
     * batch numbers across manufacturing runs more often than anyone would like
     * and merging two expiries into one row loses the earlier date.
     */
    uniqueIndex('stock_batch_uq').on(t.clinicId, t.productId, t.batchNumber, t.expiryDate),

    /* The two queries the whole module runs: what is in stock, what expires. */
    index('stock_batch_clinic_product_idx').on(t.clinicId, t.productId),
    index('stock_batch_clinic_expiry_idx')
      .on(t.clinicId, t.expiryDate)
      .where(sql`quantity_on_hand > 0`),

    /*
     * Stock cannot go negative.
     *
     * A database-level check rather than a service-level one, because the
     * failure it prevents — dispensing from a batch that has already run out —
     * is exactly the kind that appears under concurrency when two people are at
     * the counter and the application-level read happened first.
     */
    check('stock_batch_not_negative', sql`quantity_on_hand >= 0`),
    tenantPolicy('stock_batch'),
  ],
).enableRLS();

/**
 * The stock ledger. Append-only, enforced by trigger in the migration.
 *
 * Every row is a signed quantity against a batch with the reason it moved and a
 * reference to the document that caused it. `balanceAfter` is stored so a
 * reconciliation can be read straight down the column instead of accumulated in
 * application code — and so a discrepancy points at the row where it started.
 */
export const stockMovement = pgTable(
  'stock_movement',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    productId: uuid('product_id').notNull(),
    stockBatchId: uuid('stock_batch_id').notNull(),

    movementType: stockMovementTypeEnum('movement_type').notNull(),

    /** Signed. Negative takes stock off the shelf. Never zero. */
    quantityDelta: integer('quantity_delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),

    /**
     * Required for a correction or a write-off, and free text on purpose.
     *
     * "Counted 3 short at month end" is worth more than any enum this could
     * have been, and an adjustment without an explanation is the thing an
     * auditor asks about first.
     */
    reason: text('reason'),

    /** What caused it: 'DISPENSE', 'GOODS_RECEIPT', 'SALE', 'ADJUSTMENT'. */
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    /** Denormalised, like audit_event: the name must survive staff deletion. */
    actorName: text('actor_name'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.productId], foreignColumns: [pharmacyProduct.id] }).onDelete(
      'restrict',
    ),
    foreignKey({ columns: [t.stockBatchId], foreignColumns: [stockBatch.id] }).onDelete(
      'restrict',
    ),

    index('stock_movement_clinic_batch_idx').on(t.clinicId, t.stockBatchId, t.occurredAt.desc()),
    index('stock_movement_clinic_product_idx').on(t.clinicId, t.productId, t.occurredAt.desc()),
    index('stock_movement_clinic_type_idx').on(t.clinicId, t.movementType, t.occurredAt.desc()),
    check('stock_movement_delta_not_zero', sql`quantity_delta <> 0`),
    tenantPolicy('stock_movement'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Dispensing
 * ------------------------------------------------------------------------- */

/**
 * One dispense record per encounter's prescription.
 *
 * Grouped by ENCOUNTER rather than by `medication_request`, because that is the
 * unit the patient and the pharmacist both work in: a person arrives at the
 * counter with one prescription containing four medicines, and four separate
 * queue entries for them would be four separate conversations.
 */
export const dispenseRecord = pgTable(
  'dispense_record',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),

    status: dispenseStatusEnum('status').notNull().default('PENDING'),

    /**
     * When the prescription became available to the counter.
     *
     * Set from the encounter's finalisation, not from row creation, so
     * "prescription-to-dispense turnaround" — the blueprint's §10.2 metric —
     * measures the patient's wait rather than the queue row's age.
     */
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    dispensedBy: uuid('dispensed_by'),

    notes: text('notes'),
    cancelledReason: text('cancelled_reason'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.encounterId], foreignColumns: [encounter.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.dispensedBy], foreignColumns: [appUser.id] }).onDelete('set null'),

    /* One queue entry per prescription, so finalising twice cannot duplicate it. */
    uniqueIndex('dispense_record_encounter_uq').on(t.clinicId, t.encounterId),

    /* The queue: everything not yet finished, oldest first. */
    index('dispense_record_clinic_open_idx')
      .on(t.clinicId, t.queuedAt)
      .where(sql`status NOT IN ('DISPENSED', 'CANCELLED')`),
    index('dispense_record_clinic_patient_idx').on(t.clinicId, t.patientId, t.queuedAt.desc()),
    tenantPolicy('dispense_record'),
  ],
).enableRLS();

export const dispenseLine = pgTable(
  'dispense_line',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    dispenseRecordId: uuid('dispense_record_id').notNull(),

    /** The order being filled. READ ONLY from here — never updated. */
    medicationRequestId: uuid('medication_request_id').notNull(),

    /** Null until the pharmacist picks a product; the order names a molecule. */
    productId: uuid('product_id'),
    stockBatchId: uuid('stock_batch_id'),

    /**
     * What was ordered and what was given.
     *
     * Both stored. The prescribed quantity is copied at queue time so that the
     * record still reads correctly if the catalogue changes, and the difference
     * between the two columns is what "partially dispensed" actually means.
     */
    quantityPrescribed: numeric('quantity_prescribed', { precision: 10, scale: 2 }),
    quantityDispensed: integer('quantity_dispensed').notNull().default(0),

    /**
     * Substitution, recorded as a fact rather than hidden as an edit.
     *
     * A pharmacist who gives a different brand of the same molecule has done
     * something normal and legal. A pharmacist who gives a different molecule
     * has done something that needs the prescriber's answer first, which is what
     * `rx_clarification` is for. The schema cannot tell them apart; the service
     * can, and does.
     */
    isSubstitution: boolean('is_substitution').notNull().default(false),
    substitutionReason: text('substitution_reason'),

    unitPricePaise: integer('unit_price_paise').notNull().default(0),
    gstRateBps: integer('gst_rate_bps').notNull().default(0),
    lineTotalPaise: integer('line_total_paise').notNull().default(0),

    /** Set when the pharmacist declines a line outright, with why. */
    notDispensedReason: text('not_dispensed_reason'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({
      columns: [t.dispenseRecordId],
      foreignColumns: [dispenseRecord.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.medicationRequestId],
      foreignColumns: [medicationRequest.id],
    }).onDelete('restrict'),
    foreignKey({ columns: [t.productId], foreignColumns: [pharmacyProduct.id] }).onDelete(
      'set null',
    ),
    foreignKey({ columns: [t.stockBatchId], foreignColumns: [stockBatch.id] }).onDelete(
      'set null',
    ),

    uniqueIndex('dispense_line_request_uq').on(t.clinicId, t.medicationRequestId),
    index('dispense_line_record_idx').on(t.clinicId, t.dispenseRecordId),
    check('dispense_line_qty_not_negative', sql`quantity_dispensed >= 0`),
    tenantPolicy('dispense_line'),
  ],
).enableRLS();

/**
 * A question from the counter to the prescriber.
 *
 * The blueprint's competitive point, and the reason it is a table: everywhere
 * else this happens as a phone call or a WhatsApp message, so the reason a
 * prescription was changed is reconstructible only from memory. Here the
 * question, the answer, both people and both timestamps are one row attached to
 * the order it concerns.
 */
export const rxClarification = pgTable(
  'rx_clarification',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    medicationRequestId: uuid('medication_request_id').notNull(),
    dispenseRecordId: uuid('dispense_record_id'),

    status: clarificationStatusEnum('status').notNull().default('OPEN'),

    question: text('question').notNull(),
    raisedBy: uuid('raised_by'),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),

    answer: text('answer'),
    answeredBy: uuid('answered_by'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),

    /**
     * What the prescriber decided, as a code the counter can act on.
     *
     * 'CONFIRMED_AS_WRITTEN' | 'SUBSTITUTE_APPROVED' | 'DOSE_CLARIFIED' |
     * 'CANCEL_THIS_ITEM' | 'PATIENT_TO_RETURN'. Free text alone would leave the
     * pharmacist to interpret a sentence, which is the ambiguity this whole
     * table exists to remove.
     */
    resolutionAction: text('resolution_action'),

    withdrawnReason: text('withdrawn_reason'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({
      columns: [t.medicationRequestId],
      foreignColumns: [medicationRequest.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.dispenseRecordId],
      foreignColumns: [dispenseRecord.id],
    }).onDelete('set null'),
    foreignKey({ columns: [t.raisedBy], foreignColumns: [appUser.id] }).onDelete('set null'),
    foreignKey({ columns: [t.answeredBy], foreignColumns: [appUser.id] }).onDelete('set null'),

    /* Both inboxes: what the counter is waiting on, what a doctor must answer. */
    index('rx_clarification_clinic_open_idx')
      .on(t.clinicId, t.raisedAt)
      .where(sql`status = 'OPEN'`),
    index('rx_clarification_request_idx').on(t.clinicId, t.medicationRequestId),
    tenantPolicy('rx_clarification'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Counter sales
 * ------------------------------------------------------------------------- */

/**
 * A sale at the medicine counter.
 *
 * SEPARATE FROM `invoice`, which is the clinic's billing for consultations and
 * services. Keeping them apart matters for two unrelated reasons: the tax
 * treatment differs (goods with an HSN code and a GST slab, versus a service),
 * and the clinical record must not depend on whether the patient paid for their
 * medicines — a dispense stands on its own whether or not a sale was rung up.
 */
export const pharmacySale = pgTable(
  'pharmacy_sale',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    saleNumber: text('sale_number').notNull(),
    status: pharmacySaleStatusEnum('status').notNull().default('DRAFT'),

    /** Null for an over-the-counter sale to someone who is not a patient. */
    patientId: uuid('patient_id'),
    /** Set when the sale is the priced version of a dispense. */
    dispenseRecordId: uuid('dispense_record_id'),

    /** Free text, for an OTC buyer who is not in the registry. */
    buyerName: text('buyer_name'),

    subtotalPaise: integer('subtotal_paise').notNull().default(0),
    discountPaise: integer('discount_paise').notNull().default(0),
    discountReason: text('discount_reason'),
    taxPaise: integer('tax_paise').notNull().default(0),
    totalPaise: integer('total_paise').notNull().default(0),
    paidPaise: integer('paid_paise').notNull().default(0),
    paymentMethod: paymentMethodEnum('payment_method'),

    soldBy: uuid('sold_by'),
    soldAt: timestamp('sold_at', { withTimezone: true }),

    /**
     * A return is its own sale row referencing the original, with negative
     * lines — never a mutation of the original, and never a deletion. Same
     * reasoning as a refund in `payment`.
     */
    isReturn: boolean('is_return').notNull().default(false),
    returnOfSaleId: uuid('return_of_sale_id'),
    returnReason: text('return_reason'),

    cancelledReason: text('cancelled_reason'),

    /**
     * The client's key for this one operation, so a retry cannot repeat it.
     *
     * A pharmacy counter is the worst place for an at-least-once write. The
     * terminal gets tapped twice because the first tap did not visibly do
     * anything, or the request times out and the assistant tries again with a
     * patient waiting — and a duplicate looks exactly as real as the original.
     * The same reasoning, and the same mechanism, as `payment.idempotency_key`
     * in migration `0010`.
     *
     * Nullable, because rows written before this column existed have no key and
     * inventing one would be a lie about what happened. The unique index is
     * partial for the same reason.
     */
    idempotencyKey: text('idempotency_key'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('set null'),
    foreignKey({
      columns: [t.dispenseRecordId],
      foreignColumns: [dispenseRecord.id],
    }).onDelete('set null'),
    foreignKey({ columns: [t.soldBy], foreignColumns: [appUser.id] }).onDelete('set null'),

    uniqueIndex('pharmacy_sale_clinic_number_uq').on(t.clinicId, t.saleNumber),
    index('pharmacy_sale_clinic_sold_idx').on(t.clinicId, t.soldAt.desc()),
    index('pharmacy_sale_clinic_patient_idx').on(t.clinicId, t.patientId),
    /*
     * One per key per clinic.
     *
     * A sale TAKES MONEY and removes stock. A duplicate charges the customer twice and understates the shelf, and reconciling it later means deciding which of two identical rows never happened.
     *
     * The database enforces this, not the service: a check-then-insert in
     * application code loses to two concurrent requests, which is precisely the
     * double-tap this exists to stop.
     */
    uniqueIndex('pharmacy_sale_idempotency_uq')
      .on(t.clinicId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    tenantPolicy('pharmacy_sale'),
  ],
).enableRLS();

export const pharmacySaleLine = pgTable(
  'pharmacy_sale_line',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    pharmacySaleId: uuid('pharmacy_sale_id').notNull(),
    productId: uuid('product_id').notNull(),
    stockBatchId: uuid('stock_batch_id').notNull(),

    /** Negative on a return line. */
    quantity: integer('quantity').notNull(),
    unitPricePaise: integer('unit_price_paise').notNull(),
    gstRateBps: integer('gst_rate_bps').notNull().default(0),
    discountPaise: integer('discount_paise').notNull().default(0),
    lineTotalPaise: integer('line_total_paise').notNull(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({
      columns: [t.pharmacySaleId],
      foreignColumns: [pharmacySale.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.productId], foreignColumns: [pharmacyProduct.id] }).onDelete(
      'restrict',
    ),
    foreignKey({ columns: [t.stockBatchId], foreignColumns: [stockBatch.id] }).onDelete(
      'restrict',
    ),

    index('pharmacy_sale_line_sale_idx').on(t.clinicId, t.pharmacySaleId),
    check('pharmacy_sale_line_qty_not_zero', sql`quantity <> 0`),
    tenantPolicy('pharmacy_sale_line'),
  ],
).enableRLS();
