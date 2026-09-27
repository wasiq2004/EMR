import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type { PharmacyProduct, SaveProduct, SaveSupplier, Supplier } from '@emr/contracts';

import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { normalise } from './stock.service';

/**
 * What the pharmacy sells, and who it buys from.
 *
 * The blueprint's §13 risk register names "medication setup burden" — a reviewer
 * describing having to type a pharmacological database by hand. Two things here
 * answer it: a product can be created FROM a drug catalogue entry, carrying the
 * molecule, strength and form across, and a product is not required to have a
 * catalogue entry at all, so gauze and syringes do not need a fake drug record
 * invented for them.
 *
 * Neither a supplier nor a product is ever deleted. Both are referenced by
 * receipts, batches and sales that must still read correctly years later, so
 * `isActive` is the off switch. A pharmacy that stops stocking a brand still
 * needs last year's invoice to name it.
 */
@Injectable()
export class CatalogueService {
  constructor(private readonly tenantDb: TenantDb) {}

  /* ---- Suppliers ---------------------------------------------------------- */

  async suppliers(options: { includeInactive?: boolean } = {}): Promise<Supplier[]> {
    const rows = await this.tenantDb.runReadOnly(async (tx) => {
      const suppliers = await tx
        .select()
        .from(schema.supplier)
        .where(options.includeInactive ? undefined : eq(schema.supplier.isActive, true))
        .orderBy(asc(schema.supplier.name))
        .limit(500);

      /* Open orders per supplier, in one query rather than one per row. */
      const open = await tx
        .select({
          supplierId: schema.purchaseOrder.supplierId,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.purchaseOrder)
        .where(
          sql`${schema.purchaseOrder.status} IN ('DRAFT', 'AWAITING_APPROVAL', 'PLACED', 'PARTIALLY_RECEIVED')`,
        )
        .groupBy(schema.purchaseOrder.supplierId);

      const openBy = new Map(open.map((row) => [row.supplierId, row.n]));
      return suppliers.map((s) => ({ ...s, openOrderCount: openBy.get(s.id) ?? 0 }));
    });

    return rows.map(serialiseSupplier);
  }

  async supplier(id: string): Promise<Supplier> {
    const [row] = await this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.supplier).where(eq(schema.supplier.id, id)).limit(1),
    );
    if (!row) throw new NotFoundException('That supplier could not be found.');
    return serialiseSupplier(row);
  }

  async saveSupplier(input: SaveSupplier & { id?: string }): Promise<Supplier> {
    const ctx = TenantContext.require();

    const values = {
      name: input.name.trim(),
      gstin: input.gstin ?? null,
      drugLicenceNumber: input.drugLicenceNumber ?? null,
      contactPerson: input.contactPerson ?? null,
      phoneE164: input.phoneE164 ?? null,
      email: input.email ?? null,
      addressLine1: input.addressLine1 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      pincode: input.pincode ?? null,
      paymentTermsDays: input.paymentTermsDays ?? null,
      notes: input.notes ?? null,
      isActive: input.isActive,
      updatedBy: ctx.userId,
    };

    const row = await this.tenantDb.run(async (tx) => {
      if (input.id) {
        const [updated] = await tx
          .update(schema.supplier)
          .set(values)
          .where(eq(schema.supplier.id, input.id))
          .returning();
        if (!updated) throw new NotFoundException('That supplier could not be found.');
        return updated;
      }

      const [created] = await tx
        .insert(schema.supplier)
        .values({ ...values, clinicId: ctx.clinicId, createdBy: ctx.userId })
        .returning()
        .catch((error: Error) => {
          if (/supplier_clinic_name_uq/.test(error.message)) {
            throw new ConflictException(
              `A supplier called "${values.name}" already exists. Open it rather than adding a second.`,
            );
          }
          throw error;
        });
      return created!;
    });

    return serialiseSupplier(row);
  }

  /* ---- Products ----------------------------------------------------------- */

  /**
   * The product list, with stock.
   *
   * `quantityOnHand` and `earliestExpiry` come from a single grouped join rather
   * than a query per product. Expired batches are excluded from the total for
   * the same reason as on the alert board: stock that cannot be sold is not
   * stock, and counting it makes the reorder report lie.
   */
  async products(options: {
    search?: string;
    includeInactive?: boolean;
    lowStockOnly?: boolean;
  } = {}): Promise<PharmacyProduct[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          product: schema.pharmacyProduct,
          onHand: sql<number>`coalesce(sum(${schema.stockBatch.quantityOnHand}), 0)::int`,
          earliestExpiry: sql<string | null>`min(${schema.stockBatch.expiryDate})`,
        })
        .from(schema.pharmacyProduct)
        .leftJoin(
          schema.stockBatch,
          and(
            eq(schema.stockBatch.productId, schema.pharmacyProduct.id),
            gt(schema.stockBatch.quantityOnHand, 0),
            sql`${schema.stockBatch.expiryDate} >= current_date`,
          ),
        )
        .where(
          and(
            options.includeInactive ? undefined : eq(schema.pharmacyProduct.isActive, true),
            options.search
              ? sql`${schema.pharmacyProduct.searchNormalized} LIKE ${'%' + normalise(options.search) + '%'}`
              : undefined,
          ),
        )
        .groupBy(schema.pharmacyProduct.id)
        .orderBy(asc(schema.pharmacyProduct.name))
        .limit(500),
    );

    const mapped = rows.map(({ product, onHand, earliestExpiry }) => ({
      ...serialiseProduct(product),
      quantityOnHand: onHand,
      earliestExpiry,
    }));

    if (!options.lowStockOnly) return mapped;

    return mapped.filter(
      (p) => p.reorderLevel !== null && (p.quantityOnHand ?? 0) <= p.reorderLevel,
    );
  }

  async product(id: string): Promise<PharmacyProduct> {
    const [row] = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select()
        .from(schema.pharmacyProduct)
        .where(eq(schema.pharmacyProduct.id, id))
        .limit(1),
    );
    if (!row) throw new NotFoundException('That product could not be found.');
    return serialiseProduct(row);
  }

  async saveProduct(input: SaveProduct & { id?: string }): Promise<PharmacyProduct> {
    const ctx = TenantContext.require();

    /*
     * Fields copied from the drug catalogue when a link is given and the field
     * was left blank. Copied rather than read through, so the product still
     * describes itself if the catalogue entry is later deactivated — and so a
     * pharmacist can correct a strength the catalogue has wrong without editing
     * shared reference data.
     */
    const fromCatalogue = input.catalogueItemId
      ? await this.tenantDb.runReadOnly(async (tx) => {
          const [item] = await tx
            .select()
            .from(schema.drugCatalogueItem)
            .where(eq(schema.drugCatalogueItem.id, input.catalogueItemId!))
            .limit(1);
          return item ?? null;
        })
      : null;

    const name = input.name.trim();
    const moleculeName = input.moleculeName ?? fromCatalogue?.moleculeName ?? null;

    const values = {
      catalogueItemId: input.catalogueItemId ?? null,
      name,
      /* Brand and molecule both go into the search key: pharmacists use either. */
      searchNormalized: normalise(
        [name, input.brandName, moleculeName, input.strength].filter(Boolean).join(' '),
      ),
      brandName: input.brandName ?? fromCatalogue?.brandName ?? null,
      moleculeName,
      manufacturer: input.manufacturer ?? fromCatalogue?.manufacturer ?? null,
      strength: input.strength ?? fromCatalogue?.strength ?? null,
      dosageForm: input.dosageForm ?? fromCatalogue?.dosageForm ?? null,
      hsnCode: input.hsnCode ?? null,
      gstRateBps: input.gstRateBps,
      packSize: input.packSize,
      packUnit: input.packUnit,
      mrpPaise: input.mrpPaise ?? null,
      reorderLevel: input.reorderLevel ?? null,
      reorderQuantity: input.reorderQuantity ?? null,
      drugSchedule: input.drugSchedule ?? fromCatalogue?.drugSchedule ?? null,
      /*
       * A scheduled drug requires a prescription whether or not the form said so.
       *
       * Deriving it rather than trusting the input closes the obvious hole: a
       * Schedule H product saved with the box unticked would be sellable over
       * the counter, which is the one thing the schedule exists to prevent.
       */
      requiresPrescription:
        input.requiresPrescription ||
        Boolean(input.drugSchedule ?? fromCatalogue?.drugSchedule) ||
        Boolean(fromCatalogue?.isNarcotic),
      isNarcotic: input.isNarcotic || Boolean(fromCatalogue?.isNarcotic),
      isActive: input.isActive,
      updatedBy: ctx.userId,
    };

    const row = await this.tenantDb.run(async (tx) => {
      if (input.id) {
        const [updated] = await tx
          .update(schema.pharmacyProduct)
          .set(values)
          .where(eq(schema.pharmacyProduct.id, input.id))
          .returning();
        if (!updated) throw new NotFoundException('That product could not be found.');
        return updated;
      }

      const [created] = await tx
        .insert(schema.pharmacyProduct)
        .values({ ...values, clinicId: ctx.clinicId, createdBy: ctx.userId })
        .returning();
      return created!;
    });

    return serialiseProduct(row);
  }

  /**
   * Retires a product.
   *
   * Refuses while stock remains, because a deactivated product with twelve packs
   * on the shelf is stock nobody can sell and nobody can see — it drops off every
   * list while still occupying space and value. Write it off first, deliberately.
   */
  async retireProduct(id: string) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [stock] = await tx
        .select({ onHand: sql<number>`coalesce(sum(${schema.stockBatch.quantityOnHand}), 0)::int` })
        .from(schema.stockBatch)
        .where(eq(schema.stockBatch.productId, id));

      if ((stock?.onHand ?? 0) > 0) {
        throw new ConflictException(
          `There are still ${stock!.onHand} units of this product in stock. Write them off or sell them before retiring it.`,
        );
      }

      await tx
        .update(schema.pharmacyProduct)
        .set({ isActive: false, updatedBy: ctx.userId })
        .where(eq(schema.pharmacyProduct.id, id));

      return { retired: true };
    });
  }

  /**
   * Catalogue entries with no pharmacy product yet.
   *
   * Drives the "add from the drug catalogue" flow, which is the answer to the
   * setup burden: a clinic already prescribing forty molecules should be able to
   * stock them without retyping any of it.
   */
  async unstockedCatalogueItems(search?: string) {
    return this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          id: schema.drugCatalogueItem.id,
          brandName: schema.drugCatalogueItem.brandName,
          moleculeName: schema.drugCatalogueItem.moleculeName,
          strength: schema.drugCatalogueItem.strength,
          dosageForm: schema.drugCatalogueItem.dosageForm,
          manufacturer: schema.drugCatalogueItem.manufacturer,
          drugSchedule: schema.drugCatalogueItem.drugSchedule,
        })
        .from(schema.drugCatalogueItem)
        .where(
          and(
            eq(schema.drugCatalogueItem.isActive, true),
            search
              ? sql`${schema.drugCatalogueItem.searchNormalized} LIKE ${'%' + normalise(search) + '%'}`
              : undefined,
            sql`NOT EXISTS (
              SELECT 1 FROM ${schema.pharmacyProduct}
              WHERE ${schema.pharmacyProduct.catalogueItemId} = ${schema.drugCatalogueItem.id}
            )`,
          ),
        )
        .orderBy(asc(schema.drugCatalogueItem.moleculeName))
        .limit(100),
    );
  }
}

function serialiseSupplier(
  row: typeof schema.supplier.$inferSelect & { openOrderCount?: number },
): Supplier {
  return {
    id: row.id,
    name: row.name,
    gstin: row.gstin,
    drugLicenceNumber: row.drugLicenceNumber,
    contactPerson: row.contactPerson,
    phoneE164: row.phoneE164,
    email: row.email,
    addressLine1: row.addressLine1,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    paymentTermsDays: row.paymentTermsDays,
    notes: row.notes,
    isActive: row.isActive,
    openOrderCount: row.openOrderCount,
  };
}

function serialiseProduct(row: typeof schema.pharmacyProduct.$inferSelect): PharmacyProduct {
  return {
    id: row.id,
    catalogueItemId: row.catalogueItemId,
    name: row.name,
    brandName: row.brandName,
    moleculeName: row.moleculeName,
    manufacturer: row.manufacturer,
    strength: row.strength,
    dosageForm: row.dosageForm,
    hsnCode: row.hsnCode,
    gstRateBps: row.gstRateBps,
    packSize: row.packSize,
    packUnit: row.packUnit,
    mrpPaise: row.mrpPaise,
    reorderLevel: row.reorderLevel,
    reorderQuantity: row.reorderQuantity,
    drugSchedule: row.drugSchedule,
    requiresPrescription: row.requiresPrescription,
    isNarcotic: row.isNarcotic,
    isActive: row.isActive,
  };
}
