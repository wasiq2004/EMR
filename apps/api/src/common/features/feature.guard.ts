import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { type FeatureKey, resolveFeatures } from '@emr/contracts';

import { TenantDb } from '../tenancy/tenant-db.service';
import { TenantContext } from '../tenancy/tenant-context';

export const FEATURE_KEY = 'feature:required';

/**
 * Declares that a route needs a feature the clinic's plan must include.
 *
 * @example @RequiresFeature('broadcasts')
 */
export const RequiresFeature = (feature: FeatureKey) => SetMetadata(FEATURE_KEY, feature);

/**
 * Enforces plan features on the server.
 *
 * THE WHOLE POINT IS THAT THIS IS NOT COSMETIC. Hiding a menu item is a
 * suggestion; anyone who has seen a URL can still call the endpoint, and a
 * clinic that lost a module at renewal would keep using it from a bookmark.
 * The console configures what a clinic has bought, and this is where that
 * configuration becomes true.
 *
 * Registered globally, so a route without `@RequiresFeature` is unaffected —
 * unlike the RBAC guard, which denies by default. That difference is
 * deliberate: every route needs an authorisation decision, but most routes are
 * not part of an optional module, and requiring a feature declaration on
 * `/patients` would be noise that teaches people to add decorators without
 * thinking.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  /**
   * Features per clinic, briefly.
   *
   * This runs on every request to a gated route, and the alternative is two
   * extra queries per call. Thirty seconds means a plan change takes effect
   * while the operator is still looking at the screen.
   */
  private readonly cache = new Map<
    string,
    { features: Record<FeatureKey, boolean>; expiresAt: number }
  >();
  private static readonly TTL_MS = 30_000;

  constructor(
    private readonly reflector: Reflector,
    private readonly tenantDb: TenantDb,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<FeatureKey | undefined>(FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required) return true;

    const ctx = TenantContext.get();
    // No tenant context means the RBAC guard has already refused, or will.
    // Nothing useful to decide here.
    if (!ctx) return true;

    const features = await this.featuresFor(ctx.clinicId);

    if (!features[required]) {
      throw new ForbiddenException({
        code: 'FEATURE_NOT_AVAILABLE',
        title: 'Not included in this plan',
        message:
          'This part of the product is not enabled for your clinic. Your administrator can ask us to add it.',
      });
    }

    return true;
  }

  /** Drops a clinic's entry so a plan change applies immediately. */
  invalidate(clinicId: string): void {
    this.cache.delete(clinicId);
  }

  /**
   * Asks the same question a decorator asks, from ordinary code.
   *
   * Needed where a feature changes what a handler DOES rather than whether it may
   * run at all — finalising a consultation queues the prescription for the
   * pharmacy counter, and must not do so at a clinic that has no counter. A
   * decorator cannot express that: the route is `encounter:finalize`, which every
   * clinic has, and only one step inside it is conditional.
   *
   * Reads through the same cache as the guard, so it costs nothing extra on a
   * busy path.
   */
  async clinicHas(clinicId: string, feature: FeatureKey): Promise<boolean> {
    const features = await this.featuresFor(clinicId);
    return features[feature] === true;
  }

  private async featuresFor(clinicId: string): Promise<Record<FeatureKey, boolean>> {
    const cached = this.cache.get(clinicId);
    if (cached && cached.expiresAt > Date.now()) return cached.features;

    /*
     * Read inside the clinic's own context, through the ordinary tenant path.
     *
     * `subscription` carries a tenant policy, so a clinic reads its own row and
     * no other. The plan is shared reference data and is read by id from that
     * row — there is no query here that could return another clinic's plan.
     */
    const features = await this.tenantDb.runAs(clinicId, null, async (tx) => {
      const [row] = await tx
        .select({
          planFeatures: schema.plan.features,
          overrides: schema.subscription.featureOverrides,
        })
        .from(schema.subscription)
        .leftJoin(schema.plan, eq(schema.plan.id, schema.subscription.planId))
        .limit(1);

      return resolveFeatures(row?.planFeatures ?? null, row?.overrides ?? null);
    });

    this.cache.set(clinicId, { features, expiresAt: Date.now() + FeatureGuard.TTL_MS });
    return features;
  }
}
