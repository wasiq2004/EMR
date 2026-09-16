'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { settingsLinksFor } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/surface';

/** Settings, with a sub-navigation filtered by what the role may see. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const links = settingsLinksFor(session.role);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader title="Settings" description={session.clinicName} />

      <div className="grid gap-5 lg:grid-cols-[14rem_1fr]">
        <nav aria-label="Settings" className="lg:sticky lg:top-20 lg:self-start">
          <ul className="flex flex-wrap gap-1 lg:flex-col">
            {links.map((link) => {
              const active = pathname === link.href;
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-2.5 py-2 text-sm transition-colors',
                      active
                        ? 'bg-accent-soft font-medium text-accent-ink'
                        : 'text-ink-soft hover:bg-surface-sunk hover:text-ink',
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
