'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReportSummary } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { Panel, PanelBody, PanelHeader, PageHeader, Stat } from '@/components/ui/surface';
import { Alert, SkeletonRows } from '@/components/ui/feedback';

/**
 * Aggregate reports for compliance review.
 *
 * Counts and rates only. No figure here can be traced back to an individual
 * patient, and that is enforced by the API's response contract rather than by
 * this screen choosing not to ask — a UI decision would be one refactor away
 * from leaking.
 */
export default function ComplianceReportsPage() {
  const { data, isLoading } = useQuery({
    queryKey: qk.reports('compliance', 'today'),
    queryFn: () => api.get<ReportSummary>('/reports/summary'),
    staleTime: 0,
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Aggregate reports"
        description="Totals only. Nothing here identifies a patient."
      />

      <Alert tone="info" title="These figures are counts, not records">
        Compliance reporting is served as aggregates by design. If you need to
        examine a specific record, that is a request to the clinic, not something
        this panel can do.
      </Alert>

      {isLoading ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Panel>
              <PanelBody>
                <Stat label="Consultations" value={data?.visits ?? 0} hint="Last 14 days" />
              </PanelBody>
            </Panel>
            <Panel>
              <PanelBody>
                <Stat label="New registrations" value={data?.newPatients ?? 0} />
              </PanelBody>
            </Panel>
            <Panel>
              <PanelBody>
                <Stat label="Appointments" value={data?.appointmentsBooked ?? 0} />
              </PanelBody>
            </Panel>
            <Panel>
              <PanelBody>
                <Stat label="Did not attend" value={data?.noShows ?? 0} />
              </PanelBody>
            </Panel>
          </div>

          <Panel>
            <PanelHeader
              title="Activity by clinician"
              description="Volume only — no clinical content."
            />
            <ul className="divide-y divide-line-soft">
              {(data?.byPractitioner ?? []).map((row) => (
                <li
                  key={row.practitionerId}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <span className="text-sm text-ink">{row.practitionerName}</span>
                  <span className="text-sm tabular text-ink-soft">
                    {row.visits} consultations
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </div>
  );
}
