/**
 * Indexer status toast.
 *
 * Rendered as a position-fixed panel in the bottom-right corner so it
 * can appear / disappear without pushing page content around. The
 * wrapper is ALWAYS mounted: we toggle a `.show` class instead of
 * unmounting so the CSS transition can play on both entry and exit.
 * When no banner is needed, the panel is translated off-screen and
 * has `pointer-events: none` so it doesn't intercept clicks.
 *
 * Content:
 *   - 'indexing'    → cold initial scan from startBlock.
 *   - 'catching-up' → incremental delta scan after a cache resume.
 *   - Indexer error → persistent error card; doesn't auto-dismiss.
 *
 * Data beyond the status string flows through live — but the status
 * itself is held for at least MIN_BUSY_VISIBLE_MS (see useIndexer)
 * so the toast doesn't strobe on fast delta scans.
 */

import type { IndexerSnapshot } from '../hooks/useIndexer';
import type { ProposalConfig } from '../proposal';

interface Props {
  indexer: IndexerSnapshot;
  config: ProposalConfig;
}

export default function IndexerStatus({ indexer, config }: Props) {
  const isCatchingUp = indexer.status === 'catching-up';
  const isIndexing = indexer.status === 'indexing';
  const hasError = Boolean(indexer.error);
  const visible = isIndexing || isCatchingUp || hasError;

  // Progress semantics: cold scan is progress across the whole
  // [startBlock..head] window; delta scan measures closeness to head
  // so a tiny delta races to 100% fast instead of sitting at 0.01%.
  const scanProgressPct = (() => {
    if (indexer.head === null) return 0;
    if (isCatchingUp) {
      const lag = Math.max(0, indexer.head - indexer.scannedThrough);
      const windowSize = Math.max(1, lag);
      return Math.round(((windowSize - lag) / windowSize) * 100);
    }
    if (indexer.head > config.startBlock) {
      return Math.min(
        100,
        Math.round(
          ((indexer.scannedThrough - config.startBlock + 1) /
            (indexer.head - config.startBlock + 1)) *
            100,
        ),
      );
    }
    return 0;
  })();

  return (
    <div
      className={`indexer-toast${visible ? ' show' : ''}`}
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
    >
      {(isIndexing || isCatchingUp) && (
        <div className="res-indexing">
          <div className="res-indexing-row">
            <div className="vs-spinner" style={{ width: 18, height: 18 }} />
            <div>
              <strong>
                {isCatchingUp
                  ? 'Catching up from cached snapshot…'
                  : 'Scanning chain…'}
              </strong>
              <p>
                {isCatchingUp
                  ? indexer.head !== null
                    ? `${indexer.head - indexer.scannedThrough} block(s) behind head — should finish in a few seconds.`
                    : 'Resuming from cached snapshot…'
                  : indexer.remarks.length > 0
                    ? `${indexer.remarks.length} remark(s) seen so far — live updates as new blocks land.`
                    : 'No remarks seen yet — this fills in as blocks are processed.'}
              </p>
            </div>
            <span className="res-indexing-pct">{scanProgressPct}%</span>
          </div>
          <div className="res-progress-track">
            <div
              className="res-progress-fill"
              style={{ width: `${scanProgressPct}%` }}
            />
          </div>
        </div>
      )}

      {hasError && !isIndexing && !isCatchingUp && (
        <div className="vs-error">
          <p>Indexer error: {indexer.error}</p>
        </div>
      )}
    </div>
  );
}
