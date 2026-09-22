import {
  Body, Controller, Get, Injectable, Module, NotFoundException, Param, Post, Query,
  ConflictException,
} from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { DraftInvoice, RecordPayment, computeInvoiceTotals, type Invoice } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { Audit, RequirePermission } from '../../common/http/decorators';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';

/**
 * Billing-Lite.
 *
 * Invoices and payment records. Not an accounting system — no ledger, no tax
 * filing, no TDS. That boundary belongs in the contract as well as the code,
 * because this is exactly where scope expands quietly.
 *
 * Every amount is an integer count of paise. Floating-point currency produces
 * reconciliation errors that are tedious to find and embarrassing to explain.
 */
@Injectable()
export class BillingService {
  constructor(private readonly tenantDb: TenantDb) {}

  async list(patientId?: string): Promise<Invoice[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({ invoice: schema.invoice, patientName: schema.patient.fullName })
        .from(schema.invoice)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.invoice.patientId))
        .where(patientId ? eq(schema.invoice.patientId, patientId) : undefined)
        .orderBy(desc(schema.invoice.createdAt))
        .limit(200),
    );

    const withPayments = await Promise.all(
      rows.map(async ({ invoice, patientName }) => ({
        ...serialise(invoice, patientName),
        payments: await this.paymentsFor(invoice.id),
      })),
    );

    return withPayments;
  }

  async byId(id: string): Promise<Invoice> {
    const row = await this.tenantDb.runReadOnly(async (tx) => {
      const [found] = await tx
        .select({ invoice: schema.invoice, patientName: schema.patient.fullName })
        .from(schema.invoice)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.invoice.patientId))
        .where(eq(schema.invoice.id, id))
        .limit(1);
      return found;
    });

    if (!row) throw new NotFoundException('That invoice could not be found.');
    return { ...serialise(row.invoice, row.patientName), payments: await this.paymentsFor(id) };
  }

  async create(input: {
    patientId: string;
    encounterId?: string | null;
    lineItems: never[];
    discountPaise?: number;
  }): Promise<Invoice> {
    const ctx = TenantContext.require();
    const totals = computeInvoiceTotals(input.lineItems, input.discountPaise ?? 0, 0);

    return this.tenantDb.run(async (tx) => {
      const [patient] = await tx
        .select()
        .from(schema.patient)
        .where(eq(schema.patient.id, input.patientId))
        .limit(1);
      if (!patient) throw new NotFoundException('That patient could not be found.');

      const number = await this.nextInvoiceNumber(tx);

      const [created] = await tx
        .insert(schema.invoice)
        .values({
          clinicId: ctx.clinicId,
          patientId: input.patientId,
          encounterId: input.encounterId ?? null,
          invoiceNumber: number,
          status: 'ISSUED',
          lineItems: input.lineItems,
          subtotalPaise: totals.subtotalPaise,
          discountPaise: input.discountPaise ?? 0,
          taxPaise: totals.taxPaise,
          totalPaise: totals.totalPaise,
          paidPaise: 0,
          issuedAt: new Date(),
          // Issued invoices are immutable; a correction is a credit note.
          isFinalized: true,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      return { ...serialise(created!, patient.fullName), payments: [] };
    });
  }

  /**
   * Records a payment.
   *
   * Separate rows rather than a paid flag, because partial and mixed tender —
   * part cash, part UPI — is routine at a front desk. A refund is a negative
   * row, never a deletion of the original.
   */
  async recordPayment(invoiceId: string, input: {
    amountPaise: number;
    method: string;
    referenceNumber?: string | null;
    isRefund?: boolean;
    refundReason?: string | null;
  }): Promise<Invoice> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.id, invoiceId))
        .limit(1);
      if (!invoice) throw new NotFoundException('That invoice could not be found.');
      if (invoice.status === 'CANCELLED') {
        throw new ConflictException('That invoice has been cancelled.');
      }

      await tx.insert(schema.payment).values({
        clinicId: ctx.clinicId,
        invoiceId,
        patientId: invoice.patientId,
        amountPaise: input.amountPaise,
        method: input.method as 'CASH',
        referenceNumber: input.referenceNumber ?? null,
        receivedBy: ctx.userId,
        isRefund: input.isRefund ?? false,
        refundReason: input.refundReason ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });

      const paid = Number(invoice.paidPaise) + input.amountPaise;

      const [updated] = await tx
        .update(schema.invoice)
        .set({
          paidPaise: paid,
          status: paid >= Number(invoice.totalPaise) ? 'BALANCED' : invoice.status,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.invoice.id, invoiceId))
        .returning();

      const [patient] = await tx
        .select({ name: schema.patient.fullName })
        .from(schema.patient)
        .where(eq(schema.patient.id, invoice.patientId))
        .limit(1);

      return {
        ...serialise(updated!, patient?.name ?? 'Unknown'),
        payments: await this.paymentsFor(invoiceId),
      };
    });
  }

  private async paymentsFor(invoiceId: string) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({ payment: schema.payment, receivedBy: schema.appUser.fullName })
        .from(schema.payment)
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.payment.receivedBy))
        .where(eq(schema.payment.invoiceId, invoiceId))
        .orderBy(desc(schema.payment.receivedAt)),
    );

    return rows.map(({ payment, receivedBy }) => ({
      ...payment,
      amountPaise: Number(payment.amountPaise),
      receivedAt: payment.receivedAt.toISOString(),
      receivedByName: receivedBy ?? 'Unknown',
    })) as never;
  }

  /**
   * Sequential per clinic per financial year, e.g. INV-2026-0142.
   *
   * Counted inside the caller's transaction, and RLS scopes the count to this
   * clinic — so two clinics never collide and neither can see the other's
   * numbering.
   */
  private async nextInvoiceNumber(
    tx: Parameters<Parameters<TenantDb['run']>[0]>[0],
  ): Promise<string> {
    const year = new Date().getFullYear();
    const result = await tx.execute<{ next: string }>(
      sql`SELECT count(*) + 1 AS next FROM invoice`,
    );
    const next = Number(result.rows[0]?.next ?? 1);
    return `INV-${year}-${String(next).padStart(4, '0')}`;
  }
}

function serialise(row: typeof schema.invoice.$inferSelect, patientName: string): Invoice {
  return {
    ...row,
    patientName,
    subtotalPaise: Number(row.subtotalPaise),
    discountPaise: Number(row.discountPaise),
    taxPaise: Number(row.taxPaise),
    totalPaise: Number(row.totalPaise),
    paidPaise: Number(row.paidPaise),
    issuedAt: row.issuedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    payments: [],
  } as unknown as Invoice;
}

@Controller('invoices')
class BillingController {
  constructor(private readonly billing: BillingService) {}

  @RequirePermission('invoice:read')
  @Get()
  async list(@Query('patientId') patientId?: string) {
    return { items: await this.billing.list(patientId) };
  }

  @RequirePermission('invoice:read')
  @Get(':id')
  byId(@Param('id') id: string) {
    return this.billing.byId(requireUuid(id, 'Invoice'));
  }

  @RequirePermission('invoice:create')
  @Audit('INVOICE_CREATED', 'invoice')
  @Post()
  create(@Body() body: unknown) {
    return this.billing.create(parseBody(DraftInvoice, body) as never);
  }

  @RequirePermission('payment:create')
  @Audit('PAYMENT_RECORDED', 'payment')
  @Post(':id/payments')
  pay(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(RecordPayment.omit({ invoiceId: true }), body);
    return this.billing.recordPayment(requireUuid(id, 'Invoice'), input as never);
  }
}

@Module({
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
