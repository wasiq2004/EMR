import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Audit, RequirePermission } from '../../common/http/decorators';
import { requireUuid } from '../../common/http/zod.pipe';
import { CommsService } from './comms.service';

@Controller()
export class CommsController {
  constructor(private readonly comms: CommsService) {}

  @RequirePermission('communication:read')
  @Get('inbox/conversations')
  async list(@Query('filter') filter?: string) {
    return { items: await this.comms.conversations(filter) };
  }

  @RequirePermission('communication:read')
  @Get('inbox/conversations/:id')
  one(@Param('id') id: string) {
    return this.comms.conversation(requireUuid(id, 'Conversation'));
  }

  @RequirePermission('communication:create')
  @Audit('MESSAGE_SENT', 'communication')
  @Post('inbox/conversations/:id/reply')
  reply(@Param('id') id: string, @Body() body: { body: string; templateName?: string | null }) {
    return this.comms.reply(
      requireUuid(id, 'Conversation'),
      String(body?.body ?? '').trim(),
      body?.templateName ?? null,
    );
  }

  @RequirePermission('communication:create')
  @Audit('CONVERSATION_LINKED', 'communication')
  @Post('inbox/conversations/:id/link')
  link(@Param('id') id: string, @Body() body: { patientId: string }) {
    return this.comms.link(
      requireUuid(id, 'Conversation'),
      requireUuid(body?.patientId, 'Patient'),
    );
  }

  @RequirePermission('communication:read')
  @Get('whatsapp/account')
  account() {
    return this.comms.account();
  }

  /**
   * Approved templates.
   *
   * Two are kept per purpose: the provider can reject or pause one without
   * warning and retroactively, and a single template per purpose would mean one
   * rejection takes that channel down entirely.
   */
  @RequirePermission('communication:read')
  @Get('whatsapp/templates')
  templates() {
    return { items: [] };
  }
}
