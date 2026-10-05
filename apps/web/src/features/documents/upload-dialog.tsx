'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Upload } from 'lucide-react';
import type { ClinicalDocument } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { formatBytes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Attaching a file to a patient's record.
 *
 * Until now the Upload button on the documents tab had no handler, because there
 * was no route to call — `POST /documents` did not exist. For a paper-heavy
 * outpatient practice that is most of a patient's file: the outside lab's report,
 * the referral letter, the signed consent form, the ECG strip someone
 * photographed.
 *
 * THE KIND OF DOCUMENT IS NOT COSMETIC. It drives what the rest of the product
 * does with the file — a LAB_REPORT belongs beside results, a CONSENT_FORM is
 * what a DPDP request asks for — and nothing can reclassify it later without an
 * audit trail, so it is asked for up front rather than defaulted and corrected.
 *
 * PATIENT_UPLOAD IS NOT OFFERED. The server refuses it, and for a good reason:
 * that type is held PENDING a virus scan, nothing in this deployment ever marks
 * a file CLEAN, and both the download and the share path refuse anything
 * PENDING. A file filed that way would upload and then never open again. The
 * list below is the set of things a member of staff can actually file.
 */

/** What the clinic itself files. Deliberately not the whole enum — see above. */
const FILEABLE: { value: string; label: string; hint: string }[] = [
  { value: 'LAB_REPORT', label: 'Lab report', hint: 'From an outside laboratory' },
  { value: 'IMAGING_REPORT', label: 'Imaging report', hint: 'X-ray, scan or ultrasound' },
  { value: 'REFERRAL_LETTER', label: 'Referral letter', hint: 'To or from another clinician' },
  { value: 'DISCHARGE_SUMMARY', label: 'Discharge summary', hint: 'From a hospital stay' },
  { value: 'CONSENT_FORM', label: 'Consent form', hint: 'A signed paper consent' },
  { value: 'INVOICE', label: 'Invoice', hint: 'A bill from elsewhere' },
  { value: 'OTHER', label: 'Something else', hint: 'Anything that is none of the above' },
];

/**
 * Mirrors `ALLOWED_UPLOAD_MIME` in the storage service.
 *
 * As the file picker's filter, not as the check. The server is the check — a
 * picker filter is a convenience the user can defeat by typing a filename — and
 * the point of matching it here is that somebody choosing a .docx learns it is
 * not accepted before they wait for 8 MB to upload.
 */
const ACCEPT = 'application/pdf,image/jpeg,image/png,image/heic';
const MAX_BYTES = 25 * 1024 * 1024;

export function UploadDocumentDialog({
  patientId,
  patientName,
  encounterId,
  open,
  onOpenChange,
}: {
  patientId: string;
  patientName?: string;
  /** Set when uploading from inside a consultation, so the file lands on it. */
  encounterId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState('');
  const [documentType, setDocumentType] = React.useState('LAB_REPORT');
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Cleared on open rather than on close, so a failed upload keeps what was
  // typed while the toast is still on screen.
  React.useEffect(() => {
    if (open) {
      setFile(null);
      setTitle('');
      setDocumentType('LAB_REPORT');
    }
  }, [open]);

  const upload = useMutation({
    mutationFn: (chosen: File) => {
      const form = new FormData();
      form.append('file', chosen, chosen.name);
      form.append('patientId', patientId);
      form.append('documentType', documentType);
      if (title.trim()) form.append('title', title.trim());
      if (encounterId) form.append('encounterId', encounterId);
      return api.post<ClinicalDocument>('/documents', form);
    },
    onSuccess: (document) => {
      // This patient's tab and the all-documents screen. Both, because a file
      // uploaded from the patient tab also belongs in the clinic-wide list, and
      // a stale count there is how somebody concludes the upload failed.
      void queryClient.invalidateQueries({ queryKey: qk.patientDocuments(patientId) });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast.success('Filed', `${document.title} is on the record.`);
      onOpenChange(false);
    },
    onError: (error) =>
      toast.error(
        'Could not upload that file',
        error instanceof ApiError ? error.message : 'Try again in a moment.',
      ),
  });

  const tooBig = file !== null && file.size > MAX_BYTES;
  const empty = file !== null && file.size === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a document</DialogTitle>
          <DialogDescription>
            {patientName
              ? `Filed against ${patientName}'s record.`
              : "Filed against this patient's record."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <Field
            label="The file"
            htmlFor="document-file"
            hint="A PDF or a photograph, up to 25 MB. A phone camera photo of a printed report is fine."
          >
            <input
              ref={inputRef}
              id="document-file"
              type="file"
              accept={ACCEPT}
              className="block w-full cursor-pointer rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink-soft file:mr-3 file:rounded file:border-0 file:bg-surface-sunk file:px-3 file:py-1 file:text-sm file:text-ink hover:border-line-strong"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </Field>

          {file ? (
            <p className="flex items-center gap-2 text-xs text-ink-faint">
              <FileText className="size-3.5" aria-hidden />
              {file.name} · {formatBytes(file.size)}
            </p>
          ) : null}

          {/*
            Said before the upload, not after it fails. A 25 MB limit reached
            after two minutes on a clinic's upload speed is a worse experience
            than a refusal at the moment of choosing.
          */}
          {tooBig ? (
            <Alert tone="critical" title="That file is too large">
              It is {formatBytes(file.size)} and the limit is 25 MB. Scanning at
              200 dpi instead of 600 usually brings a report well under it.
            </Alert>
          ) : null}
          {empty ? (
            <Alert tone="critical" title="That file is empty">
              Check it opens on this computer before uploading it.
            </Alert>
          ) : null}

          <Field
            label="What kind of document is it?"
            htmlFor="document-type"
            hint="This decides where it shows up later, and changing it afterwards is an audited correction."
          >
            <Select
              id="document-type"
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value)}
            >
              {FILEABLE.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} — {option.hint}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Describe it"
            htmlFor="document-title"
            hint="Optional. Left blank, the filename is used — which for a phone photo is something like IMG_20260104.jpg, and tells the next clinician nothing."
          >
            <Input
              id="document-title"
              placeholder="CBC and ESR, Apollo Diagnostics, 3 October"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!file || tooBig || empty}
            loading={upload.isPending}
            onClick={() => file && upload.mutate(file)}
          >
            <Upload aria-hidden />
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
