/**
 * Global authorisation guard.
 *
 * Registered as an APP_GUARD in main.ts, so it applies to every route in the
 * application. A route that declares neither @RequirePermission nor @Public is
 * DENIED — the safe default. This means adding a new controller without
 * thinking about authorisation produces a 403, not an open endpoint.
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { TenantContext } from '../tenancy/tenant-context';
import {
  can,
  REQUIRES_MEDICAL_REGISTRATION,
  type Permission,
} from './permissions';
import { PractitionerCredentialCache } from './practitioner-credential.cache';

export const PERMISSION_KEY = 'rbac:permission';
export const PUBLIC_KEY = 'rbac:public';
export const AUTHENTICATED_KEY = 'rbac:authenticated';

/**
 * Declares the permission a route requires.
 * @example @RequirePermission('prescription:sign')
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);

/**
 * Marks a route as reachable without authentication.
 *
 * Every use of this decorator is enumerated in the security review checklist
 * and counted by a CI test, so a new unauthenticated endpoint cannot be added
 * silently. Legitimate uses: login, token refresh, the WhatsApp webhook, the
 * public share-link resolver, and health checks.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Marks a route that requires a session but no particular permission.
 *
 * A small, closed set: reading your own session, signing out, and the routes
 * that every role needs regardless of what it may do. These are not @Public —
 * an anonymous caller is still refused — and inventing a permission like
 * `session:read` that is granted to every role would add a row to the
 * permission matrix that can only ever say yes, which makes the matrix harder
 * to audit rather than easier.
 */
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);

@Injectable()
export class RbacGuard implements CanActivate {
  private readonly logger = new Logger(RbacGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly credentials: PractitionerCredentialCache,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, controller])) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      [handler, controller],
    );

    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(
      AUTHENTICATED_KEY,
      [handler, controller],
    );

    if (authenticatedOnly && !required) {
      if (!TenantContext.get()) {
        throw new UnauthorizedException('Authentication required.');
      }
      return true;
    }

    /**
     * DENY BY DEFAULT. An undeclared route is a developer oversight, and the
     * correct response to an oversight in an authorisation layer is refusal.
     */
    if (!required) {
      this.logger.error(
        `Route ${controller.name}.${handler.name} declares no permission and is ` +
          `not @Public(). Denying. Add @RequirePermission(...) to expose it.`,
      );
      throw new ForbiddenException('This operation is not available.');
    }

    const ctx = TenantContext.get();
    if (!ctx) {
      throw new UnauthorizedException('Authentication required.');
    }

    if (!can(ctx.role, required)) {
      // Logged at warning level and recorded by the audit interceptor as
      // SERIOUS_FAILURE — repeated denials for one actor indicate either a
      // broken UI or an attempt to escalate.
      this.logger.warn(
        `RBAC denied: role=${ctx.role} permission=${required} ` +
          `user=${ctx.userId} clinic=${ctx.clinicId} request=${ctx.requestId}`,
      );
      throw new ForbiddenException(
        `Your role (${ctx.role}) is not permitted to perform this action.`,
      );
    }

    /**
     * Second gate for legally significant clinical acts.
     *
     * Holding the DOCTOR role is not sufficient to sign a prescription — the
     * practitioner must have a medical registration number on file, because it
     * is a required element of a valid Indian e-prescription and would
     * otherwise print blank on a legal document.
     */
    if (REQUIRES_MEDICAL_REGISTRATION.has(required)) {
      const registration = await this.credentials.getRegistrationNumber(
        ctx.clinicId,
        ctx.userId,
      );

      if (!registration) {
        throw new ForbiddenException(
          'A medical registration number must be recorded on your profile ' +
            'before you can sign clinical records. Please contact your ' +
            'practice administrator.',
        );
      }
    }

    return true;
  }
}
