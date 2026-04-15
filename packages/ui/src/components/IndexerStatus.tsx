/**
 * Global chain-sync status strip.
 *
 * Rendered once at the top of the app so every tab shows the same
 * indexer state. Three modes:
 *   - 'indexing'    → cold initial scan from startBlock, no cache.
 *                     Progress is (scannedThrough-startBlock) / total.
 *   - 'catching-up' → incremental delta scan after resuming from a
 *                     persisted snapshot. Progress is the closed delta
 *                     window alone, so the bar races to 100% fast
 *                     instead of bleeding back to a tiny fraction of
 *                     the full proposal range.
 *   - 'ready'       → hidden; zero vertical space so no layout jump.
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

  // For the cold scan, progress is measured against the full window
  // [startBlock..head]. For a cached resume, measuring against the
  // full window is meaningless (scannedThrough is usually already
  // most of the way there), so we measure against the head lag
  // instead — "how many blocks behind head are we right now".
  const scanProgressPct = (() => {
    if (indexer.head === null) return 0;
    if (isCatchingUp) {
      // scannedThrough can fleetingly exceed head if the subscription
      // lagged by a tick; clamp.
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

  if (!isIndexing && !isCatchingUp && !indexer.error) return null;

  return (
    <>
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

      {indexer.error && (
        <div className="vs-error">
          <p>Indexer error: {indexer.error}</p>
        </div>
      )}
    </>
  );
}
