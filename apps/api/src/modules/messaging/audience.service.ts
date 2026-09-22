import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';

import { TenantDb, type TenantTx } from '../../common/tenancy/tenant-db.service';

/**
 * Who a broadcast would reach, and who it would not.
 *
 * CONSENT IS A GATE, NOT A PREFERENCE. This is the one place this product
 * departs sharply from a marketing CRM, and the reason is that a clinic holds
 * people's phone numbers because they were ill, not because they opted into a
 * mailing list.
 *
 * `consent_scope` already separates WHATSAPP_COMMUNICATION from
 * MARKETING_COMMUNICATION, so:
 *
 *   - a CLINICAL broadcast (a recall, a closure notice, a camp for people with
 *     a condition they are already being treated for) requires
 *     WHATSAPP_COMMUNICATION
 *   - a MARKETING broadcast requires MARKETING_COMMUNICATION, which is a
 *     separate act of consent and is not implied by the first
 *
 * EXCLUSIONS ARE COUNTED AND SHOWN BEFORE SENDING. "Reaches 312 of 480" with a
 * breakdown is the number that matters — a screen that shows only the audience
 * size invites someone to widen the filter until it looks big enough, without
 * ever learning that 168 people never consented.
 */

export type BroadcastPurpose = 'CLINICAL' | 'MARKETING';

export interface AudienceFilter {
  /** Patient tags, e.g. 'Chronic care'. Any match. */
  tags?: string[];
  /** Seen within this many days. */
  seenWithinDays?: number;
  /** NOT seen for at least this many days — the recall case. */
  notSeenForDays?: number;
  ageMin?: number;
  ageMax?: number;
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
  /** Explicit patient ids, when someone has picked a list by hand. */
  patientIds?: string[];
}

export type ExclusionReason =
  | 'NO_MOBILE'
  | 'NO_CONSENT'
  | 'OPTED_OUT'
  | 'DUPLICATE_NUMBER'
  | 'DECEASED_OR_MERGED';

export interface AudienceMember {
  patientId: string;
  fullName: string;
  mobileE164: string;
  consentId: string;
}

export interface AudienceResult {
  included: AudienceMember[];
  /** How many were considered before any exclusion. */
  considered: number;
  exclusions: Record<ExclusionReason, number>;
  /** A few names per reason, so the screen can show who rather than only how many. */
  samples: Partial<Record<ExclusionReason, string[]>>;
}

@Injectable()
export class AudienceService {
  constructor(private readonly tenantDb: TenantDb) {}

  /** Resolves a filter to the people it would actually reach. */
  async resolve(
    filter: AudienceFilter,
    purpose: BroadcastPurpose,
  ): Promise<AudienceResult> {
    return this.tenantDb.runReadOnly((tx) => this.resolveIn(tx, filter, purpose));
  }

  /**
   * The same resolution, inside a caller's transaction.
   *
   * Used by the send path, which resolves and writes the recipient rows in ONE
   * transaction — so the list that was counted is the list that is written, and
   * a patient registered between the two cannot appear in one and not the other.
   */
  async resolveIn(
    tx: TenantTx,
    filter: AudienceFilter,
    purpose: BroadcastPurpose,
  ): Promise<AudienceResult> {
    const exclusions: Record<ExclusionReason, number> = {
      NO_MOBILE: 0,
      NO_CONSENT: 0,
      OPTED_OUT: 0,
      DUPLICATE_NUMBER: 0,
      DECEASED_OR_MERGED: 0,
    };
    const samples: Partial<Record<ExclusionReason, string[]>> = {};

    const note = (reason: ExclusionReason, name: string) => {
      exclusions[reason] += 1;
      const list = (samples[reason] ??= []);
      if (list.length < 5) list.push(name);
    };

    const candidates = await tx
      .select()
      .from(schema.patient)
      .where(and(...this.conditions(filter)))
      .limit(10_000);

    const scope =
      purpose === 'MARKETING' ? 'MARKETING_COMMUNICATION' : 'WHATSAPP_COMMUNICATION';

    /*
     * Consent, in one query rather than per patient.
     *
     * ACTIVE and not withdrawn, and not expired. An expired consent is not
     * consent — the whole point of an expiry is that it stops being valid
     * without anyone having to remember to revoke it.
     */
    const consents = await tx
      .select({
        id: schema.consent.id,
        patientId: schema.consent.patientId,
        expiresAt: schema.consent.expiresAt,
      })
      .from(schema.consent)
      .where(
        and(
          eq(schema.consent.scope, scope),
          eq(schema.consent.status, 'ACTIVE'),
          isNull(schema.consent.withdrawnAt),
        ),
      );

    const now = Date.now();
    const consentByPatient = new Map<string, string>();
    for (const consent of consents) {
      if (consent.expiresAt && consent.expiresAt.getTime() < now) continue;
      consentByPatient.set(consent.patientId, consent.id);
    }

    // Numbers that have opted out of this clinic's messages entirely. An
    // opt-out beats a consent: it is the more recent and more specific signal.
    const optedOut = new Set(
      (
        await tx
          .select({ number: schema.whatsappConversation.counterpartyE164 })
          .from(schema.whatsappConversation)
          .where(eq(schema.whatsappConversation.isOptedOut, true))
      ).map((row) => row.number),
    );

    const included: AudienceMember[] = [];
    const seenNumbers = new Set<string>();

    for (const patient of candidates) {
      // A merged patient's record lives on for history but is not a person to
      // message: the survivor already is.
      if (patient.mergedIntoPatientId) {
        note('DECEASED_OR_MERGED', patient.fullName);
        continue;
      }

      if (!patient.mobileE164) {
        note('NO_MOBILE', patient.fullName);
        continue;
      }

      if (optedOut.has(patient.mobileE164)) {
        note('OPTED_OUT', patient.fullName);
        continue;
      }

      const consentId = consentByPatient.get(patient.id);
      if (!consentId) {
        note('NO_CONSENT', patient.fullName);
        continue;
      }

      /*
       * One message per NUMBER, not per patient.
       *
       * A shared family number is the norm in this market — the seeded data has
       * three people on one — and sending the same broadcast three times to one
       * handset is how a clinic's number gets reported and blocked. The first
       * patient on a number wins; the rest are counted so the screen can say so.
       */
      if (seenNumbers.has(patient.mobileE164)) {
        note('DUPLICATE_NUMBER', patient.fullName);
        continue;
      }
      seenNumbers.add(patient.mobileE164);

      included.push({
        patientId: patient.id,
        fullName: patient.fullName,
        mobileE164: patient.mobileE164,
        consentId,
      });
    }

    return { included, considered: candidates.length, exclusions, samples };
  }

  /** The filter, as SQL. Everything omitted widens rather than narrows. */
  private conditions(filter: AudienceFilter) {
    const conditions = [];

    if (filter.patientIds?.length) {
      conditions.push(inArray(schema.patient.id, filter.patientIds));
    }

    if (filter.tags?.length) {
      // Array overlap: any tag matches, which is what "Chronic care or
      // Geriatric" means to the person building the list.
      conditions.push(sql`${schema.patient.tags} && ${`{${filter.tags.join(',')}}`}::text[]`);
    }

    if (filter.gender) {
      conditions.push(eq(schema.patient.gender, filter.gender));
    }

    /*
     * Age from date of birth OR from a stated age.
     *
     * A patient with a stated age and no date of birth is common here and must
     * not silently drop out of every age-filtered audience — which is exactly
     * what a bare `date_of_birth BETWEEN` would do.
     */
    if (filter.ageMin != null) {
      conditions.push(
        sql`(
          (${schema.patient.dateOfBirth} IS NOT NULL
            AND date_part('year', age(${schema.patient.dateOfBirth})) >= ${filter.ageMin})
          OR (${schema.patient.ageYears} IS NOT NULL AND ${schema.patient.ageYears} >= ${filter.ageMin})
        )`,
      );
    }

    if (filter.ageMax != null) {
      conditions.push(
        sql`(
          (${schema.patient.dateOfBirth} IS NOT NULL
            AND date_part('year', age(${schema.patient.dateOfBirth})) <= ${filter.ageMax})
          OR (${schema.patient.ageYears} IS NOT NULL AND ${schema.patient.ageYears} <= ${filter.ageMax})
        )`,
      );
    }

    if (filter.seenWithinDays != null) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM encounter e
          WHERE e.patient_id = ${schema.patient.id}
            AND e.started_at >= now() - ${`${filter.seenWithinDays} days`}::interval
        )`,
      );
    }

    if (filter.notSeenForDays != null) {
      // The recall case: nobody with a recent visit, INCLUDING people who have
      // never been seen at all — a registered patient who never came back is
      // exactly who a recall is for.
      conditions.push(
        sql`NOT EXISTS (
          SELECT 1 FROM encounter e
          WHERE e.patient_id = ${schema.patient.id}
            AND e.started_at >= now() - ${`${filter.notSeenForDays} days`}::interval
        )`,
      );
    }

    return conditions;
  }
}
