'use client';

import * as React from 'react';
import { FileText, Send } from 'lucide-react';
import type { WhatsappTemplate } from '@emr/contracts';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Choosing an approved template and filling it in.
 *
 * AVAILABLE AT ANY TIME, not only once the 24-hour window has shut. Outside the
 * window a template is the ONLY thing that can be sent, so it is forced; inside
 * it, it is still the fastest correct way to say "your report is ready" — which
 * is the most common message a clinic sends. Hiding it until the window closes
 * would mean the common case is only reachable in the uncommon state.
 *
 * THE PREVIEW IS THE FILLED TEXT. Someone about to send this needs to read what
 * the patient will read, not the approved body with braces in it — the whole
 * class of mistake here is a placeholder going out unfilled.
 */
export function TemplatePicker({
  open,
  onOpenChange,
  templates,
  patientName,
  sending,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: WhatsappTemplate[];
  /** Pre-fills any variable whose label mentions a name. */
  patientName?: string | null;
  sending: boolean;
  onSend: (templateId: string, variables: Record<string, string>) => void;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});

  const approved = React.useMemo(
    () => templates.filter((t) => t.status === 'APPROVED'),
    [templates],
  );
  const template = approved.find((t) => t.id === selectedId) ?? null;

  // Reset each time it opens, so yesterday's half-filled values cannot be sent
  // to today's patient.
  React.useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setValues({});
  }, [open]);

  const choose = (item: WhatsappTemplate) => {
    setSelectedId(item.id);

    // A small, honest convenience: pre-fill anything whose declared label reads
    // like a name. It is a guess, so it fills the field rather than bypassing
    // it — whoever is sending still sees and can change it.
    const prefilled: Record<string, string> = {};
    if (patientName) {
      for (const variable of item.variables) {
        if (/name|patient/i.test(variable.label)) {
          prefilled[String(variable.index)] = patientName;
        }
      }
    }
    setValues(prefilled);
  };

  const filled = template ? fill(template.body, values) : '';
  const missing = template
    ? template.variables.filter((v) => !values[String(v.index)]?.trim())
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send an approved template</DialogTitle>
        </DialogHeader>

        {approved.length === 0 ? (
          <Alert tone="warning" title="No approved template">
            WhatsApp will not let a business start a conversation with free text.
            Create a template in Meta Business Manager and sync it from Settings.
          </Alert>
        ) : null}

        <div className="flex max-h-56 flex-col gap-1 overflow-y-auto scroll-thin">
          {approved.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => choose(item)}
              aria-pressed={item.id === selectedId}
              className={cn(
                'rounded-md border px-3 py-2 text-left',
                'transition-colors duration-[--duration-ui] ease-[--ease-ui]',
                item.id === selectedId
                  ? 'border-accent bg-accent-soft'
                  : 'border-line-soft hover:bg-surface-sunk',
              )}
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="token text-sm font-medium text-ink">{item.name}</span>
                <Badge tone="neutral">{item.language}</Badge>
                {item.purpose === 'MARKETING' ? (
                  <Badge tone="warning">Marketing</Badge>
                ) : null}
              </span>
              <span className="mt-0.5 block truncate text-xs text-ink-faint">
                {item.body}
              </span>
            </button>
          ))}
        </div>

        {template ? (
          <>
            {template.variables.map((variable) => (
              <Field
                key={variable.index}
                label={variable.label}
                htmlFor={`tpl-var-${variable.index}`}
                hint={`Fills {{${variable.index}}}`}
              >
                <Input
                  id={`tpl-var-${variable.index}`}
                  value={values[String(variable.index)] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [String(variable.index)]: event.target.value,
                    }))
                  }
                />
              </Field>
            ))}

            <div className="rounded-md border border-line-soft bg-surface-sunk p-3">
              <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-ink-faint">
                What the patient will see
              </p>
              <p className="text-sm whitespace-pre-wrap text-ink">{filled}</p>
            </div>

            {missing.length > 0 ? (
              <p className="text-xs font-medium text-warning">
                Fill {missing.map((v) => v.label).join(', ')} — an unfilled
                placeholder goes out as {'{{n}}'}.
              </p>
            ) : null}
          </>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!template || missing.length > 0}
            loading={sending}
            onClick={() => template && onSend(template.id, values)}
          >
            <Send aria-hidden />
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The button that opens it. Always present, window or not. */
export function TemplateButton({
  onClick,
  forced,
}: {
  onClick: () => void;
  /** True outside the window, where a template is the only option. */
  forced: boolean;
}) {
  return (
    <Button
      type="button"
      variant={forced ? 'primary' : 'secondary'}
      onClick={onClick}
      title="Send an approved template"
    >
      <FileText aria-hidden />
      {forced ? 'Send a template' : <span className="sr-only">Send a template</span>}
    </Button>
  );
}

/** Same substitution the server performs, so the preview is not a guess. */
function fill(body: string, values: Record<string, string>): string {
  return body.replace(
    /\{\{\s*(\d+)\s*\}\}/g,
    (match, index: string) => values[index]?.trim() || match,
  );
}
