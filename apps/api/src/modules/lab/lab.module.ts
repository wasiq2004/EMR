import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { EnterLabResult, OrderLabTest } from '@emr/contracts';

import { Audit, RequirePermission, SkipAudit } from '../../common/http/decorators';
import { RequiresFeature } from '../../common/features/feature.guard';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { LabService } from './lab.service';

/**
 * Lab orders and results.
 *
 * Gated on the `lab` feature, like the pharmacy: a clinic that does not order
 * tests should not be shown a review list it will never work, and switching the
 * module on a year later should not surface orders apparently outstanding since
 * last March.
 */
@RequiresFeature('lab')
@Controller()
class LabController {
  constructor(private readonly lab: LabService) {}

  /**
   * Tests matching what is being typed.
   *
   * Exempt from the audit trail: it fires on every keystroke and reads a
   * reference list rather than anybody's record — the same reasoning as the drug
   * and diagnosis searches.
   */
  @RequirePermission('labOrder:read')
  @SkipAudit()
  @Get('lab/tests/search')
  async searchTests(@Query('q') q?: string, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    return {
      items: await this.lab.searchTests(
        q ?? '',
        Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 40) : 12,
      ),
    };
  }

  /**
   * What still needs somebody's attention.
   *
   * `@SkipAudit` because the doctor's dashboard polls it, and it returns counts
   * rather than records. The orders themselves are audited when read.
   */
  @RequirePermission('labOrder:read')
  @SkipAudit()
  @Get('lab/review-summary')
  reviewSummary() {
    return this.lab.reviewSummary();
  }

  @RequirePermission('labOrder:read')
  @Get('lab/orders')
  async list(
    @Query('patientId') patientId?: string,
    @Query('awaiting') awaiting?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    return {
      items: await this.lab.list({
        patientId: patientId ? requireUuid(patientId, 'Patient') : undefined,
        awaitingOnly: awaiting === 'true',
        limit: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
      }),
    };
  }

  @RequirePermission('labOrder:read')
  @Get('lab/orders/:id')
  byId(@Param('id') id: string) {
    return this.lab.byId(requireUuid(id, 'Order'));
  }

  /**
   * Every result ever entered against an order, superseded ones included.
   *
   * Separate from the order read, because "what did it say before" is a
   * different question from "what does it say" — and the ordinary reads
   * deliberately return only the live result so that "the result" is never
   * ambiguous.
   */
  @RequirePermission('labOrder:read')
  @Get('lab/orders/:id/history')
  async history(@Param('id') id: string) {
    return { items: await this.lab.historyFor(requireUuid(id, 'Order')) };
  }

  @RequirePermission('labOrder:create')
  @Audit('LAB_TEST_ORDERED', 'labOrder')
  @Post('lab/orders')
  order(@Body() body: unknown) {
    return this.lab.order(parseBody(OrderLabTest, body));
  }

  /**
   * Records what came back.
   *
   * `labOrder:update`, which the nurse holds without `create`: typing in a
   * report that arrived on paper is clerical work on somebody else's clinical
   * decision. Deciding a test is needed is not.
   */
  @RequirePermission('labOrder:update')
  @Audit('LAB_RESULT_ENTERED', 'labOrder')
  @Post('lab/orders/:id/result')
  enterResult(@Param('id') id: string, @Body() body: unknown) {
    return this.lab.enterResult(requireUuid(id, 'Order'), parseBody(EnterLabResult, body));
  }

  /**
   * Marks a result read.
   *
   * Audited, and the audit entry is the point: an abnormal result that nobody
   * opened is what this module exists to make visible, so a clinic needs to be
   * able to show afterwards who read what and when.
   */
  @RequirePermission('labOrder:update')
  @Audit('LAB_RESULT_REVIEWED', 'labOrder')
  @Post('lab/orders/:id/review')
  review(@Param('id') id: string) {
    return this.lab.review(requireUuid(id, 'Order'));
  }

  @RequirePermission('labOrder:update')
  @Audit('LAB_ORDER_CANCELLED', 'labOrder')
  @Post('lab/orders/:id/cancel')
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.lab.cancel(requireUuid(id, 'Order'), String(body?.reason ?? '').trim());
  }
}

@Module({
  controllers: [LabController],
  providers: [LabService],
  exports: [LabService],
})
export class LabModule {}
