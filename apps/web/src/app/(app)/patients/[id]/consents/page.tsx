'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { CONSENT_SCOPE_LABEL, ConsentScope, type Consent } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { formatDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { SkeletonRows } from '@/components/ui/feedback';
import { useCan } from '@/lib/session';

/**
 * Consent, one row per purpose.
 *
 * Data protection law requires consent that is purpose-specific, informed and
 * independently withdrawable — so this is never a single "I agree" checkbox.
 * Each purpose is granted and withdrawn on its own, and the version of the
 * notice the patient was shown is recorded alongside it.
 *
 * Withdrawn consents are not deleted. Proving that consent WAS held at the time
 * of a past processing activity is the whole point of the record.
 */
export default function PatientConsentsPage() {
  const params = useParams<{ id: string }>();
  const canManage = useCan('consent:create');

  const { data, isLoading } = useQuery({
    queryKey: qk.patientConsents(params.id),
    queryFn: () => api.get<Consent[]>(`/patients/${params.id}/consents`).catch(() => []),
  });

  const consents = data ?? [];
  const scopes = ConsentScope.options;

  return (
    <Panel>
      <PanelHeader
        title="Consent"
        description="Each purpose is agreed and withdrawn separately."
      />
      {isLoading ? (
        <SkeletonRows rows={6} />
      ) : (
        <ul className="divide-y divide-line-soft">
          {scopes.map((scope) => {
            const held = consents.find(
              (c) => c.scope === scope && c.status === 'ACTIVE',
            );
            return (
              <li key={scope} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">
                    {CONSENT_SCOPE_LABEL[scope]}
                  </p>
                  <p className="mt-0.5 text-2xs text-ink-faint">
                    {held
                      ? `Given ${formatDate(held.grantedAt)} · notice version ${held.policyVersion} · ${held.presentedLanguage}`
                      : 'Not recorded'}
                  </p>
                </div>

                {held ? (
                  <Badge tone="positive">
                    <Check aria-hidden />
                    Given
                  </Badge>
                ) : (
                  <Badge tone="neutral">
                    <X aria-hidden />
                    Not given
                  </Badge>
                )}

                {canManage ? (
                  <Button size="sm" variant="secondary">
                    {held ? 'Withdraw' : 'Record consent'}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
