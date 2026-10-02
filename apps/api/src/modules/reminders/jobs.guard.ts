import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import { config } from '../../config';

/**
 * Authenticates the scheduler, and nothing else.
 *
 * WHY A SHARED SECRET RATHER THAN A SESSION. The reminder runner is a cron line.
 * It has no user, and therefore no clinic — the whole point is that it works
 * across every tenant. Every other guard in this product answers "which clinic
 * is this person in", which is the wrong question here. `PlatformGuard` needs an
 * operator session cookie, which a cron job cannot hold.
 *
 * WHAT THAT SECRET CAN DO, stated precisely, because a cross-tenant credential
 * deserves it. It authorises exactly one endpoint. That endpoint takes no
 * parameters, names no clinic, names no patient, and returns five integers. It
 * cannot read a record, cannot write one except through the reminder runner's
 * own path, and the runner itself works inside `runAs(clinicId)` under ordinary
 * RLS for every clinic it touches. A leaked `JOBS_SECRET` lets somebody make the
 * clinic's reminders go out early. It does not let them read anything.
 *
 * AN UNSET SECRET DISABLES THE ENDPOINT. It does not leave it open, and it does
 * not fall back to allowing localhost. A deployment with no scheduler is a
 * legitimate configuration — most clinics on this product have not connected
 * WhatsApp — and the failure mode of "empty secret matches an empty header" is
 * the kind of hole nobody finds until it is used.
 */
@Injectable()
export class JobsGuard implements CanActivate {
  private readonly logger = new Logger(JobsGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const expected = config.JOBS_SECRET;

    if (!expected) {
      this.logger.warn(
        'A job endpoint was called but JOBS_SECRET is not set, so it is disabled.',
      );
      throw new UnauthorizedException(
        'Job endpoints are disabled: this deployment has no JOBS_SECRET configured.',
      );
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!presented || !constantTimeEqual(presented, expected)) {
      // Deliberately not logged with the value, and deliberately not
      // distinguishing "no header" from "wrong secret" in the response.
      this.logger.warn('A job endpoint was called with a bad or missing secret.');
      throw new UnauthorizedException('Not authorised.');
    }

    return true;
  }
}

/**
 * Compares without leaking the answer through timing.
 *
 * A plain `===` on a secret returns as soon as two bytes differ, which over
 * enough requests reveals the secret a character at a time. The length is
 * checked first and separately because `timingSafeEqual` throws on mismatched
 * lengths — so lengths are compared normally, which leaks only the length.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
