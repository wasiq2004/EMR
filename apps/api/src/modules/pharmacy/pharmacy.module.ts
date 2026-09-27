import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  AdjustStock,
  AnswerClarification,
  DispenseStatus,
  FillLine,
  OpeningBalance,
  RaiseClarification,
  ReceiveGoods,
  RecordSale,
  ReturnSale,
  SaveProduct,
  SavePurchaseOrder,
  SaveSupplier,
} from '@emr/contracts';

import { Audit, RequirePermission } from '../../common/http/decorators';
import { RequiresFeature } from '../../common/features/feature.guard';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { CatalogueService } from './catalogue.service';
import { DispensingService } from './dispensing.service';
import { PharmacyReportsService } from './pharmacy-reports.service';
import { PurchasingService } from './purchasing.service';
import { SalesService } from './sales.service';
import { StockService } from './stock.service';

/**
 * The pharmacy API.
 *
 * Every route is gated three times over, and the three are different things:
 *
 *   `@RequiresFeature('pharmacy')`  — did this clinic buy the module
 *   `@RequirePermission(...)`       — may this ROLE do this
 *   `@Audit(...)`                   — and it is recorded either way
 *
 * The permissions are deliberately fine-grained rather than one `pharmacy:*`.
 * Raising a purchase order and approving the spend are separate permissions
 * because they are routinely separate people; dispensing and adjusting stock are
 * separate because one is a licensed act and the other is an accounting
 * correction. A single permission would have made every one of those the same
 * decision.
 *
 * NOTHING HERE CAN WRITE A PRESCRIPTION. There is no route that updates a
 * `medication_request`, the PHARMACIST role holds no `prescription:update`, and a
 * database trigger refuses the write regardless. Three layers, because the
 * failure they prevent — a dispensing screen silently changing what a doctor
 * ordered — is the one thing this module must never do.
 */

const ReasonOnly = z.object({
  reason: z.string().trim().min(5, 'Say why, briefly'),
});

const ReturnToSupplier = z.object({
  stockBatchId: z.string().uuid(),
  quantity: z.number().int().positive('Return at least one'),
  reason: z.string().trim().min(5, 'Say why it is going back'),
});

@RequiresFeature('pharmacy')
@Controller('pharmacy')
export class PharmacyController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly stock: StockService,
    private readonly purchasing: PurchasingService,
    private readonly dispensing: DispensingService,
    private readonly sales: SalesService,
    private readonly reports: PharmacyReportsService,
  ) {}

  /* ---- The queue ---------------------------------------------------------- */

  @RequirePermission('dispense:read')
  @Get('queue')
  async queue(
    @Query('status') status?: string,
    @Query('includeFinished') includeFinished?: string,
  ) {
    const parsed = status ? DispenseStatus.safeParse(status) : null;
    return {
      items: await this.dispensing.queue({
        status: parsed?.success ? parsed.data : undefined,
        includeFinished: includeFinished === 'true',
      }),
    };
  }

  @RequirePermission('dispense:read')
  @Get('queue/:id')
  detail(@Param('id') id: string) {
    return this.dispensing.detail(requireUuid(id, 'Prescription'));
  }

  @RequirePermission('dispense:update')
  @Audit('DISPENSE_STARTED', 'dispense')
  @Post('queue/:id/start')
  start(@Param('id') id: string) {
    return this.dispensing.start(requireUuid(id, 'Prescription'));
  }

  @RequirePermission('dispense:create')
  @Audit('DISPENSE_LINE_FILLED', 'dispense')
  @Post('lines/:id/fill')
  fill(@Param('id') id: string, @Body() body: unknown) {
    return this.dispensing.fillLine(requireUuid(id, 'Prescription line'), parseBody(FillLine, body));
  }

  @RequirePermission('dispense:create')
  @Audit('DISPENSE_COMPLETED', 'dispense')
  @Post('queue/:id/complete')
  complete(@Param('id') id: string) {
    return this.dispensing.complete(requireUuid(id, 'Prescription'));
  }

  @RequirePermission('dispense:update')
  @Audit('DISPENSE_REOPENED', 'dispense')
  @Post('queue/:id/reopen')
  reopen(@Param('id') id: string) {
    return this.dispensing.reopen(requireUuid(id, 'Prescription'));
  }

  @RequirePermission('dispense:update')
  @Audit('DISPENSE_CANCELLED', 'dispense')
  @Post('queue/:id/cancel')
  cancel(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(ReasonOnly, body);
    return this.dispensing.cancel(requireUuid(id, 'Prescription'), input.reason);
  }

  /* ---- Clarifications ----------------------------------------------------- */

  @RequirePermission('clarification:read')
  @Get('clarifications')
  async clarifications(@Query('status') status?: string, @Query('mine') mine?: string) {
    const ctx = TenantContext.require();

    /*
     * `mine=true` is what the doctor's card asks for: open questions about
     * prescriptions THIS prescriber wrote. Without it a doctor in a three-doctor
     * clinic sees every colleague's queries, which is noise they cannot act on.
     */
    if (mine === 'true') {
      return { items: await this.dispensing.openForPrescriber(ctx.userId) };
    }

    const parsed = status ? z.enum(['OPEN', 'ANSWERED', 'WITHDRAWN']).safeParse(status) : null;
    return {
      items: await this.dispensing.clarifications({
        status: parsed?.success ? parsed.data : undefined,
      }),
    };
  }

  @RequirePermission('clarification:create')
  @Audit('RX_CLARIFICATION_RAISED', 'clarification')
  @Post('queue/:id/clarifications')
  raise(@Param('id') id: string, @Body() body: unknown) {
    return this.dispensing.raiseClarification(
      requireUuid(id, 'Prescription'),
      parseBody(RaiseClarification, body),
    );
  }

  /** The prescriber's end. `clarification:resolve` is held by DOCTOR only. */
  @RequirePermission('clarification:resolve')
  @Audit('RX_CLARIFICATION_ANSWERED', 'clarification')
  @Post('clarifications/:id/answer')
  answer(@Param('id') id: string, @Body() body: unknown) {
    return this.dispensing.answerClarification(
      requireUuid(id, 'Clarification'),
      parseBody(AnswerClarification, body),
    );
  }

  @RequirePermission('clarification:create')
  @Audit('RX_CLARIFICATION_WITHDRAWN', 'clarification')
  @Post('clarifications/:id/withdraw')
  withdraw(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(ReasonOnly, body);
    return this.dispensing.withdrawClarification(requireUuid(id, 'Clarification'), input.reason);
  }

  /* ---- Stock -------------------------------------------------------------- */

  @RequirePermission('stock:read')
  @Get('stock')
  async batches(
    @Query('productId') productId?: string,
    @Query('search') search?: string,
    @Query('includeEmpty') includeEmpty?: string,
  ) {
    return {
      items: await this.stock.batches({
        productId: productId ? requireUuid(productId, 'Product') : undefined,
        search,
        includeEmpty: includeEmpty === 'true',
      }),
    };
  }

  @RequirePermission('stock:read')
  @Get('stock/movements')
  async movements(
    @Query('stockBatchId') stockBatchId?: string,
    @Query('productId') productId?: string,
  ) {
    return {
      items: await this.stock.movements({
        stockBatchId: stockBatchId ? requireUuid(stockBatchId, 'Batch') : undefined,
        productId: productId ? requireUuid(productId, 'Product') : undefined,
      }),
    };
  }

  @RequirePermission('stock:read')
  @Get('alerts')
  alerts() {
    return this.stock.alerts();
  }

  @RequirePermission('stock:update')
  @Audit('STOCK_ADJUSTED', 'stock')
  @Post('stock/adjust')
  adjust(@Body() body: unknown) {
    return this.stock.adjust(parseBody(AdjustStock, body));
  }

  @RequirePermission('stock:create')
  @Audit('STOCK_OPENING_BALANCE', 'stock')
  @Post('stock/opening-balance')
  opening(@Body() body: unknown) {
    return this.stock.openingBalance(parseBody(OpeningBalance, body));
  }

  /* ---- Products and suppliers --------------------------------------------- */

  @RequirePermission('pharmacyProduct:read')
  @Get('products')
  async products(
    @Query('search') search?: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('lowStockOnly') lowStockOnly?: string,
  ) {
    return {
      items: await this.catalogue.products({
        search,
        includeInactive: includeInactive === 'true',
        lowStockOnly: lowStockOnly === 'true',
      }),
    };
  }

  @RequirePermission('pharmacyProduct:read')
  @Get('products/:id')
  product(@Param('id') id: string) {
    return this.catalogue.product(requireUuid(id, 'Product'));
  }

  @RequirePermission('pharmacyProduct:create')
  @Audit('PHARMACY_PRODUCT_SAVED', 'pharmacyProduct')
  @Post('products')
  saveProduct(@Body() body: unknown) {
    const input = parseBody(SaveProduct.extend({ id: z.string().uuid().optional() }), body);
    return this.catalogue.saveProduct(input);
  }

  @RequirePermission('pharmacyProduct:update')
  @Audit('PHARMACY_PRODUCT_RETIRED', 'pharmacyProduct')
  @Post('products/:id/retire')
  retireProduct(@Param('id') id: string) {
    return this.catalogue.retireProduct(requireUuid(id, 'Product'));
  }

  /** Drug-catalogue entries the pharmacy does not stock yet. */
  @RequirePermission('pharmacyProduct:read')
  @Get('catalogue/unstocked')
  async unstocked(@Query('search') search?: string) {
    return { items: await this.catalogue.unstockedCatalogueItems(search) };
  }

  @RequirePermission('supplier:read')
  @Get('suppliers')
  async suppliers(@Query('includeInactive') includeInactive?: string) {
    return {
      items: await this.catalogue.suppliers({ includeInactive: includeInactive === 'true' }),
    };
  }

  @RequirePermission('supplier:read')
  @Get('suppliers/:id')
  supplier(@Param('id') id: string) {
    return this.catalogue.supplier(requireUuid(id, 'Supplier'));
  }

  @RequirePermission('supplier:create')
  @Audit('SUPPLIER_SAVED', 'supplier')
  @Post('suppliers')
  saveSupplier(@Body() body: unknown) {
    const input = parseBody(SaveSupplier.extend({ id: z.string().uuid().optional() }), body);
    return this.catalogue.saveSupplier(input);
  }

  /* ---- Purchasing --------------------------------------------------------- */

  @RequirePermission('purchaseOrder:read')
  @Get('purchase-orders')
  async orders(@Query('status') status?: string, @Query('supplierId') supplierId?: string) {
    return {
      items: await this.purchasing.orders({
        status,
        supplierId: supplierId ? requireUuid(supplierId, 'Supplier') : undefined,
      }),
    };
  }

  @RequirePermission('purchaseOrder:read')
  @Get('purchase-orders/:id')
  order(@Param('id') id: string) {
    return this.purchasing.order(requireUuid(id, 'Purchase order'));
  }

  @RequirePermission('purchaseOrder:create')
  @Audit('PURCHASE_ORDER_CREATED', 'purchaseOrder')
  @Post('purchase-orders')
  createOrder(@Body() body: unknown) {
    return this.purchasing.createOrder(parseBody(SavePurchaseOrder, body));
  }

  @RequirePermission('purchaseOrder:create')
  @Audit('PURCHASE_ORDER_SUBMITTED', 'purchaseOrder')
  @Post('purchase-orders/:id/submit')
  submitOrder(@Param('id') id: string) {
    return this.purchasing.submitOrder(requireUuid(id, 'Purchase order'));
  }

  /**
   * Authorises the spend. `purchaseOrder:approve` — a permission the pharmacist
   * role does NOT hold by default, so this is the owner's action unless the
   * clinic decides otherwise.
   */
  @RequirePermission('purchaseOrder:approve')
  @Audit('PURCHASE_ORDER_APPROVED', 'purchaseOrder')
  @Post('purchase-orders/:id/approve')
  approveOrder(@Param('id') id: string) {
    return this.purchasing.approveOrder(requireUuid(id, 'Purchase order'));
  }

  @RequirePermission('purchaseOrder:update')
  @Audit('PURCHASE_ORDER_CANCELLED', 'purchaseOrder')
  @Post('purchase-orders/:id/cancel')
  cancelOrder(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(ReasonOnly, body);
    return this.purchasing.cancelOrder(requireUuid(id, 'Purchase order'), input.reason);
  }

  @RequirePermission('purchaseOrder:read')
  @Get('receipts')
  async receipts(@Query('purchaseOrderId') purchaseOrderId?: string) {
    return {
      items: await this.purchasing.receipts({
        purchaseOrderId: purchaseOrderId
          ? requireUuid(purchaseOrderId, 'Purchase order')
          : undefined,
      }),
    };
  }

  /** Receiving is `stock:create`, not `purchaseOrder:*` — it is what makes stock. */
  @RequirePermission('stock:create')
  @Audit('GOODS_RECEIVED', 'stock')
  @Post('receipts')
  receive(@Body() body: unknown) {
    return this.purchasing.receive(parseBody(ReceiveGoods, body));
  }

  @RequirePermission('stock:update')
  @Audit('PURCHASE_RETURNED', 'stock')
  @Post('purchase-returns')
  returnToSupplier(@Body() body: unknown) {
    return this.purchasing.returnToSupplier(parseBody(ReturnToSupplier, body));
  }

  /* ---- Sales -------------------------------------------------------------- */

  @RequirePermission('pharmacySale:read')
  @Get('sales')
  async sales_(
    @Query('patientId') patientId?: string,
    @Query('dispenseRecordId') dispenseRecordId?: string,
  ) {
    return {
      items: await this.sales.sales({
        patientId: patientId ? requireUuid(patientId, 'Patient') : undefined,
        dispenseRecordId: dispenseRecordId
          ? requireUuid(dispenseRecordId, 'Prescription')
          : undefined,
      }),
    };
  }

  /** Prices a completed dispense so the counter can charge it in one step. */
  @RequirePermission('pharmacySale:read')
  @Get('queue/:id/quote')
  quote(@Param('id') id: string) {
    return this.sales.quoteForDispense(requireUuid(id, 'Prescription'));
  }

  @RequirePermission('pharmacySale:create')
  @Audit('PHARMACY_SALE_RECORDED', 'pharmacySale')
  @Post('sales')
  recordSale(@Body() body: unknown) {
    return this.sales.record(parseBody(RecordSale, body));
  }

  @RequirePermission('pharmacySale:update')
  @Audit('PHARMACY_SALE_RETURNED', 'pharmacySale')
  @Post('sales/:id/return')
  returnSale(@Param('id') id: string, @Body() body: unknown) {
    return this.sales.recordReturn(requireUuid(id, 'Sale'), parseBody(ReturnSale, body));
  }

  /* ---- Reporting ---------------------------------------------------------- */

  @RequirePermission('report:read')
  @Get('reports')
  report(@Query('days') days?: string) {
    const parsed = Number(days);
    return this.reports.report(Number.isFinite(parsed) && parsed > 0 ? parsed : 30);
  }
}

@Module({
  controllers: [PharmacyController],
  providers: [
    CatalogueService,
    StockService,
    PurchasingService,
    DispensingService,
    SalesService,
    PharmacyReportsService,
  ],
  /*
   * DispensingService is exported because the CLINICAL module calls `enqueue()`
   * at finalisation — that call is what makes a prescription appear at the
   * counter without anyone retyping it, which is the whole point of the module.
   */
  exports: [DispensingService, StockService],
})
export class PharmacyModule {}
