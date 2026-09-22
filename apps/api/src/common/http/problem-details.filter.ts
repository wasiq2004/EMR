import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { TenantContext } from '../tenancy/tenant-context';

/**
 * Every error leaves as an RFC 9457 problem document.
 *
 * Two rules:
 *   - Nothing internal crosses the boundary. No SQL, no stack, no row ids the
 *     caller was not already entitled to see.
 *   - The message says what to do next. "Someone else changed this record while
 *     you were editing. Reload to see their version." beats "Conflict".
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply | ServerResponse>();
    const request = http.getRequest<FastifyRequest | IncomingMessage>();
    const requestId = TenantContext.get()?.requestId;
    const url = request.url ?? '';
    const method = request.method ?? 'GET';

    if (exception instanceof ZodError) {
      const errors: Record<string, string[]> = {};
      for (const issue of exception.issues) {
        const key = issue.path.join('.') || '_';
        (errors[key] ??= []).push(issue.message);
      }
      return send(reply, 422, {
        type: 'about:blank',
        title: 'Some details need correcting',
        status: 422,
        detail: 'Check the highlighted fields and try again.',
        errors,
        instance: url,
        requestId,
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const body =
        typeof response === 'object' && response !== null
          ? (response as Record<string, unknown>)
          : {};

      return send(reply, status, {
        type: 'about:blank',
        title: (body.title as string) ?? titleFor(status),
        status,
        detail: (body.message as string) ?? exception.message,
        ...(body.code ? { code: body.code } : {}),
        // Forwarded by name, never by spreading the thrown body. A refusal is
        // often the most useful response the client gets — a prescription
        // blocked on an allergy has to render as a warning card with the
        // substance and its criticality, not as a sentence — but only these
        // keys cross the boundary, so a future thrower cannot leak internals by
        // attaching them to an exception.
        ...(body.errors ? { errors: body.errors } : {}),
        ...(body.warnings ? { warnings: body.warnings } : {}),
        ...(body.duplicates ? { duplicates: body.duplicates } : {}),
        instance: url,
        requestId,
      });
    }

    // Unexpected. Log everything, disclose nothing.
    this.logger.error(
      `Unhandled error on ${method} ${url} (request ${requestId})`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    return send(reply, HttpStatus.INTERNAL_SERVER_ERROR, {
      type: 'about:blank',
      title: 'Something went wrong at our end',
      status: 500,
      detail: 'The problem has been recorded. Try again in a moment.',
      instance: url,
      requestId,
    });
  }
}

/**
 * Write the document, whichever response object this is.
 *
 * An exception raised inside a controller arrives here with a FastifyReply. One
 * raised inside middleware arrives with the raw Node ServerResponse, because
 * Nest runs middleware through middie, below the layer where Fastify decorates
 * the reply. Both paths have to produce the same document — an error from the
 * tenant middleware is exactly the kind the browser most needs to parse.
 */
function send(
  reply: FastifyReply | ServerResponse,
  status: number,
  body: Record<string, unknown>,
) {
  const CONTENT_TYPE = 'application/problem+json; charset=utf-8';

  if (typeof (reply as FastifyReply).status === 'function') {
    return (reply as FastifyReply).status(status).type(CONTENT_TYPE).send(body);
  }

  const raw = reply as ServerResponse;
  if (raw.headersSent) return;
  raw.statusCode = status;
  raw.setHeader('content-type', CONTENT_TYPE);
  raw.end(JSON.stringify(body));
}

function titleFor(status: number): string {
  switch (status) {
    case 400: return 'That request could not be understood';
    case 401: return 'Please sign in again';
    case 403: return 'Not permitted';
    case 404: return 'Not found';
    case 409: return 'Someone else changed this record';
    case 422: return 'Some details need correcting';
    case 429: return 'Too many attempts';
    default: return 'Request failed';
  }
}
