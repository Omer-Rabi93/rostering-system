import { useState } from 'react';
import type { ReactElement } from 'react';
import { FormField, Input, Modal } from '@rostering/ui';

import { useGetWorkerShareLinkQuery, useRotateWorkerShareLinkMutation } from '../../api/workers.api.js';

export interface ShareLinkModalProps {
  readonly isOpen: boolean;
  readonly workerId: number | null;
  readonly workerName: string;
  readonly onClose: () => void;
}

export function ShareLinkModal({ isOpen, workerId, workerName, onClose }: ShareLinkModalProps): ReactElement {
  const { data } = useGetWorkerShareLinkQuery(workerId ?? -1, { skip: !isOpen || workerId === null });
  const [rotate, rotateResult] = useRotateWorkerShareLinkMutation();
  const [copied, setCopied] = useState(false);
  const [rotateError, setRotateError] = useState(false);

  const fullUrl = data ? `${window.location.origin}${data.url}` : '';

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function handleRotate() {
    if (workerId === null) return;
    setRotateError(false);
    try {
      await rotate(workerId).unwrap();
    } catch {
      setRotateError(true);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      titleId="share-link-title"
      title={`${workerName} — public schedule link`}
      size="sm"
      footer={
        <>
          <button
            type="button"
            className="btn btn--danger"
            disabled={rotateResult.isLoading || workerId === null}
            onClick={() => void handleRotate()}
          >
            Rotate link (invalidates old URL)
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void handleCopy()}>
            {copied ? 'Copied!' : 'Copy link'}
          </button>
        </>
      }
    >
      <FormField id="share-url" label="Read-only URL (no login required)" hint="Anyone with this link can see this worker's own published schedule — nothing else.">
        {(inputProps) => <Input {...inputProps} readOnly value={fullUrl} />}
      </FormField>
      {rotateError ? (
        <p className="warn-text" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>Could not rotate this link. Please try again.</span>
        </p>
      ) : null}
    </Modal>
  );
}
