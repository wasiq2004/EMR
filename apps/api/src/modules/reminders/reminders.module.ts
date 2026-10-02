import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { Audit, Public, RequirePermission, SkipAudit } from '../../common/http/decorators';
import { SaveReminderSettings } from '@emr/contracts';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { MessagingModule } from '../messaging/messaging.module';
import { PlatformModule } from '../platform/platform.module';
import { JobsGuard } from './jobs.guard';
import { RemindersService } from './reminders.service';

/**
 * Follow-up reminders: the log a clinic reads, and the endpoint a cron calls.
 */
@Controller()
class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  /**
   * Sends every reminder that is due, across every clinic.
   *
   * `@Public()` because there is no user: the caller is a cron line, and
   * `JobsGuard` authenticates it with a shared secret. See that file for exactly
   * what the secret can and cannot do — it is narrow on purpose.
   *
   * SAFE TO CALL AS OFTEN AS YOU LIKE. Rows are claimed with
   * `UPDATE ... WHERE status = 'PENDING' ... FOR UPDATE SKIP LOCKED` before
   * anything is sent, and the send carries an idempotency key derived from the
   * reminder's id. Two overlapping runs take disjoint sets, and even a claim
   * that raced cannot produce two messages. Running it every five minutes is
   * fine; running it twice at once is fine.
   *
   * Exempt from the audit interceptor because it has no actor to attribute an
   * entry to. What it did is recorded on the reminder rows and in the
   * `communication` rows, which is where anybody would look.
   */
  @Public()
  @SkipAudit()
  @UseGuards(JobsGuard)
  @Post('jobs/run-due')
  runDue() {
    return this.reminders.runDue();
  }

  /* --- Settings --------------------------------------------------------- */

  /**
   * Whether reminders are on, when they go out, and where a copy goes.
   *
   * `clinic:read`, because this is clinic configuration rather than anybody's
   * record. Reception can see what the clinic sends; only an administrator can
   * change it.
   */
  @RequirePermission('clinic:read')
  @Get('settings/reminders')
  settings() {
    return this.reminders.readSettings();
  }

  /**
   * Saves them.
   *
   * Audited as a clinic change. Turning the admin copy on means a patient's name
   * and follow-up date start leaving the record to a second phone number, which
   * is a decision somebody should be able to find later.
   */
  @RequirePermission('clinic:update')
  @Audit('REMINDER_SETTINGS_SAVED', 'clinic')
  @Post('settings/reminders')
  saveSettings(@Body() body: unknown) {
    return this.reminders.saveSettings(parseBody(SaveReminderSettings, body));
  }

  /**
   * What has been scheduled and what became of it.
   *
   * `communication:read` rather than a new permission: a reminder is a message
   * the clinic sent, and the people who may see the message log are the people
   * who may see this.
   */
  @RequirePermission('communication:read')
  @Get('reminders')
  async list(@Query('patientId') patientId?: string, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    return {
      items: await this.reminders.list({
        patientId: patientId ? requireUuid(patientId, 'Patient') : undefined,
        limit: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
      }),
    };
  }

  /**
   * Stops a reminder that has not gone out.
   *
   * `communication:create`, because cancelling is a decision about what the
   * clinic sends rather than a read. A reminder already sent cannot be
   * cancelled; the service refuses it rather than rewriting what the patient
   * received.
   */
  @RequirePermission('communication:create')
  @Audit('REMINDER_CANCELLED', 'communication')
  @Post('reminders/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.reminders.cancel(requireUuid(id, 'Reminder'));
  }
}

@Module({
  /*
   * `MessagingModule` for the WhatsApp client and the credential reader — the
   * two things it exports. `PlatformModule` for `PlatformDbService`, which is
   * the only way to enumerate clinics; see `runDue` for why that is not a
   * tenant-boundary crossing.
   */
  imports: [MessagingModule, PlatformModule],
  controllers: [RemindersController],
  providers: [RemindersService, JobsGuard],
  exports: [RemindersService],
})
export class RemindersModule {}
