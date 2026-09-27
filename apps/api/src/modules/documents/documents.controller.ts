import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CreateShareLink } from '@emr/contracts';
import { Audit, Public, RequirePermission } from '../../common/http/decorators';
import { RequiresFeature } from '../../common/features/feature.guard';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { ShareLinkService } from '../../common/storage/share-link.service';
import { DocumentsService } from './documents.service';

@RequiresFeature('documents')
@Controller()
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly shareLinks: ShareLinkService,
  ) {}

  @RequirePermission('document:read')
  @Get('documents')
  async list(@Query('patientId') patientId?: string, @Query('q') q?: string) {
    return { items: await this.documents.list({ patientId, q }) };
  }

  @RequirePermission('document:read')
  @Get('documents/:id')
  byId(@Param('id') id: string) {
    return this.documents.byId(requireUuid(id, 'Document'));
  }

  @RequirePermission('document:read')
  @Audit('DOCUMENT_DOWNLOADED', 'document')
  @Get('documents/:id/download')
  async download(@Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    const file = await this.documents.download(requireUuid(id, 'Document'));
    void res.header('Content-Type', file.mimeType);
    void res.header('Content-Disposition', `inline; filename="${encodeURIComponent(file.title)}"`);
    return file.body;
  }

  @RequirePermission('document:share')
  @Audit('DOCUMENT_SHARE_LINK_CREATED', 'document')
  @Post('documents/:id/share')
  share(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(CreateShareLink.omit({ documentId: true }), body);
    return this.shareLinks.create({ documentId: requireUuid(id, 'Document'), ...input });
  }

  @RequirePermission('document:share')
  @Audit('SHARE_LINK_REVOKED', 'document')
  @Post('share-links/:id/revoke')
  @HttpCode(204)
  async revoke(@Param('id') id: string) {
    await this.shareLinks.revoke(requireUuid(id, 'Share link'));
  }

  /**
   * The public resolver.
   *
   * Unauthenticated by necessity — the recipient is a patient or a referred
   * consultant, not a user of this system. Every failure mode returns the same
   * message so the endpoint cannot be used to discover which links exist.
   */
  @Public()
  @Post('share/:token')
  async resolve(
    @Param('token') token: string,
    @Body() body: { otp?: string | null },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const file = await this.shareLinks.resolve(
      token,
      body?.otp ?? undefined,
      req.ip ?? 'unknown',
      (req.headers['user-agent'] as string | undefined) ?? null,
    );

    void res.header('Content-Type', 'application/json');
    return { title: file.title, mimeType: file.mimeType };
  }

  @Public()
  @Get('share/:token/file')
  async file(
    @Param('token') token: string,
    @Query('otp') otp: string | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const file = await this.shareLinks.resolve(
      token,
      otp,
      req.ip ?? 'unknown',
      (req.headers['user-agent'] as string | undefined) ?? null,
    );

    void res.header('Content-Type', file.mimeType);
    void res.header('Content-Disposition', `inline; filename="${encodeURIComponent(file.title)}"`);
    return file.body;
  }
}
