'use client';

import * as React from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import {
  flushOutbox,
  subscribeToOutbox,
  type OutboxEntry,
} from '@/lib/outbox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * "Offline — n changes pending."
 *
 * Persistent and impossible to miss. The requirement this satisfies is worth
 * restating: a receptionist mid-registration on a connection that drops for
 * twenty seconds must not lose the form, and must never be left guessing
 * whether their work was saved. Never a silent failure.
 */
export function OfflineBanner() {
  const [online, setOnline] = React.useState(true);
  const [pending, setPending] = React.useState<OutboxEntry[]>([]);
  const [flushing, setFlushing] = React.useState(false);

  React.useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    globalThis.addEventListener('online', up);
    globalThis.addEventListener('offline', down);
    return () => {
      globalThis.removeEventListener('online', up);
      globalThis.removeEventListener('offline', down);
    };
  }, []);

  React.useEffect(() => subscribeToOutbox(setPending), []);

  if (online && pending.length === 0) return null;

  const retry = async () => {
    setFlushing(true);
    try {
      await flushOutbox();
    } finally {
      setFlushing(false);
    }
  };

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-xs',
        online
          ? 'border-info-line bg-info-soft text-info'
          : 'border-warning-line bg-warning-soft text-warning',
      )}
    >
      <CloudOff className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium">
        {online
          ? `${pending.length} change${pending.length === 1 ? '' : 's'} waiting to send`
          : 'Offline'}
      </span>
      <span className="opacity-90">
        {online
          ? 'Sending now. You can keep working.'
          : pending.length > 0
            ? `${pending.length} change${pending.length === 1 ? '' : 's'} saved on this device. They will send when the connection returns.`
            : 'Your work is being saved on this device.'}
      </span>
      {pending.length > 0 ? (
        <>
          <details className="ml-auto">
            <summary className="cursor-pointer underline underline-offset-2">
              What is waiting
            </summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {pending.slice(0, 6).map((entry) => (
                <li key={entry.id}>
                  {entry.label}
                  {entry.attempts > 0 ? ` · ${entry.attempts} attempts` : ''}
                </li>
              ))}
              {pending.length > 6 ? <li>and {pending.length - 6} more</li> : null}
            </ul>
          </details>
          {online ? (
            <Button size="sm" variant="ghost" onClick={retry} loading={flushing}>
              <RefreshCw aria-hidden />
              Send now
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
