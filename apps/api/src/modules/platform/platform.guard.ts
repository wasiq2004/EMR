import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { TokenService } from '../../common/auth/token.service';

export const PLATFORM_COOKIE = 'emr_platform';
export const PLATFORM_ROLE_KEY = 'platform:role';

export type PlatformRole = 'SUPPORT' | 'OPERATOR' | 'PLATFORM_ADMIN';

export interface PlatformActor {
  userId: string;
  name: string;
  role: PlatformRole;
}

/**
 * What a platform route requires.
 *
 * Three levels, and the split is deliberate: reading the estate and changing it
 * are different authorities. Support staff answering "is their clinic up?"
 * should not also be able to suspend it.
 */
export const RequirePlatformRole = (...roles: PlatformRole[]) =>
  SetMetadata(PLATFORM_ROLE_KEY, roles);

const RANK: Record<PlatformRole, number> = {
  SUPPORT: 0,
  OPERATOR: 1,
  PLATFORM_ADMIN: 2,
};

/**
 * The platform guard.
 *
 * Separate from RbacGuard in every respect: its own cookie, its own token
 * audience, its own role vocabulary. A clinic session cannot satisfy it and a
 * platform session cannot satisfy RbacGuard — verified by the audience check in
 * TokenService, not by the shape of the claims.
 *
 * DENY BY DEFAULT, like the clinic guard. A platform route that declares no
 * role is unreachable rather than open to the lowest one.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PlatformRole[] | undefined>(
      PLATFORM_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      throw new ForbiddenException('This operation is not available.');
    }

    const request = context.switchToHttp().getRequest<
      FastifyRequest & { cookies?: Record<string, string>; platformActor?: PlatformActor }
    >();

    const token = request.cookies?.[PLATFORM_COOKIE];
    if (!token) throw new UnauthorizedException('Sign in to the operations console.');

    const claims = await this.tokens.verifyPlatformToken(token);
    if (!claims) throw new UnauthorizedException('Sign in to the operations console.');

    // The lowest role that satisfies the requirement. Declaring OPERATOR means
    // PLATFORM_ADMIN passes too, which is what "rank" is for.
    const floor = Math.min(...required.map((role) => RANK[role]));
    if (RANK[claims.role] < floor) {
      throw new ForbiddenException(
        `Your role (${claims.role}) is not permitted to perform this action.`,
      );
    }

    request.platformActor = {
      userId: claims.sub,
      name: claims.name,
      role: claims.role,
    };

    return true;
  }
}
