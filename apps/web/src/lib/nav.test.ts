import { describe, expect, it } from 'vitest';
import { can, type UserRole } from '@emr/contracts';
import {
  PANEL_FOR_ROLE,
  landingRouteFor,
  navigationFor,
  settingsLinksFor,
} from './nav';

/**
 * Navigation is derived from the permission matrix, not hand-written per role.
 *
 * These tests exist because the failure they guard against is silent: a link
 * that survives a permission being removed does not break anything visibly —
 * it just offers staff an action the server will refuse, which reads as the
 * product being broken rather than as them lacking access.
 *
 * Navigation is NOT a security boundary. The server denies by default and is
 * the only thing that counts. These assertions are about the UI not lying.
 */

const ROLES: UserRole[] = [
  'OWNER_ADMIN',
  'DOCTOR',
  'RECEPTIONIST',
  'NURSE_ASSISTANT',
  'PHARMACIST',
  'RESEARCH_ANALYST',
  'AUDITOR',
];

const linksFor = (role: UserRole) =>
  navigationFor(role).flatMap((section) => section.items);

describe('every link is backed by a permission the role actually holds', () => {
  it.each(ROLES)('%s', (role) => {
    for (const item of linksFor(role)) {
      expect(
        can(role, item.permission),
        `${role} is offered "${item.label}" but lacks ${item.permission}`,
      ).toBe(true);
    }
  });
});

describe('the Compliance panel', () => {
  const auditorLinks = linksFor('AUDITOR');

  it('offers only the activity log and aggregate reports', () => {
    expect(auditorLinks.map((i) => i.href).sort()).toEqual([
      '/audit',
      '/audit/reports',
    ]);
  });

  it('offers no route into a patient, consultation or billing screen', () => {
    // An auditor reads the trail, never the patient. A link appearing here
    // would mean a permission change had leaked a PHI screen into the panel.
    const forbidden = ['/patients', '/queue', '/encounters', '/inbox', '/billing'];
    for (const item of auditorLinks) {
      for (const prefix of forbidden) {
        expect(item.href.startsWith(prefix)).toBe(false);
      }
    }
  });

  it('lands the auditor on the log rather than the clinic dashboard', () => {
    expect(landingRouteFor('AUDITOR')).toBe('/audit');
  });
});

describe('Front Desk', () => {
  const links = linksFor('RECEPTIONIST');

  it('gets the queue, the registry, the inbox and billing', () => {
    const hrefs = links.map((i) => i.href);
    expect(hrefs).toContain('/queue');
    expect(hrefs).toContain('/patients');
    expect(hrefs).toContain('/inbox');
    expect(hrefs).toContain('/billing');
  });

  it('is not offered patient merge, which is an administrator action', () => {
    expect(links.map((i) => i.href)).not.toContain('/patients/merge');
  });

  it('is not offered the activity log', () => {
    expect(links.map((i) => i.href)).not.toContain('/audit');
  });
});

describe('Doctor and Nurse share one shell under different names', () => {
  it('the nurse is not told she is a doctor', () => {
    expect(PANEL_FOR_ROLE.DOCTOR).toBe('doctor');
    expect(PANEL_FOR_ROLE.NURSE_ASSISTANT).toBe('nursing');
  });

  it('but the navigation they get is the same set, filtered by permission', () => {
    const doctor = linksFor('DOCTOR').map((i) => i.href);
    const nurse = linksFor('NURSE_ASSISTANT').map((i) => i.href);
    // Every link the nurse sees is one the doctor sees. The panel name differs;
    // the shell does not.
    for (const href of nurse) expect(doctor).toContain(href);
  });

  it('the nurse sees the queue and the registry', () => {
    const hrefs = linksFor('NURSE_ASSISTANT').map((i) => i.href);
    expect(hrefs).toContain('/queue');
    expect(hrefs).toContain('/patients');
  });

  it('the nurse is not offered billing, which they cannot act on', () => {
    expect(linksFor('NURSE_ASSISTANT').map((i) => i.href)).not.toContain('/billing');
  });
});

describe('Clinic Admin', () => {
  const hrefs = linksFor('OWNER_ADMIN').map((i) => i.href);

  it('gets merge, reports, settings and the activity log', () => {
    expect(hrefs).toContain('/patients/merge');
    expect(hrefs).toContain('/reports');
    expect(hrefs).toContain('/settings/clinic');
    expect(hrefs).toContain('/audit');
  });
});

describe('settings sub-navigation', () => {
  it('only offers pages the role may open', () => {
    for (const role of ROLES) {
      for (const link of settingsLinksFor(role)) {
        expect(
          can(role, link.permission),
          `${role} is offered settings page "${link.label}" without ${link.permission}`,
        ).toBe(true);
      }
    }
  });

  it('does not offer import or export to anyone who cannot run them', () => {
    for (const role of ROLES) {
      const hrefs = settingsLinksFor(role).map((l) => l.href);
      if (hrefs.includes('/settings/import')) {
        expect(can(role, 'import:read')).toBe(true);
      }
      if (hrefs.includes('/settings/export')) {
        expect(can(role, 'export:read')).toBe(true);
      }
    }
  });

  it('gives the receptionist no write access to clinic configuration', () => {
    // They can read the clinic record, but must not be offered a page whose
    // only purpose is editing configuration they cannot save.
    expect(can('RECEPTIONIST', 'clinic:update')).toBe(false);
  });
});

describe('no role is left without a home', () => {
  it.each(ROLES)('%s has at least one navigation item', (role) => {
    expect(linksFor(role).length).toBeGreaterThan(0);
  });

  it.each(ROLES)('%s has a landing route', (role) => {
    expect(landingRouteFor(role)).toMatch(/^\//);
  });
});


describe('the Pharmacy panel', () => {
  const links = linksFor('PHARMACIST');
  const hrefs = links.map((item) => item.href);

  it('opens at the prescription queue, not the clinic dashboard', () => {
    expect(landingRouteFor('PHARMACIST')).toBe('/pharmacy');
    expect(PANEL_FOR_ROLE.PHARMACIST).toBe('pharmacy');
  });

  it('offers the counter its own working set', () => {
    expect(hrefs).toContain('/pharmacy');
    expect(hrefs).toContain('/pharmacy/clarifications');
    expect(hrefs).toContain('/pharmacy/stock');
    expect(hrefs).toContain('/pharmacy/alerts');
  });

  /*
   * The boundary that matters. A pharmacist reads a patient's name, age and
   * allergies from the queue row — enough to hand the right medicine to the right
   * person — and must never be one permission change away from the consultation
   * note or the registry appearing in their sidebar.
   */
  it('offers no route into a consultation, the registry, billing or the inbox', () => {
    for (const item of links) {
      for (const prefix of [
        '/patients',
        '/encounters',
        '/billing',
        '/inbox',
        '/broadcasts',
        '/queue',
        '/appointments',
        '/settings',
        '/audit',
        '/today',
        '/analytics',
      ]) {
        expect(item.href.startsWith(prefix)).toBe(false);
      }
    }
  });

  it('cannot approve its own purchase orders by default', () => {
    expect(can('PHARMACIST', 'purchaseOrder:create')).toBe(true);
    expect(can('PHARMACIST', 'purchaseOrder:approve')).toBe(false);
  });

  it('can raise a clarification and cannot answer one', () => {
    expect(can('PHARMACIST', 'clarification:create')).toBe(true);
    expect(can('PHARMACIST', 'clarification:resolve')).toBe(false);
    expect(can('DOCTOR', 'clarification:resolve')).toBe(true);
  });

  it('can never write a prescription', () => {
    expect(can('PHARMACIST', 'prescription:read')).toBe(true);
    expect(can('PHARMACIST', 'prescription:update')).toBe(false);
    expect(can('PHARMACIST', 'prescription:create')).toBe(false);
    expect(can('PHARMACIST', 'prescription:sign')).toBe(false);
  });

  it('cannot read the consultation note or the diagnosis', () => {
    expect(can('PHARMACIST', 'encounterClinicalContent:read')).toBe(false);
    expect(can('PHARMACIST', 'condition:read')).toBe(false);
    expect(can('PHARMACIST', 'internalNote:read')).toBe(false);
  });

  it('can read the allergy list, because dispensing safely needs it', () => {
    expect(can('PHARMACIST', 'allergy:read')).toBe(true);
    expect(can('PHARMACIST', 'allergy:create')).toBe(false);
  });
});

describe('the Analytics panel', () => {
  const links = linksFor('RESEARCH_ANALYST');
  const hrefs = links.map((item) => item.href);

  it('opens at the overview', () => {
    expect(landingRouteFor('RESEARCH_ANALYST')).toBe('/analytics');
    expect(PANEL_FOR_ROLE.RESEARCH_ANALYST).toBe('analytics');
  });

  it('offers cohorts, the explorer, data quality and the dictionary', () => {
    expect(hrefs).toContain('/analytics');
    expect(hrefs).toContain('/analytics/cohorts');
    expect(hrefs).toContain('/analytics/explorer');
    expect(hrefs).toContain('/analytics/quality');
    expect(hrefs).toContain('/analytics/dictionary');
  });

  it('offers no route that could reach an identifiable record', () => {
    for (const item of links) {
      for (const prefix of [
        '/patients',
        '/encounters',
        '/inbox',
        '/billing',
        '/documents',
        '/queue',
        '/appointments',
        '/pharmacy',
        '/settings',
        '/today',
      ]) {
        expect(item.href.startsWith(prefix)).toBe(false);
      }
    }
  });

  /*
   * THE PRIVACY GUARANTEE, asserted rather than described.
   *
   * De-identification is not a mode this role can have switched off, because it
   * holds no permission that returns a person. If any of these ever becomes true,
   * the panel has stopped being a governed-analytics role and nobody will have
   * noticed from looking at the screens.
   */
  it('holds no permission that returns identifying data', () => {
    for (const permission of [
      'patient:read',
      'encounter:read',
      'encounterClinicalContent:read',
      'observation:read',
      'condition:read',
      'allergy:read',
      'prescription:read',
      'document:read',
      'communication:read',
      'invoice:read',
      'auditEvent:read',
    ] as const) {
      expect(can('RESEARCH_ANALYST', permission)).toBe(false);
    }
  });

  it('holds exactly the aggregate permissions it needs', () => {
    expect(can('RESEARCH_ANALYST', 'analytics:read')).toBe(true);
    expect(can('RESEARCH_ANALYST', 'cohort:create')).toBe(true);
    expect(can('RESEARCH_ANALYST', 'export:create')).toBe(true);
  });

  it('does not grant analytics:read to anyone who should not aggregate', () => {
    expect(can('RECEPTIONIST', 'analytics:read')).toBe(false);
    expect(can('PHARMACIST', 'analytics:read')).toBe(false);
    expect(can('AUDITOR', 'analytics:read')).toBe(false);
  });
});

/**
 * The calendar.
 *
 * It is a scheduling screen, so it follows `appointment:read` exactly — which
 * the doctor, the front desk, the nurse and the administrator hold, and the
 * pharmacist and the research analyst do not. The assertions below are about
 * the sidebar not offering a door that the server will refuse; the guard on
 * `GET /calendar` is the control, and `scripts/verify/availability.sh` proves
 * it answers 403 for both of those roles.
 */
describe('the calendar', () => {
  const hrefsFor = (role: UserRole) => linksFor(role).map((item) => item.href);

  it('is offered to everyone who schedules', () => {
    for (const role of ['OWNER_ADMIN', 'DOCTOR', 'RECEPTIONIST', 'NURSE_ASSISTANT'] as const) {
      expect(hrefsFor(role), role).toContain('/calendar');
    }
  });

  it('is not offered to the pharmacy or analytics panels', () => {
    for (const role of ['PHARMACIST', 'RESEARCH_ANALYST', 'AUDITOR'] as const) {
      expect(hrefsFor(role), role).not.toContain('/calendar');
    }
  });

  /*
   * The list is kept alongside the grid rather than replaced by it. A grid is
   * how you find a free slot; a list is how you answer "who is coming on the
   * 14th" and how you work a day on a phone at the counter. Losing the list
   * when the calendar arrived would have been a regression dressed as a
   * feature.
   */
  it('has not replaced the appointment list', () => {
    expect(hrefsFor('RECEPTIONIST')).toContain('/appointments');
  });

  it('is permissioned, not hardcoded per role', () => {
    const link = linksFor('DOCTOR').find((item) => item.href === '/calendar');
    expect(link?.permission).toBe('appointment:read');
    for (const role of ROLES) {
      const offered = hrefsFor(role).includes('/calendar');
      expect(offered, role).toBe(can(role, 'appointment:read'));
    }
  });
});

/**
 * Doctor schedules live under settings, with clinic configuration.
 *
 * `clinic:update`, not `appointment:update`: rewriting a doctor's working week
 * is configuration, and reception entering next Tuesday's leave is not. Those
 * are different permissions and the split is deliberate — see the availability
 * routes.
 */
describe('doctor schedules', () => {
  it('is offered to an administrator', () => {
    expect(settingsLinksFor('OWNER_ADMIN').map((l) => l.href)).toContain(
      '/settings/schedules',
    );
  });

  it('is not offered to the front desk, who cannot rewrite a working week', () => {
    expect(settingsLinksFor('RECEPTIONIST').map((l) => l.href)).not.toContain(
      '/settings/schedules',
    );
  });
});
