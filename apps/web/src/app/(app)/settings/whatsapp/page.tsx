'use client';

import { useQuery } from '@tanstack/react-query';
import { MessageSquare, ShieldCheck } from 'lucide-react';
import type { WhatsappAccount } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { formatDate, formatPhone } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataList, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';

/**
 * The clinic's own WhatsApp number.
 *
 * Each clinic connects its own account so messages come from the clinic, not
 * from the platform. Two things on this screen are early warnings rather than
 * settings:
 *
 *   - QUALITY RATING. A falling rating precedes the provider suspending the
 *     number, so it is surfaced before it becomes an outage.
 *   - DATA RESIDENCY. Anything other than India is a compliance finding for an
 *     Indian clinic, not a preference.
 */
export default function WhatsappSettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: qk.whatsappAccount,
    queryFn: () =>
      api.get<WhatsappAccount | null>('/whatsapp/account').catch(() => null),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  if (!data) {
    return (
      <Panel>
        <EmptyState
          icon={MessageSquare}
          title="No WhatsApp number connected"
          description="Connect the clinic's own number so patients receive messages from you, not from the platform."
          action={<Button variant="primary">Connect a number</Button>}
        />
      </Panel>
    );
  }

  const ratingTone =
    data.qualityRating === 'GREEN'
      ? 'positive'
      : data.qualityRating === 'YELLOW'
        ? 'warning'
        : data.qualityRating === 'RED'
          ? 'critical'
          : 'neutral';

  const residencyOk = data.localStorageRegion === 'India';

  return (
    <div className="flex flex-col gap-4">
      {data.qualityRating === 'RED' || data.qualityRating === 'YELLOW' ? (
        <Alert tone="warning" title="Message quality rating has dropped">
          A low rating can lead to the number being suspended. Send only
          transactional messages, and make sure patients expect what they receive.
        </Alert>
      ) : null}

      {!residencyOk ? (
        <Alert tone="critical" title="Messages are not stored in India">
          This number is not configured for Indian data residency. That is a
          compliance finding for a clinic operating here and should be corrected
          with the provider.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader
          title="Connected number"
          actions={<Button size="sm" variant="secondary">Disconnect</Button>}
        />
        <PanelBody>
          <DataList
            items={[
              {
                label: 'Number',
                value: (
                  <span className="token">{formatPhone(data.displayPhoneE164)}</span>
                ),
              },
              { label: 'Verified name', value: data.verifiedName ?? 'Not verified' },
              {
                label: 'Quality rating',
                value: <Badge tone={ratingTone as never}>{data.qualityRating}</Badge>,
              },
              { label: 'Sending tier', value: data.messagingTier ?? 'Not set' },
              {
                label: 'Data stored in',
                value: residencyOk ? (
                  <Badge tone="positive">
                    <ShieldCheck aria-hidden />
                    India
                  </Badge>
                ) : (
                  <Badge tone="critical">{data.localStorageRegion ?? 'Unknown'}</Badge>
                ),
              },
              {
                label: 'Connected',
                value: data.connectedAt ? formatDate(data.connectedAt) : 'Unknown',
              },
            ]}
          />
        </PanelBody>
      </Panel>
    </div>
  );
}
