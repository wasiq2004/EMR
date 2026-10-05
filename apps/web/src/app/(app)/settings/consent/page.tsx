'use client';

import { FileText } from 'lucide-react';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, EmptyState } from '@/components/ui/feedback';

/** Consent text. */
export default function ConsentSettingsPage() {
  return (
    <Panel>
      <PanelHeader
        title="Consent text"
        description="The notices patients are shown, by purpose and language. Each version is recorded against the consent it was used for."
      />

      {/*
        No button, because there is no endpoint behind one.
        
        This page had an "Add notice" control with no handler. There is no notice
        store in the schema and no route to write one — the notice version is
        recorded as free text against each consent, which is what DPDP actually
        requires, and the wording itself lives outside this product today.
        
        Saying that is more use than a button that does nothing: an administrator
        looking for where to upload their notice now learns, in one line, that
        the version string on each consent is the thing that matters.
      */}
      <PanelBody>
        <Alert tone="info" title="Notice wording lives outside this product">
          Each consent records the VERSION of the notice the patient was shown —
          that is what makes a consent defensible later, and it is captured when
          the consent is recorded on the patient&rsquo;s record. Storing the
          wording itself here is not built.
        </Alert>
      </PanelBody>

      <EmptyState
        icon={FileText}
        title="No notice text stored"
        description="Approved wording is supplied by the clinic's legal advisor and referenced by version."
      />
    </Panel>
  );
}
