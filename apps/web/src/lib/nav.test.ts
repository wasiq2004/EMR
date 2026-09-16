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

describe('Doctor and Nurse share one panel', () => {
  it('both land in the same shell', () => {
    expect(PANEL_FOR_ROLE.DOCTOR).toBe('doctor');
    expect(PANEL_FOR_ROLE.NURSE_ASSISTANT).toBe('doctor');
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
