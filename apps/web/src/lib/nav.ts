/**
 * Role-driven navigation — the four panels, expressed as data.
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
  CalendarDays,
  ClipboardList,
  FileText,
  Inbox,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
  Megaphone,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Route } from 'next';
import { can, type Permission, type UserRole } from '@emr/contracts';

export type PanelId =
  | 'front-desk'
  | 'doctor'
  | 'nursing'
  | 'clinic-admin'
  | 'compliance';

export interface NavItem {
  label: string;
  href: Route;
  icon: LucideIcon;
  /** Shown only if the role holds this permission. */
  permission: Permission;
  /** Extra gate beyond the permission, e.g. merge is admin-only in practice. */
  roles?: UserRole[];
  /** Live count rendered as a badge, e.g. unread inbox. */
  badgeKey?: 'inbox' | 'tasks' | 'queue';
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
  AUDITOR: 'compliance',
};

export const PANEL_LABEL: Record<PanelId, string> = {
  'front-desk': 'Front Desk',
  doctor: 'Doctor',
  nursing: 'Nursing',
  'clinic-admin': 'Clinic Admin',
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
        label: 'Appointments',
        href: '/appointments',
        icon: CalendarDays,
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

export function navigationFor(role: UserRole): NavSection[] {
  if (role === 'AUDITOR') return COMPLIANCE_SECTIONS;

  return ALL_SECTIONS.map((section) => ({
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
    label: 'Reminders',
    href: '/settings/reminders',
    permission: 'communication:read',
    description: 'When reminders go out, and when they must not',
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
