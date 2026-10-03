/**
 * Role-driven navigation — the six panels, expressed as data.
 *
 * Each item names the permission it needs, and the permission is checked
 * against the shared matrix in @emr/contracts. That means navigation cannot
 * drift from authorisation: adding a screen without a permission makes it
 * invisible, and removing a permission removes the link.
 *
 * THIS IS NOT A SECURITY BOUNDARY. It exists so the UI never offers an action
 * the server will refuse. The server denies by default and is the only thing
 * that counts.
 */

import {
  Activity,
  Banknote,
  BarChart3,
  CalendarDays,
  ClipboardList,
  FileText,
  Inbox,
  LayoutGrid,
  ListChecks,
  ListOrdered,
  MessageSquare,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
  Megaphone,
  Boxes,
  ClipboardCheck,
  FlaskConical,
  LineChart,
  Microscope,
  MessageCircleQuestion,
  Pill,
  ReceiptText,
  ShoppingCart,
  Truck,
  TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Route } from 'next';
import { can, type Permission, type UserRole } from '@emr/contracts';

export type PanelId =
  | 'front-desk'
  | 'doctor'
  | 'nursing'
  | 'clinic-admin'
  | 'pharmacy'
  | 'analytics'
  | 'compliance';

/**
 * The live counts the sidebar can render.
 *
 * Declared once here and imported by both consumers. It was previously written out
 * again in `sidebar.tsx`, which meant adding a pharmacy badge produced a type error
 * in a component that had nothing to do with pharmacy.
 */
export type BadgeKey =
  | 'inbox'
  | 'tasks'
  | 'queue'
  | 'rxQueue'
  | 'clarifications'
  | 'stockAlerts';

export type BadgeCounts = Partial<Record<BadgeKey, number>>;

export interface NavItem {
  label: string;
  href: Route;
  icon: LucideIcon;
  /** Shown only if the role holds this permission. */
  permission: Permission;
  /** Extra gate beyond the permission, e.g. merge is admin-only in practice. */
  roles?: UserRole[];
  /** Live count rendered as a badge, e.g. unread inbox. */
  badgeKey?: BadgeKey;
}

export interface NavSection {
  title: string | null;
  items: NavItem[];
}

/**
 * Which panel a role lands in. Drives the label in the sidebar header.
 *
 * A nurse gets the same SHELL and the same screens as a doctor — the navigation
 * is filtered from the permission matrix, not from this map — but a different
 * name for it. "Doctor" is what the workspace is called when a doctor is in it;
 * telling a nurse she is in the Doctor panel is simply untrue, and a person
 * reading their own job title back wrong every time they sign in notices.
 */
export const PANEL_FOR_ROLE: Record<UserRole, PanelId> = {
  RECEPTIONIST: 'front-desk',
  DOCTOR: 'doctor',
  NURSE_ASSISTANT: 'nursing',
  OWNER_ADMIN: 'clinic-admin',
  PHARMACIST: 'pharmacy',
  RESEARCH_ANALYST: 'analytics',
  AUDITOR: 'compliance',
};

export const PANEL_LABEL: Record<PanelId, string> = {
  'front-desk': 'Front Desk',
  doctor: 'Doctor',
  nursing: 'Nursing',
  'clinic-admin': 'Clinic Admin',
  pharmacy: 'Pharmacy',
  analytics: 'Analytics',
  compliance: 'Compliance',
};

/**
 * The full navigation, filtered per role at render time. Order is the order
 * staff work in, not alphabetical: the queue comes before the registry because
 * the day starts at the queue.
 */
const ALL_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [
      {
        label: 'Today',
        href: '/today',
        icon: LayoutGrid,
        permission: 'clinic:read',
      },
      {
        label: 'Queue',
        href: '/queue',
        icon: ListChecks,
        permission: 'appointment:read',
        badgeKey: 'queue',
      },
      {
        label: 'Calendar',
        href: '/calendar',
        icon: CalendarDays,
        permission: 'appointment:read',
      },
      /*
       * The list survives alongside the calendar rather than being replaced by
       * it. A grid is how you find a free slot; a list is how you answer "who is
       * coming on the 14th" and how you work through a day on a phone at the
       * counter. They are different questions and the list is better at its one.
       */
      {
        label: 'Appointment list',
        href: '/appointments',
        icon: ListOrdered,
        permission: 'appointment:read',
      },
    ],
  },
  {
    title: 'Patients',
    items: [
      {
        label: 'Patient registry',
        href: '/patients',
        icon: Users,
        permission: 'patient:read',
      },
      {
        label: 'Merge duplicates',
        href: '/patients/merge',
        icon: UserRound,
        permission: 'patient:merge',
      },
    ],
  },
  {
    title: 'Care',
    items: [
      {
        label: 'Documents',
        href: '/documents',
        icon: FileText,
        permission: 'document:read',
      },
      {
        label: 'Lab',
        href: '/lab',
        icon: FlaskConical,
        /*
         * `labOrder:read`, which the doctor, the nurse and the administrator
         * hold and reception does not. A lab result is clinical content — a
         * measured fact about somebody's body — and the front desk has no
         * reason to see one.
         */
        permission: 'labOrder:read',
      },
      {
        label: 'Tasks',
        href: '/tasks',
        icon: ClipboardList,
        permission: 'task:read',
        badgeKey: 'tasks',
      },
    ],
  },
  {
    title: 'Communication',
    items: [
      {
        label: 'Inbox',
        href: '/inbox',
        icon: Inbox,
        permission: 'communication:read',
        badgeKey: 'inbox',
      },
      {
        label: 'Unlinked messages',
        href: '/inbox/unlinked',
        icon: MessageSquare,
        permission: 'communication:read',
      },
      {
        // Admin-only, by permission rather than by a role list: the blast
        // radius is what makes it different, and the matrix already says so.
        label: 'Broadcasts',
        href: '/broadcasts',
        icon: Megaphone,
        permission: 'communication:broadcast',
      },
    ],
  },
  {
    title: 'Practice',
    items: [
      {
        label: 'Billing',
        href: '/billing',
        icon: Banknote,
        permission: 'invoice:read',
      },
      {
        label: 'Clinic analytics',
        href: '/reports/analytics',
        icon: BarChart3,
        permission: 'report:read',
      },
      {
        label: 'Reports',
        href: '/reports',
        icon: Activity,
        permission: 'report:read',
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      {
        label: 'Settings',
        href: '/settings/clinic',
        icon: Settings,
        permission: 'clinic:read',
      },
      {
        label: 'Activity log',
        href: '/audit',
        icon: ShieldCheck,
        permission: 'auditEvent:read',
      },
    ],
  },
];

/**
 * The Compliance panel is built from its own list rather than by filtering the
 * clinic navigation. An auditor should never be one permission change away from
 * seeing a patient screen in their sidebar.
 */
const COMPLIANCE_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [
      {
        label: 'Activity log',
        href: '/audit',
        icon: ShieldCheck,
        permission: 'auditEvent:read',
      },
      {
        label: 'Aggregate reports',
        href: '/audit/reports',
        icon: Activity,
        permission: 'report:read',
      },
    ],
  },
];

/**
 * The Pharmacy panel.
 *
 * Its own list for the same reason Compliance has one: a pharmacist must not be
 * one permission change away from a consultation note appearing in their
 * sidebar. The order is the counter's working day — the queue of prescriptions
 * waiting is what a pharmacist opens the software to see.
 */
const PHARMACY_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [
      {
        label: 'Prescription queue',
        href: '/pharmacy',
        icon: Pill,
        permission: 'dispense:read',
        badgeKey: 'rxQueue',
      },
      {
        label: 'Clarifications',
        href: '/pharmacy/clarifications',
        icon: MessageCircleQuestion,
        permission: 'clarification:read',
        badgeKey: 'clarifications',
      },
      {
        label: 'Counter sale',
        href: '/pharmacy/sales',
        icon: ShoppingCart,
        permission: 'pharmacySale:create',
      },
    ],
  },
  {
    title: 'Stock',
    items: [
      {
        label: 'Inventory',
        href: '/pharmacy/stock',
        icon: Boxes,
        permission: 'stock:read',
      },
      {
        label: 'Alerts',
        href: '/pharmacy/alerts',
        icon: TriangleAlert,
        permission: 'stock:read',
        badgeKey: 'stockAlerts',
      },
      {
        label: 'Products',
        href: '/pharmacy/products',
        icon: ClipboardCheck,
        permission: 'pharmacyProduct:read',
      },
    ],
  },
  {
    title: 'Purchasing',
    items: [
      {
        label: 'Purchase orders',
        href: '/pharmacy/purchases',
        icon: ReceiptText,
        permission: 'purchaseOrder:read',
      },
      {
        label: 'Suppliers',
        href: '/pharmacy/suppliers',
        icon: Truck,
        permission: 'supplier:read',
      },
    ],
  },
  {
    title: 'Review',
    items: [
      {
        label: 'Pharmacy reports',
        href: '/pharmacy/reports',
        icon: Activity,
        permission: 'report:read',
      },
      {
        label: 'Tasks',
        href: '/tasks',
        icon: ClipboardList,
        permission: 'task:read',
        badgeKey: 'tasks',
      },
    ],
  },
];

/**
 * The Analytics panel.
 *
 * Every link here leads to counts, bands and codes. There is deliberately no
 * patient search, no registry and no inbox — not hidden, absent, because the
 * role holds no permission that would return a person.
 */
const ANALYTICS_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [
      {
        label: 'Overview',
        href: '/analytics',
        icon: LineChart,
        permission: 'analytics:read',
      },
      {
        label: 'Cohorts',
        href: '/analytics/cohorts',
        icon: Microscope,
        permission: 'cohort:read',
      },
      {
        label: 'Explorer',
        href: '/analytics/explorer',
        icon: Activity,
        permission: 'analytics:read',
      },
    ],
  },
  {
    title: 'Governance',
    items: [
      {
        label: 'Data quality',
        href: '/analytics/quality',
        icon: FlaskConical,
        permission: 'analytics:read',
      },
      {
        label: 'Data dictionary',
        href: '/analytics/dictionary',
        icon: FileText,
        permission: 'analytics:read',
      },
      {
        label: 'Exports',
        href: '/analytics/exports',
        icon: ClipboardCheck,
        permission: 'export:read',
      },
    ],
  },
];

export function navigationFor(role: UserRole): NavSection[] {
  if (role === 'AUDITOR') return COMPLIANCE_SECTIONS;
  if (role === 'PHARMACIST') return filterSections(PHARMACY_SECTIONS, role);
  if (role === 'RESEARCH_ANALYST') return filterSections(ANALYTICS_SECTIONS, role);

  return filterSections(ALL_SECTIONS, role);
}

/**
 * Drops the links a role cannot use, and then the sections left empty.
 *
 * Applied to the panel-specific lists too, not only the clinic one. A clinic
 * that has not bought purchasing still gets a Pharmacy panel — it just has no
 * Purchasing section, rather than a section of links that 403.
 */
function filterSections(sections: NavSection[], role: UserRole): NavSection[] {
  return sections.map((section) => ({
    title: section.title,
    items: section.items.filter((item) => {
      if (item.roles && !item.roles.includes(role)) return false;
      return can(role, item.permission);
    }),
  })).filter((section) => section.items.length > 0);
}

/** The route a role should land on after signing in. */
export function landingRouteFor(role: UserRole): Route {
  if (role === 'AUDITOR') return '/audit';
  // Not '/today'. A pharmacist's day starts at the prescription queue and an
  // analyst's at the overview; neither has a clinic dashboard to land on.
  if (role === 'PHARMACIST') return '/pharmacy';
  if (role === 'RESEARCH_ANALYST') return '/analytics';
  return '/today';
}

/** Settings sub-navigation, filtered the same way. */
export interface SettingsLink {
  label: string;
  href: Route;
  permission: Permission;
  description: string;
}

export const SETTINGS_LINKS: SettingsLink[] = [
  {
    label: 'Clinic profile',
    href: '/settings/clinic',
    permission: 'clinic:read',
    description: 'Name, letterhead, address and timezone',
  },
  {
    label: 'Locations',
    href: '/settings/locations',
    permission: 'clinic:read',
    description: 'Consulting rooms and branch sites',
  },
  {
    label: 'Follow-up reminders',
    href: '/settings/reminders',
    /*
     * `clinic:read`, so reception can see what the clinic sends and whether a
     * reminder reached a patient. The page itself disables every control without
     * `clinic:update` — the API gates saving on that, and offering a form whose
     * save is refused is a door onto a wall.
     */
    permission: 'clinic:read',
    description: 'Whether follow-ups are reminded, when, and what went out.',
  },
  {
    label: 'Doctor schedules',
    href: '/settings/schedules',
    /*
     * `clinic:update`, not `appointment:read`.
     *
     * The page's headline action is rewriting a doctor's working week, which the
     * API gates on `clinic:update` — reception should not be able to do it. It
     * was listed under `appointment:read`, so the front desk was offered a page
     * on which every save would be refused: a door that opens onto a wall.
     *
     * Recording that a doctor is off next Tuesday is different, and is front-desk
     * work — `appointment:update` on the API. It belongs next to the calendar
     * rather than in settings, and until it is there the page is an
     * administrator's.
     */
    permission: 'clinic:update',
    description: 'When each doctor works, and the days they do not.',
  },
  {
    label: 'Staff and roles',
    href: '/settings/users',
    permission: 'user:read',
    description: 'Who can sign in, and what they can do',
  },
  {
    label: 'Services and fees',
    href: '/settings/services',
    permission: 'clinic:read',
    description: 'Billable items and default consultation length',
  },
  {
    label: 'Consultation templates',
    href: '/settings/encounter-templates',
    permission: 'encounter:read',
    description: 'Reusable note structures per specialty or doctor',
  },
  {
    label: 'Prescription sets',
    href: '/settings/prescription-templates',
    permission: 'prescription:read',
    description: 'Common medicine combinations',
  },
  {
    label: 'WhatsApp account',
    href: '/settings/whatsapp',
    permission: 'communication:read',
    description: 'The number patients receive messages from',
  },
  {
    label: 'Message templates',
    href: '/settings/message-templates',
    permission: 'communication:read',
    description: 'Approved messages and their status',
  },
  {
    label: 'Consent text',
    href: '/settings/consent',
    permission: 'consent:read',
    description: 'Notices shown to patients, by purpose and language',
  },
  {
    label: 'Import patients',
    href: '/settings/import',
    permission: 'import:read',
    description: 'Bring a patient list in from CSV or Excel',
  },
  {
    label: 'Export data',
    href: '/settings/export',
    permission: 'export:read',
    description: 'Download everything this clinic holds',
  },
  {
    label: 'My account',
    href: '/settings/account',
    permission: 'clinic:read',
    description: 'Password, two-factor and active sessions',
  },
];

export function settingsLinksFor(role: UserRole): SettingsLink[] {
  return SETTINGS_LINKS.filter((link) => can(role, link.permission));
}
