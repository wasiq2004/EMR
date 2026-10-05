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
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CreateShareLink, DocumentType } from '@emr/contracts';
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

  /**
   * Stores a file against a patient.
   *
   * WHY THIS ROUTE DID NOT EXIST, and why that mattered: `DocumentsService.upload`
   * has been written, tenant-scoped and virus-scan-aware since the module
   * shipped, `StorageService.put` enforced the MIME allowlist and the size cap,
   * and there was no way to reach either. The Upload button on a patient's
   * documents tab was dead because there was nothing to call. A clinic could not
   * attach a scanned report, an outside lab result, or a consent form — which for
   * a paper-heavy Indian outpatient practice is most of what a patient's file
   * consists of.
   *
   * MULTIPART, NOT BASE64 JSON. A 25 MB file is 34 MB of base64, which is over
   * the 30 MB body limit, so the JSON route would have silently capped uploads
   * around 22 MB with a confusing error at the boundary. It would also have held
   * the encoded copy and the decoded copy in memory at once.
   *
   * THE FIELD ORDER IN THE REQUEST IS NOT GUARANTEED, so the fields are read
   * from the parsed parts rather than assumed to precede the file. A client that
   * sends the file first is a valid client.
   *
   * PATIENT_UPLOAD is refused rather than defaulted to — see below for why the
   * apparently safer choice is the broken one.
   */
  @RequirePermission('document:create')
  @Audit('DOCUMENT_UPLOADED', 'document')
  @Post('documents')
  async upload(@Req() req: FastifyRequest) {
    if (!req.isMultipart()) {
      throw new UnprocessableEntityException({
        title: 'Send the file as a form',
        message: 'Attach the file as multipart/form-data rather than JSON.',
      });
    }

    const file = await req.file();
    if (!file) {
      throw new UnprocessableEntityException({
        title: 'No file attached',
        message: 'Choose a file to upload.',
      });
    }

    const body = await file.toBuffer();

    /*
     * Fastify truncates at the limit rather than throwing, so a file over the
     * cap arrives as a short buffer and `truncated` is the only way to know.
     * Storing it would mean a document that opens as a corrupt half-page, which
     * is worse than a refusal: nobody would know it was incomplete.
     */
    if (file.file.truncated) {
      throw new UnprocessableEntityException({
        title: 'That file is too large',
        message: 'Files are limited to 25 MB. Scan at a lower resolution and try again.',
      });
    }
    if (body.byteLength === 0) {
      throw new UnprocessableEntityException({
        title: 'That file is empty',
        message: 'The file did not contain anything. Check it opens before uploading.',
      });
    }

    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    const field = (name: string): string | null => {
      const part = fields[name];
      const value = part && 'value' in part ? part.value : undefined;
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };

    const patientId = field('patientId');
    if (!patientId) {
      throw new UnprocessableEntityException({
        title: 'Whose document is this?',
        message: 'A document has to belong to a patient.',
      });
    }

    const parsedType = DocumentType.safeParse(field('documentType') ?? 'OTHER');
    if (!parsedType.success) {
      throw new UnprocessableEntityException({
        title: 'Unknown document type',
        message: 'That is not a kind of document this clinic files.',
      });
    }

    /*
     * PATIENT_UPLOAD IS REFUSED HERE, and the reason is worth stating plainly
     * because the restrictive-looking choice would be the broken one.
     *
     * That type is the only one that starts PENDING a virus scan, and both
     * `DocumentsService.download` and `ShareLinkService.resolve` refuse anything
     * PENDING. NOTHING IN THIS SYSTEM EVER SETS `CLEAN` — there is no scanner
     * wired up yet. So a file filed as PATIENT_UPLOAD would upload successfully
     * and then be permanently unopenable and unshareable, by design, with no way
     * to promote it. Accepting it would be writing data that cannot be read.
     *
     * The gate itself is right and stays: a file arriving from outside the
     * clinic should not be served to anyone until something has looked at it.
     * What is missing is the scanner, not the check. Until it exists, the type
     * is unreachable rather than quietly accepted.
     *
     * This route is a member of staff attaching a file from the clinic's own
     * machine — a scanned lab report, a referral letter, a signed consent form.
     * Those carry a null scan status, which both readers treat as scanned-not-
     * required, and that is the honest classification for a file the clinic
     * produced itself.
     */
    if (parsedType.data === 'PATIENT_UPLOAD') {
      throw new UnprocessableEntityException({
        title: 'Patient uploads are not accepted yet',
        message:
          'Files sent in by patients are held until a security scan clears them, ' +
          'and scanning is not set up on this deployment. File it as the kind of ' +
          'document it is — a lab report, a referral letter — if a member of ' +
          'staff is attaching it.',
      });
    }

    const encounterId = field('encounterId');

    return this.documents.upload({
      patientId: requireUuid(patientId, 'Patient'),
      encounterId: encounterId ? requireUuid(encounterId, 'Consultation') : null,
      documentType: parsedType.data,
      /*
       * The filename is the fallback title, not the title. "IMG_20260104.jpg"
       * tells a clinician nothing, so the form asks for a description — but a
       * filename is better than an empty row if they skipped it.
       */
      title: field('title') ?? file.filename ?? 'Untitled document',
      mimeType: file.mimetype,
      body,
    });
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
