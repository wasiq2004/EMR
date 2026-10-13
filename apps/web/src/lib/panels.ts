import type { Route } from 'next';
import {
  Building2,
  ConciergeBell,
  HeartPulse,
  LineChart,
  Pill,
  ShieldCheck,
  Stethoscope,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@emr/contracts';
import type { PanelId } from './nav';

/**
 * What each panel IS.
 *
 * THE PROBLEM THIS SOLVES. Four of the seven panels — Front Desk, Doctor,
 * Nursing, Clinic Admin — were one screen set with permissions subtracted.
 * Same navigation, same order, same landing, three links of difference between
 * a receptionist and a doctor. We printed four names, which promises four
 * workspaces, and shipped one. That is what "the panels look vague" meant.
 *
 * So a panel is defined here once — its name, its mark, its landing, the single
 * action it exists to perform — and the sidebar, the page header and the
 * landing all read from this. Nothing else gets to decide what a panel looks
 * like, for the same reason the sidebar is generated from the permission matrix
 * rather than hand-listed: two sources of truth drift the first time somebody
 * changes one.
 *
 * COLOUR IS NOT IN HERE. The accent per panel lives in `globals.css`, keyed on
 * `data-panel`, because it needs a light and a dark value and belongs with the
 * other theme tokens. It is applied at exactly three touchpoints — the sidebar
 * chip, the active-nav indicator and the page-header rule — and the panel is
 * always NAMED in text beside it. Colour is never the only carrier of which
 * panel you are in.
 */
export interface PanelDefinition {
  id: PanelId;
  /** What this workspace is called when this role is in it. */
  label: string;
  /**
   * The mark in the sidebar chip. Distinct per panel on purpose: it is the one
   * identity cue that survives greyscale, low vision and a bad monitor.
   */
  mark: LucideIcon;
  /** Where signing in lands. */
  landing: Route;
  /** One sentence on what the panel is for. Read by the landing header. */
  purpose: string;
  /**
   * The single thing this panel exists to do, rendered in a fixed position so
   * it is in the same place every time.
   *
   * `null` is a legitimate answer and is used twice. Clinic Admin and
   * Compliance have no once-an-hour action — administering is reviewing, and
   * inventing a call to action for it would put a button on screen that nobody
   * presses and everybody has to read past.
   */
  primary: { label: string; href: Route; permission: Permission } | null;
}

export const PANELS: Record<PanelId, PanelDefinition> = {
  'front-desk': {
    id: 'front-desk',
    label: 'Front Desk',
    mark: ConciergeBell,
    landing: '/today',
    purpose: 'Who is here, who is next, and who still owes.',
    primary: {
      label: 'Book a visit',
      href: '/appointments/new',
      permission: 'appointment:create',
    },
  },
  doctor: {
    id: 'doctor',
    label: 'Doctor',
    mark: Stethoscope,
    landing: '/today',
    purpose: 'Your list for today, and the consultations still unsigned.',
    primary: {
      label: 'See next patient',
      href: '/queue',
      permission: 'encounter:create',
    },
  },
  nursing: {
    id: 'nursing',
    label: 'Nursing',
    mark: HeartPulse,
    landing: '/today',
    purpose: 'Vitals to record before the doctor calls each patient.',
    primary: {
      label: 'Record vitals',
      href: '/queue',
      permission: 'observation:create',
    },
  },
  'clinic-admin': {
    id: 'clinic-admin',
    label: 'Clinic Admin',
    mark: Building2,
    landing: '/today',
    purpose: 'The practice as a whole — money, people and activity.',
    primary: null,
  },
  pharmacy: {
    id: 'pharmacy',
    label: 'Pharmacy',
    mark: Pill,
    landing: '/pharmacy',
    purpose: 'Prescriptions waiting to be dispensed, and what is in stock.',
    primary: {
      label: 'Dispense next',
      href: '/pharmacy',
      permission: 'dispense:create',
    },
  },
  analytics: {
    id: 'analytics',
    label: 'Analytics',
    mark: LineChart,
    landing: '/analytics',
    purpose: 'Patterns across the practice, with nobody identifiable in them.',
    primary: {
      label: 'New cohort',
      href: '/analytics/cohorts',
      permission: 'cohort:create',
    },
  },
  compliance: {
    id: 'compliance',
    label: 'Compliance',
    mark: ShieldCheck,
    landing: '/audit',
    purpose: 'Who did what, and aggregate reporting. No patient record.',
    primary: null,
  },
};
