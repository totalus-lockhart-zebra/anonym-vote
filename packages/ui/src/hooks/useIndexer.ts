/**
 * React hook that keeps an in-memory mirror of `system.remark` extrinsics
 * from `proposal.startBlock` up to chain head.
 *
 * Lifecycle:
 *   1. On mount: subscribe to the chain head, do an initial catch-up scan
 *      from `startBlock` to the head we subscribed to.
 *   2. Thereafter: every time a new head arrives (~6s on Finney), scan the
 *      delta range and append new remarks.
 *
 * State exposed:
 *   - `status`: `indexing` while the catch-up is more than a handful of
 *     blocks behind, otherwise `ready`. Used to show a loading indicator
 *     without flashing on every normal live tick.
 *   - `head`: current known chain head block number.
 *   - `scannedThrough`: highest block fully processed. Between
 *     `startBlock` and `head`.
 *   - `remarks`: every IndexedRemark we've seen, in block order. Dedup
 *     is by (block, position-in-remarks-list).
 *
 * The hook is completely self-contained — consumers don't have to care
 * about the ApiPromise, the polling cadence, or cancellation. It returns
 * a plain snapshot; downstream hooks (`useTally`, `useRing`) are pure
 * transforms on top of `remarks`.
 */

import { useEffect, useRef, useState } from 'react';
import type { ApiPromise } from '@polkadot/api';
import type { UnsubscribePromise } from '@polkadot/api/types';
import { getApi } from '../subtensor';
import { scanRemarks, type IndexedRemark } from '../indexer';
import type { ProposalConfig } from '../proposal';

/** How many blocks behind head we tolerate before calling ourselves `ready`. */
const READY_LAG_BLOCKS = 3;

export interface IndexerSnapshot {
  status: 'indexing' | 'ready';
  startBlock: number;
  scannedThrough: number;
  head: number | null;
  remarks: IndexedRemark[];
  error: string | null;
}

export function useIndexer(config: ProposalConfig): IndexerSnapshot {
  const [snapshot, setSnapshot] = useState<IndexerSnapshot>({
    status: 'indexing',
    startBlock: config.startBlock,
    scannedThrough: config.startBlock - 1,
    head: null,
    remarks: [],
    error: null,
  });

  // Mutable refs so the async loops can read the latest state without
  // closing over stale values. `useState` alone would lock them to the
  // snapshot at subscription time.
  const remarksRef = useRef<IndexedRemark[]>([]);
  const scannedThroughRef = useRef<number>(config.startBlock - 1);
  const headRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    // Fresh state per proposal config; if startBlock changes (e.g. HMR),
    // we want to start clean rather than merging with the old scan state.
    remarksRef.current = [];
    scannedThroughRef.current = config.startBlock - 1;
    headRef.current = null;
    setSnapshot({
      status: 'indexing',
      startBlock: config.startBlock,
      scannedThrough: config.startBlock - 1,
      head: null,
      remarks: [],
      error: null,
    });

    const abort = new AbortController();
    let api: ApiPromise | null = null;
    let unsubHead: UnsubscribePromise | null = null;

    /**
     * Run a catch-up scan from `scannedThroughRef.current + 1` to `head`.
     * Serialized via `inFlightRef` so overlapping head updates don't
     * spawn duplicate workers fighting over the same block range.
     */
    const catchUp = async (head: number): Promise<void> => {
      if (inFlightRef.current) {
        // A scan is already running. It will notice the bumped head via
        // `headRef.current` if we stash it, but the simpler approach is
        // to wait and re-dispatch when it completes.
        await inFlightRef.current;
      }
      if (abort.signal.aborted) return;
      const from = scannedThroughRef.current + 1;
      const to = head;
      if (from > to) {
        updateSnapshot();
        return;
      }

      const run = (async () => {
        try {
          if (!api) return;
          const { remarks, scannedThrough } = await scanRemarks(
            api,
            from,
            to,
            {
              concurrency: 8,
              signal: abort.signal,
              onProgress: (st) => {
                scannedThroughRef.current = Math.max(
                  scannedThroughRef.current,
                  st,
                );
                updateSnapshot();
              },
            },
          );
          if (abort.signal.aborted) return;
          remarksRef.current = [...remarksRef.current, ...remarks];
          scannedThroughRef.current = Math.max(
            scannedThroughRef.current,
            scannedThrough,
          );
          updateSnapshot();
        } catch (err) {
          if (abort.signal.aborted) return;
          setSnapshot((s) => ({
            ...s,
            error: err instanceof Error ? err.message : String(err),
          }));
        } finally {
          inFlightRef.current = null;
        }
      })();

      inFlightRef.current = run;
      await run;

      // If head advanced while we were scanning, do another pass.
      if (!abort.signal.aborted && headRef.current && headRef.current > to) {
        await catchUp(headRef.current);
      }
    };

    const updateSnapshot = (): void => {
      const head = headRef.current;
      const scanned = scannedThroughRef.current;
      const status: IndexerSnapshot['status'] =
        head !== null && head - scanned <= READY_LAG_BLOCKS ? 'ready' : 'indexing';
      setSnapshot({
        status,
        startBlock: config.startBlock,
        scannedThrough: Math.max(scanned, config.startBlock - 1),
        head,
        remarks: remarksRef.current,
        error: null,
      });
    };

    (async () => {
      try {
        api = await getApi();
        if (abort.signal.aborted) return;

        // Subscribe to new heads. Each tick updates `headRef` and kicks
        // off a catch-up if there's anything new. This also drives the
        // very first scan — we don't need a separate init path.
        unsubHead = api.rpc.chain.subscribeNewHeads((header) => {
          if (abort.signal.aborted) return;
          const n = header.number.toNumber();
          headRef.current = Math.max(headRef.current ?? 0, n);
          updateSnapshot();
          void catchUp(headRef.current);
        });
      } catch (err) {
        if (abort.signal.aborted) return;
        setSnapshot((s) => ({
          ...s,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    })();

    return () => {
      abort.abort();
      if (unsubHead) {
        void unsubHead.then((u) => u());
      }
    };
  }, [config.startBlock, config.id]);

  return snapshot;
}
