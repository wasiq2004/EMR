import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { z } from 'zod';

import { Audit, RequirePermission } from '../../common/http/decorators';
import { parseBody } from '../../common/http/zod.pipe';
import { WhatsAppClient } from './whatsapp.client';
import { WhatsAppAccountService } from './whatsapp-account.service';

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

@Module({
  controllers: [WhatsAppController],
  providers: [WhatsAppClient, WhatsAppAccountService],
  exports: [WhatsAppClient, WhatsAppAccountService],
})
export class MessagingModule {}
