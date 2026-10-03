import { z } from 'zod';

/**
 * The feature registry.
 *
 * ONE LIST, COMPILED INTO BOTH SIDES. The console renders toggles from it and
 * the clinic API enforces from it, so a flag cannot exist in the panel and mean
 * nothing on the server — which is the usual way feature flags rot.
 *
 * Adding one here is the whole change: it appears in the console, it can be put
 * on a plan, and `@RequiresFeature` will gate a route with it.
 *
 * EVERY FLAG DEFAULTS TO OFF. A feature added next month is disabled for every
 * existing plan until someone decides otherwise. That is the safe direction:
 * the failure is a clinic asking why a button is missing, not a clinic using
 * something it never bought.
 */

export const FEATURES = [
  {
    key: 'whatsapp',
    label: 'WhatsApp messaging',
    description:
      'Connect a number, receive patient messages, reply from the inbox. Without it the Communication section is hidden entirely.',
    /** Turning this off takes the ones below with it. */
    implies: [] as readonly string[],
  },
  {
    key: 'broadcasts',
    label: 'Broadcasts',
    description:
      'Send one approved template to many patients at once, gated on consent. Needs WhatsApp.',
    implies: ['whatsapp'] as readonly string[],
  },
  {
    key: 'teleconsultation',
    label: 'Teleconsultation',
    description:
      'Mark a consultation as remote. Enforces the Schedule X prohibition and adds the required declaration to the prescription.',
    implies: [] as readonly string[],
  },
  {
    key: 'documents',
    label: 'Documents and secure sharing',
    description:
      'Upload reports and scans, and share them with a patient over an OTP-protected link.',
    implies: [] as readonly string[],
  },
  {
    key: 'billing',
    label: 'Billing',
    description: 'Invoices and payments. Not accounting — no ledger, GST filing or TDS.',
    implies: [] as readonly string[],
  },
  {
    key: 'reports',
    label: 'Reports',
    description: 'Daily and periodic summaries of the clinic’s own activity.',
    implies: [] as readonly string[],
  },
  {
    key: 'pharmacy',
    label: 'Pharmacy',
    description:
      'An in-house medicine counter: dispensing against a finalised prescription, batch and expiry tracking, suppliers, purchase orders and counter sales. A clinic that only prescribes does not need it.',
    implies: [] as readonly string[],
  },
  {
    key: 'lab',
    label: 'Lab orders and results',
    description:
      'Order tests, record what comes back, and see which results nobody has read yet. For a clinic that sends patients to an outside lab — it does not run a lab, and expects the report to arrive on paper or as a PDF.',
    implies: [] as readonly string[],
  },
  {
    key: 'analytics',
    label: 'Governed analytics',
    description:
      'De-identified cohorts, trend exploration and data-quality measures for a clinic doing its own audit or research. Carries no identifying data by construction.',
    /*
     * Depends on `reports`, and the reason is commercial rather than technical.
     * A clinic that has not bought the clinic's own reporting has no business
     * being sold the research layer on top of it; selling the second without
     * the first produces a customer who cannot answer "how many patients did we
     * see last month" but can build a cohort.
     */
    implies: ['reports'] as readonly string[],
  },
  {
    key: 'dataPortability',
    label: 'Import and export',
    description:
      'Bring a patient register in from CSV, and take the whole record out. Export is a legal obligation on request, so switching it off has consequences beyond the product.',
    implies: [] as readonly string[],
  },
  {
    key: 'multiLocation',
    label: 'Multiple locations',
    description: 'More than one consulting location under the same clinic.',
    implies: [] as readonly string[],
  },
] as const;

export type FeatureKey = (typeof FEATURES)[number]['key'];

export const FEATURE_KEYS = FEATURES.map((feature) => feature.key) as FeatureKey[];

export const FeatureSet = z.record(z.string(), z.boolean());
export type FeatureSet = z.infer<typeof FeatureSet>;

/**
 * The features a clinic actually has.
 *
 * Plan first, then the clinic's own overrides. An override is deliberately
 * absolute in both directions: it can grant something the plan does not
 * include — a pilot, an apology, a trial — and it can withhold something the
 * plan does, which is how a clinic that abused a channel keeps everything else.
 *
 * Dependencies are applied LAST and only downward: `broadcasts` without
 * `whatsapp` is not a configuration anyone meant, and resolving it here means
 * no caller has to remember the relationship.
 */
export function resolveFeatures(
  planFeatures: FeatureSet | null | undefined,
  overrides: FeatureSet | null | undefined,
): Record<FeatureKey, boolean> {
  const resolved = {} as Record<FeatureKey, boolean>;

  for (const feature of FEATURES) {
    const key = feature.key as FeatureKey;
    // Absent means off, at both levels.
    resolved[key] = overrides?.[key] ?? planFeatures?.[key] ?? false;
  }

  for (const feature of FEATURES) {
    if (!feature.implies.length) continue;
    const key = feature.key as FeatureKey;
    if (!resolved[key]) continue;

    const missing = feature.implies.find((required) => !resolved[required as FeatureKey]);
    if (missing) resolved[key] = false;
  }

  return resolved;
}

/** Everything on. The set a plan gets when someone says "give them everything". */
export function allFeaturesOn(): FeatureSet {
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, true]));
}
