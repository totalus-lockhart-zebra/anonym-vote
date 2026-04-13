/**
 * RPC settings modal — lets the user override the Subtensor WS endpoint
 * used by the frontend. The override is persisted in localStorage; a
 * save triggers a page reload so every singleton (ApiPromise, indexer)
 * picks up the new URL cleanly.
 *
 * The modal also surfaces the current connection status and genesis
 * hash. If the reported genesis doesn't match the one this build was
 * pinned to, we show a prominent mismatch warning.
 */

import { useEffect, useState } from 'react';
import {
  DEFAULT_SUBTENSOR_WS,
  getSubtensorWs,
  setSubtensorWs,
} from '../config';
import { validateWs } from '../subtensor';
import type { RpcHealth } from '../hooks/useRpcHealth';

interface Props {
  open: boolean;
  onClose: () => void;
  health: RpcHealth;
}

export default function RpcSettingsModal({ open, onClose, health }: Props) {
  const currentOverride = (() => {
    const active = getSubtensorWs();
    return active === DEFAULT_SUBTENSOR_WS ? '' : active;
  })();
  const [draft, setDraft] = useState<string>(currentOverride);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !validating) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, validating]);

  if (!open) return null;

  async function save(): Promise<void> {
    const trimmed = draft.trim();
    const candidate = trimmed || DEFAULT_SUBTENSOR_WS;
    setValidating(true);
    setValidationError(null);
    try {
      const result = await validateWs(candidate);
      if (!result.ok) {
        setValidationError(
          `Genesis mismatch. Expected ${result.expected}, got ${result.actual}. This endpoint is a different chain.`,
        );
        return;
      }
      const next = trimmed === DEFAULT_SUBTENSOR_WS ? '' : trimmed;
      setSubtensorWs(next || null);
      window.location.reload();
    } catch (e) {
      setValidationError(
        `Can't reach endpoint: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setValidating(false);
    }
  }

  async function reset(): Promise<void> {
    setDraft('');
    setValidating(true);
    setValidationError(null);
    try {
      const result = await validateWs(DEFAULT_SUBTENSOR_WS);
      if (!result.ok) {
        setValidationError(
          `Default endpoint reports a different genesis (${result.actual}). Build is misconfigured.`,
        );
        return;
      }
      setSubtensorWs(null);
      window.location.reload();
    } catch (e) {
      setValidationError(
        `Can't reach default endpoint: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setValidating(false);
    }
  }

  const statusLabel: Record<RpcHealth['status'], string> = {
    connecting: 'Connecting…',
    ok: 'Connected — genesis matches',
    mismatch: 'Wrong chain — genesis mismatch',
    error: 'Connection error',
  };

  return (
    <div
      className="hiw-backdrop"
      onClick={() => {
        if (!validating) onClose();
      }}
    >
      <div
        className="hiw-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rpc-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hiw-header">
          <h2 id="rpc-title" className="hiw-title">
            RPC endpoint
          </h2>
          <button
            className="hiw-close"
            onClick={onClose}
            aria-label="Close"
            disabled={validating}
          >
            ✕
          </button>
        </div>

        <div className="hiw-body">
          <div className={`rpc-status rpc-status-${health.status}`}>
            <span className="rpc-status-dot" />
            <strong>{statusLabel[health.status]}</strong>
          </div>

          <div className="rpc-row">
            <span className="rpc-label">Endpoint</span>
            <code className="rpc-value">{health.wsUrl}</code>
          </div>

          {health.status === 'mismatch' && (
            <div className="rpc-warn">
              The RPC you're connected to is a different chain from the one
              this build targets. Data shown may be wrong or entirely missing.
              Switch to an endpoint for the correct network below.
            </div>
          )}
          {health.status === 'error' && health.error && (
            <div className="rpc-warn">Connection error: {health.error}</div>
          )}

          <div className="rpc-divider" />

          <label className="rpc-field">
            <span className="rpc-label">Custom WS URL</span>
            <input
              type="text"
              className="rpc-input"
              placeholder={DEFAULT_SUBTENSOR_WS}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
          </label>
          <p className="rpc-hint">
            Leave empty to use the default (
            <code>{DEFAULT_SUBTENSOR_WS}</code>). Endpoint is validated
            against the expected genesis before saving; the page reloads
            only on success.
          </p>

          {validationError && (
            <div className="rpc-warn">{validationError}</div>
          )}

          <div className="rpc-actions">
            <button
              className="vs-btn-secondary"
              onClick={reset}
              disabled={validating}
            >
              Reset to default
            </button>
            <button
              className="vs-btn-primary"
              onClick={save}
              disabled={
                validating ||
                (draft.trim() === currentOverride && !validationError)
              }
            >
              {validating ? 'Validating…' : 'Save & reload'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
