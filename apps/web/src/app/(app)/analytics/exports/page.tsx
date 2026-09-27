'use client';

import * as React from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useAnalystExports } from '@/features/research/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { DataState } from '@/components/ui/data-state';
import { Alert } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Table, TBody, TD, TH, THead, TR, TableScroller } from '@/components/ui/table';

/**
 * The export register.
 *
 * WHAT THIS PAGE IS FOR, and it is not downloads: it is the record of what left the
 * system, when, on whose authority, and with which columns. The blueprint asks that an
 * export carry its cohort definition, its generation time and its source version, and
 * this is where a reviewer reads them back.
 *
 * The column list is shown on every row. A reviewer can confirm no identifying field was
 * included without finding and opening the file — which they may no longer be able to do,
 * since a download expires after seven days.
 */
export default function ExportsPage() {
  const exports = useAnalystExports();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Exports"
        description="What left the system, and the definition that produced it."
      />

      <Alert tone="info" title="Every export records its own provenance">
        The definition as it was, its version, the generation time and the exact columns. A
        cohort edited afterwards does not retroactively change what an earlier export claims
        to have been.
      </Alert>

      <Panel>
        <PanelHeader title="Register" />
        <PanelBody>
          <DataState
            query={exports}
            empty={{
              icon: ClipboardCheck,
              title: 'Nothing exported yet',
              description: 'Run a cohort and export it; the record appears here.',
            }}
          >
            {(items) => (
              <TableScroller>
                <Table>
                  <THead>
                    <TR>
                      <TH>Cohort</TH>
                      <TH>Type</TH>
                      <TH align="right">Rows</TH>
                      <TH>Columns</TH>
                      <TH>By</TH>
                      <TH>When</TH>
                      <TH>Available until</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {items.map((row) => {
                      const expired =
                        row.downloadExpiresAt !== null &&
                        new Date(row.downloadExpiresAt) < new Date();
                      return (
                        <TR key={row.id}>
                          <TD>
                            <span className="font-medium text-ink">{row.cohortName}</span>
                            <span className="block text-2xs text-ink-faint">
                              definition v{row.definitionVersion}
                            </span>
                          </TD>
                          <TD className="text-ink-soft">{row.exportType.replace(/_/g, ' ')}</TD>
                          <TD align="right" className="tabular">
                            {row.rowCount ?? '—'}
                          </TD>
                          <TD>
                            <div className="flex max-w-xs flex-wrap gap-1">
                              {(row.columnsIncluded ?? []).map((column) => (
                                <span key={column} className="token text-2xs text-ink-faint">
                                  {column}
                                </span>
                              ))}
                            </div>
                          </TD>
                          <TD className="text-ink-soft">{row.requestedByName ?? '—'}</TD>
                          <TD className="whitespace-nowrap text-ink-faint">
                            {formatDateTime(row.requestedAt)}
                          </TD>
                          <TD>
                            {row.downloadExpiresAt === null ? (
                              '—'
                            ) : expired ? (
                              <Badge>expired</Badge>
                            ) : (
                              <span className="text-xs text-ink-soft">
                                {relativeTime(row.downloadExpiresAt)}
                              </span>
                            )}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </TableScroller>
            )}
          </DataState>
        </PanelBody>
      </Panel>

      <p className="text-2xs text-ink-faint">
        Files are written in your browser at the moment you export, not stored on the
        server. Even de-identified, an extract accumulating in storage is a liability with
        no owner — so the register keeps the record and the file stays with whoever asked
        for it.
      </p>
    </div>
  );
}
