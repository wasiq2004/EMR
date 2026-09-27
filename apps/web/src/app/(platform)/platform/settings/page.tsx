'use client';

import * as React from 'react';
import { Settings2 } from 'lucide-react';
import { usePlatformSettings, useSaveSetting, type SettingRow } from '@/features/platform/api';
import { ApiError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, SkeletonRows } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';

/**
 * Deployment settings.
 *
 * DECLARED IN CODE, STORED WHEN CHANGED. The list of settings comes from the server's
 * own definition rather than from rows in a table, so a setting added next month
 * appears here immediately and an old one disappears — instead of lingering in a table
 * that nothing reads.
 *
 * A setting still showing its default has no stored row at all, and that is worth
 * showing: "this is the default" and "someone chose this value, which happens to equal
 * the default" are different facts when you are working out why a deployment behaves
 * the way it does.
 */
export default function PlatformSettingsPage() {
  const settings = usePlatformSettings();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Settings"
        description="How this deployment behaves. Applies to every clinic on it."
      />

      <Alert tone="info" title="These are deployment-wide, not per clinic">
        A clinic&apos;s own plan, limits and modules live on its record. Anything here changes
        the behaviour of the whole installation.
      </Alert>

      <Panel>
        <PanelHeader title="Configuration" />
        <PanelBody>
          {settings.isLoading ? (
            <SkeletonRows rows={6} />
          ) : (
            <div className="space-y-3">
              {(settings.data ?? []).map((setting) => (
                <SettingField key={setting.key} setting={setting} />
              ))}
            </div>
          )}
        </PanelBody>
      </Panel>

      <p className="flex items-start gap-1.5 text-2xs text-ink-faint">
        <Settings2 className="mt-0.5 size-3 shrink-0" aria-hidden />
        Every change is recorded in the operator log with the previous value, so &ldquo;why is
        this deployment behaving differently&rdquo; is answerable.
      </p>
    </div>
  );
}

/**
 * One setting, typed by its declaration.
 *
 * Saved on an explicit press rather than on blur. A pricing figure that commits itself
 * because someone clicked away mid-edit is the kind of thing nobody notices until the
 * month-end bill.
 */
function SettingField({ setting }: { setting: SettingRow }) {
  const toast = useToast();
  const save = useSaveSetting();

  const asString = (value: unknown) =>
    typeof value === 'boolean' ? String(value) : value === null ? '' : String(value);

  const [draft, setDraft] = React.useState(() => asString(setting.value));

  React.useEffect(() => {
    setDraft(asString(setting.value));
  }, [setting.value]);

  const dirty = draft !== asString(setting.value);

  const parsed = (): unknown => {
    if (setting.type === 'boolean') return draft === 'true';
    if (setting.type === 'number') return Number(draft);
    return draft;
  };

  const invalid = setting.type === 'number' && (draft === '' || Number.isNaN(Number(draft)));

  return (
    <div className="rounded-md border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{setting.label}</span>
            <span className="token text-2xs text-ink-faint">{setting.key}</span>
            {setting.isDefault ? <Badge>default</Badge> : <Badge tone="info">set</Badge>}
          </div>
          <p className="mt-0.5 max-w-prose text-xs text-ink-faint">{setting.description}</p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        {setting.type === 'boolean' ? (
          <Field label="Value" htmlFor={`set-${setting.key}`} className="w-40">
            <Select
              id={`set-${setting.key}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            >
              <option value="false">Off</option>
              <option value="true">On</option>
            </Select>
          </Field>
        ) : (
          <Field
            label="Value"
            htmlFor={`set-${setting.key}`}
            className="w-56"
            error={invalid ? 'Enter a number.' : undefined}
          >
            <Input
              id={`set-${setting.key}`}
              type={setting.type === 'number' ? 'number' : 'text'}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
        )}

        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || invalid}
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              { key: setting.key, value: parsed() },
              {
                onSuccess: () => toast.success(`${setting.label} saved`),
                onError: (error) =>
                  toast.error(error instanceof ApiError ? error.message : 'That did not save'),
              },
            )
          }
        >
          Save
        </Button>

        {dirty ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft(asString(setting.value))}
          >
            Discard
          </Button>
        ) : null}
      </div>

      {setting.key === 'allowSelfServiceSignup' && draft === 'true' ? (
        <Alert tone="warning" title="The sign-up flow does not exist yet" className="mt-2">
          Turning this on records the intent but changes nothing a customer can see — there
          is no public sign-up screen to enable. Clinics are onboarded from the Clinics
          page until one is built.
        </Alert>
      ) : null}
    </div>
  );
}
