'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, Clock, FlaskConical } from 'lucide-react';
import {
  LAB_ORDER_STATUS_LABEL,
  type LabInterpretation,
  type LabOrder,
} from '@emr/contracts';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useCan } from '@/lib/session';
import { formatDateTime, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, PageHeader, Stat } from '@/components/ui/surface';
import { Alert, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  useLabLiveUpdates,
  useLabOrders,
  useLabReviewSummary,
  useReviewLabResult,
} from '@/features/lab/api';
import { EnterResultDialog } from '@/features/lab/enter-result-dialog';

/**
 * Lab: what is outstanding, and what nobody has read.
 *
 * THE UNREAD RESULT IS THE WHOLE SCREEN. A clinic that orders a test and never
 * looks at what came back is the failure this module exists to surface, so the
 * default view is "awaiting", the critical count is the loudest thing on the
 * page, and marking something reviewed is a deliberate act rather than a side
 * effect of this page loading.
 *
 * ORDERS WITH NO RESULT ARE SHOWN TOO, under the same heading. An order the
 * patient never went for looks exactly like one the lab is slow with, and both
 * need the same phone call — distinguishing them is not something this product
 * can do, so it does not pretend to.
 */
export default function LabPage() {
  const toast = useToast();
  const canReview = useCan('labOrder:update');

  const [showAll, setShowAll] = React.useState(false);
  const [resulting, setResulting] = React.useState<LabOrder | null>(null);

  const orders = useLabOrders({ awaiting: !showAll });
  const summary = useLabReviewSummary();
  const review = useReviewLabResult();
  useLabLiveUpdates();

  const rows = orders.data ?? [];
  const resulted = rows.filter((o) => o.status === 'RESULTED');
  const awaitingResult = rows.filter((o) => o.status === 'ORDERED');
  const other = rows.filter((o) => o.status !== 'RESULTED' && o.status !== 'ORDERED');

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title="Lab"
        description="Results that have come back, and tests still outstanding."
        actions={
          <Button variant="secondary" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show only what needs attention' : 'Show everything'}
          </Button>
        }
      />

      {summary.data ? (
        <div className="grid gap-4 sm:grid-cols-4">
          <Panel>
            <PanelBody>
              <Stat
                label="To review"
                value={summary.data.awaitingReview}
                hint="Results in, nobody has read them"
                tone={summary.data.awaitingReview > 0 ? 'warning' : 'neutral'}
              />
            </PanelBody>
          </Panel>
          <Panel>
            <PanelBody>
              <Stat
                label="Critical, unread"
                value={summary.data.criticalAwaitingReview}
                hint="Well outside the reference range"
                tone={summary.data.criticalAwaitingReview > 0 ? 'critical' : 'neutral'}
              />
            </PanelBody>
          </Panel>
          <Panel>
            <PanelBody>
              <Stat
                label="Awaiting result"
                value={summary.data.awaitingResult}
                hint="Ordered, nothing back yet"
              />
            </PanelBody>
          </Panel>
          <Panel>
            <PanelBody>
              <Stat
                label="Overdue"
                value={summary.data.overdue}
                /*
                 * Worded as the two things it might be, because the product
                 * cannot tell them apart and both need the same phone call.
                 */
                hint="Ordered over 14 days ago — chase the lab, or the patient"
                tone={summary.data.overdue > 0 ? 'warning' : 'neutral'}
              />
            </PanelBody>
          </Panel>
        </div>
      ) : null}

      {summary.data && summary.data.criticalAwaitingReview > 0 ? (
        <Alert
          tone="critical"
          title={`${summary.data.criticalAwaitingReview} critical result${
            summary.data.criticalAwaitingReview === 1 ? '' : 's'
          } nobody has read`}
        >
          Well outside the reference range. The flag is a prompt to look, not a
          diagnosis — the ranges are adult and not adjusted for age or sex.
        </Alert>
      ) : null}

      {orders.isError ? (
        <ErrorState
          title="Could not load the lab list"
          description={
            orders.error instanceof ApiError ? orders.error.message : undefined
          }
          onRetry={() => void orders.refetch()}
        />
      ) : orders.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title={showAll ? 'No lab orders yet' : 'Nothing needs attention'}
          description={
            showAll
              ? 'Order a test from a consultation and it will appear here.'
              : 'Every result that has come back has been reviewed.'
          }
        />
      ) : (
        <>
          {resulted.length > 0 ? (
            <Panel>
              <PanelHeader
                title="Results to review"
                description="These have come back and nobody has marked them read."
              />
              <PanelBody className="flex flex-col gap-2">
                {resulted.map((order) => (
                  <OrderRow
                    key={order.id}
                    order={order}
                    canReview={canReview}
                    reviewing={review.isPending}
                    onReview={() =>
                      review.mutate(order.id, {
                        onSuccess: () => toast.success('Marked as reviewed'),
                        onError: (error) =>
                          toast.error(
                            'Could not mark it reviewed',
                            error instanceof ApiError ? error.message : undefined,
                          ),
                      })
                    }
                    onEnterResult={() => setResulting(order)}
                  />
                ))}
              </PanelBody>
            </Panel>
          ) : null}

          {awaitingResult.length > 0 ? (
            <Panel>
              <PanelHeader
                title="Awaiting a result"
                description="Ordered, nothing back yet."
              />
              <PanelBody className="flex flex-col gap-2">
                {awaitingResult.map((order) => (
                  <OrderRow
                    key={order.id}
                    order={order}
                    canReview={canReview}
                    reviewing={false}
                    onEnterResult={() => setResulting(order)}
                  />
                ))}
              </PanelBody>
            </Panel>
          ) : null}

          {other.length > 0 ? (
            <Panel>
              <PanelHeader title="Reviewed and cancelled" />
              <PanelBody className="flex flex-col gap-2">
                {other.map((order) => (
                  <OrderRow
                    key={order.id}
                    order={order}
                    canReview={false}
                    reviewing={false}
                  />
                ))}
              </PanelBody>
            </Panel>
          ) : null}
        </>
      )}

      <EnterResultDialog order={resulting} onClose={() => setResulting(null)} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function OrderRow({
  order,
  canReview,
  reviewing,
  onReview,
  onEnterResult,
}: {
  order: LabOrder;
  canReview: boolean;
  reviewing: boolean;
  onReview?: () => void;
  onEnterResult?: () => void;
}) {
  const result = order.result;
  const critical = result?.interpretation === 'CRITICAL';

  return (
    <div
      className={cn(
        'flex flex-wrap items-start gap-3 rounded-md border p-3',
        critical ? 'border-critical-line bg-critical-soft' : 'border-line bg-surface-sunk/40',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/patients/${order.patientId}`}
            className="text-sm font-medium text-ink hover:underline"
          >
            {order.patientName}
          </Link>
          <span className="text-2xs text-ink-faint">{order.patientMrn}</span>
          {order.isUrgent ? <Badge tone="warning">Urgent</Badge> : null}
        </div>

        <p className="mt-0.5 text-sm text-ink">
          {order.testName}
          {result ? (
            <span
              className={cn(
                'ml-2 font-semibold tabular',
                critical
                  ? 'text-critical'
                  : result.interpretation === 'HIGH' || result.interpretation === 'LOW'
                    ? 'text-warning'
                    : 'text-ink',
              )}
            >
              {result.valueNumeric ?? result.valueText}
              {result.unit && result.valueNumeric !== null ? ` ${result.unit}` : ''}
            </span>
          ) : null}
        </p>

        {result ? (
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs">
            {result.interpretation ? (
              <Badge tone={INTERPRETATION_TONE[result.interpretation]}>
                {INTERPRETATION_LABEL[result.interpretation]}
              </Badge>
            ) : (
              /*
               * Not "normal". A narrative report was never range-checked, and
               * saying it was in range would be a claim nobody made.
               */
              <span className="text-ink-faint">Not range-checked</span>
            )}
            {result.referenceLow !== null && result.referenceHigh !== null ? (
              <span className="text-ink-faint">
                ref {result.referenceLow}–{result.referenceHigh}
                {result.unit ? ` ${result.unit}` : ''}
              </span>
            ) : null}
            {result.performedBy ? (
              <span className="text-ink-faint">· {result.performedBy}</span>
            ) : null}
            <span className="text-ink-faint">· {relativeTime(result.resultedAt)}</span>
          </p>
        ) : (
          <p className="mt-0.5 text-2xs text-ink-faint">
            <Clock className="mr-1 inline size-3" aria-hidden />
            Ordered {relativeTime(order.orderedAt)}
            {order.orderedByName ? ` by ${order.orderedByName}` : ''}
          </p>
        )}

        {result?.labNote ? (
          <p className="mt-1 text-2xs text-ink-soft">{result.labNote}</p>
        ) : null}
        {order.clinicalNote ? (
          <p className="mt-1 text-2xs text-ink-faint">Asked for: {order.clinicalNote}</p>
        ) : null}
        {result?.supersededReason ? (
          <p className="mt-1 text-2xs text-warning">
            Corrected: {result.supersededReason}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <Badge tone={order.status === 'REVIEWED' ? 'positive' : 'neutral'}>
          {order.status === 'REVIEWED' ? (
            <Check className="size-3" aria-hidden />
          ) : critical ? (
            <AlertTriangle className="size-3" aria-hidden />
          ) : null}
          {LAB_ORDER_STATUS_LABEL[order.status]}
        </Badge>

        {order.status === 'REVIEWED' && order.reviewedAt ? (
          <span className="text-2xs text-ink-faint">{formatDateTime(order.reviewedAt)}</span>
        ) : null}

        {canReview && order.status === 'RESULTED' && onReview ? (
          <Button size="sm" variant="primary" loading={reviewing} onClick={onReview}>
            Mark reviewed
          </Button>
        ) : null}
        {canReview && onEnterResult ? (
          <Button size="sm" variant="secondary" onClick={onEnterResult}>
            {order.result ? 'Correct result' : 'Enter result'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const INTERPRETATION_LABEL: Record<LabInterpretation, string> = {
  NORMAL: 'In range',
  LOW: 'Below range',
  HIGH: 'Above range',
  CRITICAL: 'Well outside range',
  ABNORMAL: 'Abnormal',
};

const INTERPRETATION_TONE: Record<
  LabInterpretation,
  'neutral' | 'warning' | 'critical' | 'positive'
> = {
  NORMAL: 'positive',
  LOW: 'warning',
  HIGH: 'warning',
  CRITICAL: 'critical',
  ABNORMAL: 'warning',
};
