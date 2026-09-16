'use client';

import { useQuery } from '@tanstack/react-query';
import type { MessageTemplate } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { Alert, SkeletonRows } from '@/components/ui/feedback';

const PURPOSE_LABEL: Record<string, string> = {
  APPOINTMENT_REMINDER: 'Appointment reminder',
  APPOINTMENT_CONFIRMATION: 'Appointment confirmation',
  PRESCRIPTION_READY: 'Prescription ready',
  REPORT_READY: 'Report ready',
  FOLLOW_UP_DUE: 'Follow-up due',
  MISSED_APPOINTMENT: 'Missed appointment',
  SHARE_LINK_OTP: 'Secure link code',
};

/**
 * Approved message templates.
 *
 * Outside the 24-hour reply window, only these can be sent. Approval can be
 * withdrawn by the provider without warning and retroactively, which is why two
 * variants are maintained per purpose — a single rejection would otherwise take
 * that channel down entirely.
 */
export default function MessageTemplatesPage() {
  const { data, isLoading } = useQuery({
    queryKey: qk.messageTemplates,
    queryFn: () =>
      api
        .get<{ items: MessageTemplate[] }>('/whatsapp/templates')
        .catch(() => ({ items: [] as MessageTemplate[] })),
  });

  const templates = data?.items ?? [];
  const rejected = templates.filter((t) => t.status === 'REJECTED' || t.status === 'PAUSED');

  const byPurpose = templates.reduce<Record<string, MessageTemplate[]>>((acc, template) => {
    (acc[template.purpose] ??= []).push(template);
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-4">
      {rejected.length > 0 ? (
        <Alert tone="warning" title={`${rejected.length} template(s) are not usable`}>
          A paused or rejected template cannot be sent. The backup variant for
          that purpose will be used instead.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader
          title="Templates"
          description="Two are kept per purpose, so one rejection is not an outage."
        />
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : templates.length === 0 ? (
          <div className="px-4 py-6 text-sm text-ink-faint">
            No templates have been submitted yet. They are needed before reminders
            can be sent outside the reply window.
          </div>
        ) : (
          <ul className="divide-y divide-line-soft">
            {Object.entries(byPurpose).map(([purpose, group]) => (
              <li key={purpose} className="px-4 py-3">
                <p className="text-sm font-medium text-ink">
                  {PURPOSE_LABEL[purpose] ?? purpose}
                </p>
                <ul className="mt-2 flex flex-col gap-2">
                  {group.map((template) => (
                    <li
                      key={template.id}
                      className="rounded-md border border-line bg-surface-sunk/40 p-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="token text-xs text-ink">{template.name}</span>
                        <Badge
                          tone={
                            template.status === 'APPROVED'
                              ? 'positive'
                              : template.status === 'PENDING'
                                ? 'info'
                                : 'critical'
                          }
                        >
                          {template.status.toLowerCase()}
                        </Badge>
                        {template.isPrimary ? (
                          <Badge tone="neutral">Primary</Badge>
                        ) : (
                          <Badge tone="neutral">Backup</Badge>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-ink-soft">{template.body}</p>
                      {template.lastCheckedAt ? (
                        <p className="mt-1 text-2xs text-ink-faint">
                          Status checked {relativeTime(template.lastCheckedAt)}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
