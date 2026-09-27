import { Body, Controller, Get, HttpCode, Module, Param, Post } from '@nestjs/common';
import { z } from 'zod';

import { Audit, RequirePermission, SkipAudit } from '../../common/http/decorators';
import { RequiresFeature } from '../../common/features/feature.guard';
import { parseBody } from '../../common/http/zod.pipe';
import { WhatsAppClient } from './whatsapp.client';
import { WhatsAppAccountService } from './whatsapp-account.service';
import { AudienceService, type AudienceFilter } from './audience.service';
import { BroadcastService } from './broadcast.service';
import { requireUuid } from '../../common/http/zod.pipe';

/**
 * Connecting a WhatsApp number and keeping its templates in step.
 *
 * Everything here is `communication:configure`, which only a Clinic Admin
 * holds. A receptionist sends messages all day and must never be able to
 * repoint the clinic's number at a different WhatsApp Business account.
 */

const ConnectWhatsApp = z.object({
  wabaId: z
    .string()
    .trim()
    .min(5, 'Enter the WhatsApp Business Account ID')
    .regex(/^\d+$/, 'The WABA ID is all digits — copy it from Meta Business Manager'),
  phoneNumberId: z
    .string()
    .trim()
    .min(5, 'Enter the Phone Number ID')
    .regex(/^\d+$/, 'The Phone Number ID is all digits — it is not the phone number itself'),
  accessToken: z.string().trim().min(20, 'Enter the permanent access token'),
});

@RequiresFeature('whatsapp')
@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly accounts: WhatsAppAccountService) {}

  /** The connected number. Readable by anyone who can use the inbox. */
  @RequirePermission('communication:read')
  @Get('account')
  account() {
    return this.accounts.current();
  }

  @RequirePermission('communication:configure')
  @Audit('WHATSAPP_CONNECTED', 'whatsapp_account')
  @Post('account')
  connect(@Body() body: unknown) {
    return this.accounts.connect(parseBody(ConnectWhatsApp, body));
  }

  @RequirePermission('communication:configure')
  @Audit('WHATSAPP_DISCONNECTED', 'whatsapp_account')
  @Post('account/disconnect')
  disconnect() {
    return this.accounts.disconnect();
  }

  /**
   * Approved templates.
   *
   * The provider can reject or pause one retroactively and without warning, so
   * a clinic should keep two per purpose: a single template per purpose means
   * one rejection takes that whole channel down.
   */
  @RequirePermission('communication:read')
  @Get('templates')
  async templates() {
    return { items: await this.accounts.templates() };
  }

  @RequirePermission('communication:configure')
  @Audit('WHATSAPP_TEMPLATES_SYNCED', 'message_template')
  @Post('templates/sync')
  sync() {
    return this.accounts.syncTemplates();
  }
}

const Purpose = z.enum(['CLINICAL', 'MARKETING']);

const Audience = z.object({
  tags: z.array(z.string()).optional(),
  seenWithinDays: z.number().int().positive().optional(),
  notSeenForDays: z.number().int().positive().optional(),
  ageMin: z.number().int().min(0).max(130).optional(),
  ageMax: z.number().int().min(0).max(130).optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  patientIds: z.array(z.string().uuid()).optional(),
});

const CreateBroadcast = z.object({
  name: z.string().trim().min(2, 'Give this broadcast a name you will recognise later'),
  templateId: z.string().uuid('Choose a template'),
  purpose: Purpose,
  audienceFilter: Audience,
  templateVariables: z.record(z.string(), z.string()).optional(),
});

/**
 * Broadcasts.
 *
 * Everything that reaches more than one patient is `communication:broadcast`,
 * which only a Clinic Admin holds. The blast radius is categorically different
 * from a reply: a mistake in one message reaches one person, and a mistake here
 * reaches the register.
 */
@RequiresFeature('broadcasts')
@Controller('broadcasts')
export class BroadcastController {
  constructor(private readonly broadcasts: BroadcastService) {}

  @RequirePermission('communication:broadcast')
  @Get()
  async list() {
    return { items: await this.broadcasts.list() };
  }

  /**
   * Counts who a filter would reach WITHOUT creating anything.
   *
   * A POST because the filter is a structured body rather than a handful of
   * query parameters, and because an audience query over the whole register is
   * not something to leave in a browser history.
   */
  @RequirePermission('communication:broadcast')
  @SkipAudit()
  // 200, not the 201 Nest gives a POST by default. Nothing is created here —
  // this is a question, and it is a POST only because the filter is a
  // structured body that has no business sitting in a browser history.
  @HttpCode(200)
  @Post('preview')
  preview(@Body() body: unknown) {
    const input = parseBody(
      z.object({ purpose: Purpose, audienceFilter: Audience }),
      body,
    );
    return this.broadcasts.preview(input.audienceFilter as AudienceFilter, input.purpose);
  }

  @RequirePermission('communication:broadcast')
  @Audit('BROADCAST_CREATED', 'broadcast')
  @Post()
  create(@Body() body: unknown) {
    const input = parseBody(CreateBroadcast, body);
    return this.broadcasts.create({
      ...input,
      audienceFilter: input.audienceFilter as AudienceFilter,
    });
  }

  @RequirePermission('communication:broadcast')
  @Get(':id')
  byId(@Param('id') id: string) {
    return this.broadcasts.byId(requireUuid(id, 'Broadcast'));
  }

  @RequirePermission('communication:broadcast')
  @Get(':id/recipients')
  async recipients(@Param('id') id: string) {
    return { items: await this.broadcasts.recipients(requireUuid(id, 'Broadcast')) };
  }

  /** One message to one number, so the author sees the real thing first. */
  @RequirePermission('communication:broadcast')
  @Audit('BROADCAST_TEST_SENT', 'broadcast')
  @Post(':id/test')
  test(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(
      z.object({ toE164: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Enter a number in +91… form') }),
      body,
    );
    return this.broadcasts.test(requireUuid(id, 'Broadcast'), input.toE164);
  }

  @RequirePermission('communication:broadcast')
  @Audit('BROADCAST_SENT', 'broadcast')
  @Post(':id/send')
  send(@Param('id') id: string) {
    return this.broadcasts.send(requireUuid(id, 'Broadcast'));
  }

  @RequirePermission('communication:broadcast')
  @Audit('BROADCAST_RETRIED', 'broadcast')
  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.broadcasts.retry(requireUuid(id, 'Broadcast'));
  }

  @RequirePermission('communication:broadcast')
  @Audit('BROADCAST_CANCELLED', 'broadcast')
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.broadcasts.cancel(
      requireUuid(id, 'Broadcast'),
      body?.reason?.trim() || 'Cancelled by an administrator',
    );
  }
}

@Module({
  controllers: [WhatsAppController, BroadcastController],
  providers: [WhatsAppClient, WhatsAppAccountService, AudienceService, BroadcastService],
  exports: [WhatsAppClient, WhatsAppAccountService],
})
export class MessagingModule {}
