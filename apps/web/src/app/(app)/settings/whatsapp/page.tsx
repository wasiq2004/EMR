'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CircleAlert,
  ExternalLink,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import {
  ConnectWhatsapp,
  type WhatsappAccount,
  type WhatsappTemplate,
} from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { formatDate, formatPhone } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/field';
import { DataList, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The clinic's own WhatsApp number.
 *
 * Each clinic connects its own account so messages come from the clinic rather
 * than from the platform. Three things on this screen are warnings rather than
 * settings:
 *
 *   - CAN IT ACTUALLY SEND. A connected row can exist with no usable token. A
 *     clinic that believes a prescription reminder reached a patient, when it
 *     reached nobody, is worse off than one that knows the channel is not live.
 *   - QUALITY RATING. A falling rating precedes the provider suspending the
 *     number, so it is surfaced before it becomes an outage.
 *   - DATA RESIDENCY. Anything other than India is a compliance finding for an
 *     Indian clinic, not a preference.
 */
export default function WhatsappSettingsPage() {
  const session = useSession();
  const toast = useToast();
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);
  const queryClient = useQueryClient();

  // Connecting repoints the clinic's number. A receptionist sends messages all
  // day and must never be able to do that; the server enforces it too.
  const canConfigure = session.role === 'OWNER_ADMIN';

  const account = useQuery({
    queryKey: qk.whatsappAccount,
    queryFn: () =>
      api.get<WhatsappAccount | null>('/whatsapp/account').catch(() => null),
  });

  const templates = useQuery({
    queryKey: ['whatsapp', 'templates'],
    queryFn: () => api.get<{ items: WhatsappTemplate[] }>('/whatsapp/templates'),
  });

  const sync = useMutation({
    mutationFn: () =>
      api.post<{ synced: number; approved: number }>('/whatsapp/templates/sync', {}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'templates'] });
      toast.success(
        `${result.synced} template${result.synced === 1 ? '' : 's'} synced, ${result.approved} approved`,
      );
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not reach WhatsApp'),
  });

  const disconnect = useMutation({
    mutationFn: () => api.post('/whatsapp/account/disconnect', {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.whatsappAccount });
      setDisconnectOpen(false);
      toast.success('Number disconnected');
    },
  });

  if (account.isLoading) return <Skeleton className="h-64 w-full" />;

  const data = account.data;

  if (!data) {
    return (
      <>
        <Panel>
          <EmptyState
            icon={MessageSquare}
            title="No WhatsApp number connected"
            description="Connect the clinic's own number so patients receive messages from you, not from the platform."
            action={
              canConfigure ? (
                <Button variant="primary" onClick={() => setConnectOpen(true)}>
                  Connect a number
                </Button>
              ) : (
                <p className="text-sm text-ink-faint">
                  A clinic administrator can connect one.
                </p>
              )
            }
          />
        </Panel>
        <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      </>
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
      {/*
        First, because it is the difference between messages going out and
        messages being recorded as though they did.
      */}
      {!data.canSend ? (
        <Alert tone="warning" title="This number cannot send yet">
          The number is connected but there is no working access token, so
          messages are recorded and nothing leaves the building. Reconnect it
          with a permanent token to start sending.
        </Alert>
      ) : null}

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
          actions={
            canConfigure ? (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setConnectOpen(true)}>
                  Replace
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDisconnectOpen(true)}>
                  <Unplug aria-hidden />
                  Disconnect
                </Button>
              </div>
            ) : null
          }
        />
        <PanelBody>
          <DataList
            items={[
              {
                label: 'Number',
                value: <span className="token">{formatPhone(data.displayPhoneE164)}</span>,
              },
              { label: 'Verified name', value: data.verifiedName ?? 'Not verified' },
              {
                label: 'Sending',
                value: data.canSend ? (
                  <Badge tone="positive">
                    <ShieldCheck aria-hidden />
                    Live
                  </Badge>
                ) : (
                  <Badge tone="warning">
                    <CircleAlert aria-hidden />
                    Recorded only
                  </Badge>
                ),
              },
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
                label: 'Access token',
                value: (
                  <span className="token text-ink-faint">
                    {data.tokenHint ?? 'Not set'}
                  </span>
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

      <TemplatesPanel
        templates={templates.data?.items ?? []}
        loading={templates.isLoading}
        canConfigure={canConfigure}
        syncing={sync.isPending}
        onSync={() => sync.mutate()}
      />

      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} replacing />

      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Disconnect this number?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ink-soft">
            Reminders and broadcasts stop immediately. Conversations and the
            messages already sent are kept — they are part of the patient record —
            but the access token is destroyed and cannot be recovered.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDisconnectOpen(false)}>
              Keep it connected
            </Button>
            <Button
              variant="critical"
              loading={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* --------------------------------------------------------------------------- */

/**
 * The templates the provider has approved.
 *
 * Shown here rather than on their own screen because a template is only ever
 * useful in relation to the number it belongs to, and because an administrator
 * checking why a reminder did not go out looks at the number first.
 */
function TemplatesPanel({
  templates,
  loading,
  canConfigure,
  syncing,
  onSync,
}: {
  templates: WhatsappTemplate[];
  loading: boolean;
  canConfigure: boolean;
  syncing: boolean;
  onSync: () => void;
}) {
  const approved = templates.filter((t) => t.status === 'APPROVED');

  return (
    <Panel>
      <PanelHeader
        title="Message templates"
        description={
          templates.length > 0
            ? `${approved.length} of ${templates.length} approved and usable`
            : 'WhatsApp will not let a business start a conversation with free text.'
        }
        actions={
          canConfigure ? (
            <Button size="sm" variant="secondary" loading={syncing} onClick={onSync}>
              <RefreshCw aria-hidden />
              Sync from WhatsApp
            </Button>
          ) : null
        }
      />
      <PanelBody className="flex flex-col gap-2">
        {loading ? <Skeleton className="h-20 w-full" /> : null}

        {!loading && templates.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No templates yet. Create them in Meta Business Manager, then sync —
            outside the 24-hour reply window a template is the only thing that can
            be sent, so reminders and broadcasts need at least one approved.
          </p>
        ) : null}

        {templates.map((template) => (
          <TemplateRow key={template.id} template={template} />
        ))}

        {/*
          Two per purpose, not one. Approval can be withdrawn retroactively and
          without warning, and a single template per purpose means one rejection
          takes that entire channel down.
        */}
        {approved.length > 0 && approved.length < 2 ? (
          <Alert tone="info" title="Keep a spare for each purpose">
            WhatsApp can pause or reject a template without warning and
            retroactively. With only one approved template, a single rejection
            stops that kind of message entirely.
          </Alert>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function TemplateRow({ template }: { template: WhatsappTemplate }) {
  const tone =
    template.status === 'APPROVED'
      ? 'positive'
      : template.status === 'REJECTED' || template.status === 'DISABLED'
        ? 'critical'
        : 'warning';

  return (
    <div className="rounded-md border border-line-soft bg-surface-sunk px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="token text-sm font-medium text-ink">{template.name}</span>
        <Badge tone={tone as never}>{template.status}</Badge>
        <Badge tone="neutral">{template.language}</Badge>
        {/*
          Which consent this template's content needs. A marketing template sent
          under a clinical consent is the thing that gets a number blocked.
        */}
        {template.purpose === 'MARKETING' ? (
          <Badge tone="warning">Needs marketing consent</Badge>
        ) : null}
      </div>

      <p className="mt-1.5 text-sm whitespace-pre-wrap text-ink-soft">{template.body}</p>

      {template.statusReason ? (
        <p className="mt-1 text-xs text-critical">{template.statusReason}</p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------------- */

/**
 * The connect form.
 *
 * Validated with the SAME Zod schema the API parses the request with, imported
 * from @emr/contracts — so a rule cannot be enforced in one place and not the
 * other. The three fields are easy to confuse with each other, so each one says
 * what it is not: the Phone Number ID in particular is not the phone number,
 * and people paste the phone number into it constantly.
 */
function ConnectDialog({
  open,
  onOpenChange,
  replacing = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  replacing?: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [serverError, setServerError] = React.useState<string | null>(null);

  const form = useForm<ConnectWhatsapp>({
    resolver: zodResolver(ConnectWhatsapp),
    defaultValues: { wabaId: '', phoneNumberId: '', accessToken: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await api.post('/whatsapp/account', values);
      await queryClient.invalidateQueries({ queryKey: qk.whatsappAccount });
      await queryClient.invalidateQueries({ queryKey: ['whatsapp', 'templates'] });
      form.reset();
      onOpenChange(false);
      toast.success('WhatsApp number connected');
    } catch (error) {
      // The credential is verified against WhatsApp BEFORE anything is stored,
      // so the failure arrives here with the values still on screen — rather
      // than silently at 9am when the first reminder does not go out.
      setServerError(
        error instanceof ApiError ? error.message : 'That number could not be verified.',
      );
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {replacing ? 'Replace the connected number' : 'Connect a WhatsApp number'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-sm text-ink-soft">
            From Meta Business Manager, under WhatsApp → API setup. These are
            checked against WhatsApp before anything is saved.
          </p>

          {serverError ? <Alert tone="critical" title={serverError} /> : null}

          {replacing ? (
            <Alert tone="warning" title="This replaces the current number">
              Messages already sent are kept. The previous access token is
              destroyed.
            </Alert>
          ) : null}

          <Field
            label="WhatsApp Business Account ID"
            hint="All digits. Shown as 'WhatsApp Business Account ID' in Meta."
            htmlFor="wa-wabaId"
            error={form.formState.errors.wabaId?.message}
            required
          >
            <Input id="wa-wabaId" {...form.register('wabaId')} inputMode="numeric" autoComplete="off" />
          </Field>

          <Field
            label="Phone Number ID"
            hint="All digits — this is NOT the phone number itself."
            htmlFor="wa-phoneNumberId"
            error={form.formState.errors.phoneNumberId?.message}
            required
          >
            <Input
              id="wa-phoneNumberId"
              {...form.register('phoneNumberId')}
              inputMode="numeric"
              autoComplete="off"
            />
          </Field>

          <Field
            label="Permanent access token"
            hint="Use a System User token. A temporary one expires in 24 hours and every message stops."
            htmlFor="wa-accessToken"
            error={form.formState.errors.accessToken?.message}
            required
          >
            {/*
              Masked so it is not read over a shoulder at a front desk, and
              autoComplete=off so a browser never offers to save a credential
              that belongs to the clinic rather than to the person.

              The reveal is here because this one is PASTED rather than typed —
              a Meta token is a couple of hundred characters, and the way it
              goes wrong is a truncated copy or a leading space, neither of
              which is visible behind dots. The failure otherwise surfaces much
              later as reminders that silently never send.
            */}
            <PasswordInput
              id="wa-accessToken"
              {...form.register('accessToken')}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <a
            href="https://developers.facebook.com/docs/whatsapp/business-management-api/get-started"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
          >
            Where do I find these?
            <ExternalLink className="size-3" aria-hidden />
          </a>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
              Verify and connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
