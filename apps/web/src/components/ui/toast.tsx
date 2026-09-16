'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Transient confirmations.
 *
 * A toast confirms that something happened — "Prescription sent to Lakshmi
 * Narayanan". It is never used for anything the user must act on, because a
 * message that disappears on its own cannot carry a decision. Safety warnings
 * are modals; failed deliveries become tasks.
 */

type ToastTone = 'success' | 'info' | 'error';

interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (t: Omit<Toast, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    (input: Omit<Toast, 'id'>) => {
      const id = globalThis.crypto.randomUUID();
      setToasts((current) => [...current, { ...input, id }]);
      // Errors linger; confirmations get out of the way.
      const ttl = input.tone === 'error' ? 8000 : 4000;
      globalThis.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  const value = React.useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ tone: 'success', title, description }),
      error: (title, description) => toast({ tone: 'error', title, description }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const config = {
    success: { icon: CheckCircle2, cls: 'text-positive' },
    info: { icon: Info, cls: 'text-info' },
    error: { icon: AlertTriangle, cls: 'text-critical' },
  }[toast.tone];
  const Icon = config.icon;

  return (
    <div className="pointer-events-auto flex gap-2.5 rounded-md border border-line bg-surface-raised p-3 shadow-pop">
      <Icon className={cn('mt-0.5 size-4 shrink-0', config.cls)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 text-xs text-ink-soft">{toast.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
        aria-label="Dismiss"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
