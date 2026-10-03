'use client';

import Link from 'next/link';
import { AlertTriangle, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useCan } from '@/lib/session';
import { Panel, PanelBody } from '@/components/ui/surface';
import { useLabReviewSummary } from './api';

/**
 * "Results to review" — the card on the doctor's dashboard.
 *
 * WHY IT IS A CARD AND NOT A NUMBER IN A ROW OF STATS. An unread abnormal result
 * is the one thing in this product that gets worse by being ignored for a day,
 * and a figure sitting fourth in a row of six does not get looked at. So when
 * there is something critical and unread it says so in words, in red, with a
 * link; when there is nothing it shrinks to a single quiet line rather than
 * occupying the same space saying zero.
 *
 * RENDERS NOTHING WITHOUT THE PERMISSION OR THE FEATURE. A clinic that does not
 * order tests should not see a lab card, and the hook is not even called —
 * otherwise a 403 from the feature guard would surface as a console error on
 * every dashboard load.
 */
export function ResultsToReviewCard() {
  const canRead = useCan('labOrder:read');
  const summary = useLabReviewSummary(canRead);

  // No permission, or the feature is off and the request was refused.
  if (!canRead || summary.isError || !summary.data) return null;

  const { awaitingReview, criticalAwaitingReview, abnormalAwaitingReview, overdue } =
    summary.data;

  if (awaitingReview === 0 && overdue === 0) {
    return (
      <Panel>
        <PanelBody className="flex items-center gap-2">
          <FlaskConical className="size-4 shrink-0 text-ink-faint" aria-hidden />
          <p className="text-xs text-ink-soft">
            No lab results waiting to be read.{' '}
            <Link href="/lab" className="text-accent hover:underline">
              Lab
            </Link>
          </p>
        </PanelBody>
      </Panel>
    );
  }

  const critical = criticalAwaitingReview > 0;

  return (
    <Panel className={cn(critical && 'border-critical-line')}>
      <PanelBody className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-ink-faint">
            {critical ? (
              <AlertTriangle className="size-3.5 text-critical" aria-hidden />
            ) : (
              <FlaskConical className="size-3.5" aria-hidden />
            )}
            Results to review
          </p>

          {/*
            The sentence says which number matters. "3 results, 1 critical" is
            read; three separate figures are scanned past.
          */}
          <p
            className={cn(
              'mt-1 text-lg font-semibold',
              critical ? 'text-critical' : 'text-ink',
            )}
          >
            {awaitingReview > 0
              ? `${awaitingReview} result${awaitingReview === 1 ? '' : 's'} nobody has read`
              : `${overdue} test${overdue === 1 ? '' : 's'} overdue`}
          </p>

          <p className="mt-0.5 text-2xs text-ink-faint">
            {critical
              ? `${criticalAwaitingReview} well outside the reference range`
              : abnormalAwaitingReview > 0
                ? `${abnormalAwaitingReview} outside the reference range`
                : 'All within their reference ranges'}
            {overdue > 0 && awaitingReview > 0
              ? ` · ${overdue} ordered over 14 days ago with nothing back`
              : ''}
          </p>
        </div>

        <Link
          href="/lab"
          className={cn(
            'shrink-0 rounded-md px-2.5 py-1 text-xs font-medium',
            critical
              ? 'bg-critical text-critical-contrast hover:opacity-90'
              : 'border border-line bg-surface text-ink-soft hover:bg-surface-sunk hover:text-ink',
          )}
        >
          Open the lab
        </Link>
      </PanelBody>
    </Panel>
  );
}
