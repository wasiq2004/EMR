import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Audit, RequirePermission } from '../../common/http/decorators';
import { RequiresFeature } from '../../common/features/feature.guard';
import { requireUuid } from '../../common/http/zod.pipe';
import { CommsService } from './comms.service';

@RequiresFeature('whatsapp')
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
  reply(
    @Body()
    body: {
      body?: string;
      templateId?: string | null;
      templateVariables?: Record<string, string>;
    },
    @Param('id') id: string,
  ) {
    return this.comms.reply(requireUuid(id, 'Conversation'), {
      body: body?.body,
      templateId: body?.templateId ?? null,
      templateVariables: body?.templateVariables,
    });
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

}
