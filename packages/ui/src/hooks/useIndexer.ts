/**
 * React hook that keeps a mirror of `system.remark` extrinsics
 * from `proposal.startBlock` up to chain head.
 *
 * The hook persists its state in localStorage so that page reloads
 * don't trigger a full re-scan:
 *
 *   - On mount we try to read a snapshot keyed by
 *     `(genesisHash, proposalId, startBlock)` and seed state from it.
 *   - Once the head subscription fires, we compare against the cached
 *     scannedThrough and only scan the delta. To tolerate short
 *     reorgs we rewind by SAFETY_MARGIN blocks and rescan that window,
 *     replacing any stale cached entries.
 *   - We only re-enter the scanning state (status = catching-up) when
 *     the head is at least CATCHUP_THRESHOLD blocks ahead of what we
 *     already have, so a fresh tab that's "1 block behind" doesn't
 *     flicker "indexing" at the user.
 *
 * State exposed:
 *   - `status`: 'indexing'    → first catch-up with no cache available
 *               'catching-up' → delta scan on top of a cached snapshot
 *               'ready'       → within READY_LAG_BLOCKS of head
 *   - `head`: current known chain head block number.
 *   - `scannedThrough`: highest block fully processed.
 *   - `remarks`: every IndexedRemark we've seen, in block order.
 *   - `cacheHit`: true if we booted from a persisted snapshot. Used
 *                  by the UI to label progress as "resuming" vs
 *                  "initial scan".
 *
 * Downstream hooks (`useTally`, `useRing`, `useVotingPhase`) are pure
 * transforms on top of `remarks` and don't need to know about caching.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiPromise } from '@polkadot/api';
import type { UnsubscribePromise } from '@polkadot/api/types';
import { EXPECTED_GENESIS_HASH } from '../config';
import { getApi } from '../subtensor';
import { scanRemarks, type IndexedRemark } from '../indexer';
import type { ProposalConfig } from '../proposal';
import { readCache, writeCache, type CacheSlot } from '../indexer-cache';

/** How many blocks behind head we tolerate before calling ourselves `ready`. */
const READY_LAG_BLOCKS = 3;
/**
 * Don't kick off a delta scan for trivially-small deltas. Once the
 * cache has resumed, new-head ticks bump `head` but we only spend a
 * network round-trip when we're this far behind. Keeps the UI stable
 * when head is advancing ~1 block every 12s.
 */
const CATCHUP_THRESHOLD = 10;
/**
 * Re-scan this many blocks behind the cached `scannedThrough` on
 * every delta pass. Defends against short reorgs: if a block within
 * this window flipped to a different hash with different remarks, we
 * pick up the corrected content and overwrite the stale cache entry.
 *
 * Subtensor finalizes via GRANDPA in ~3-6 blocks so 10 is a healthy
 * cushion. Bumping this higher directly trades user-visible
 * catch-up latency for bigger reorg tolerance — for a 10-block lag
 * a margin of 50 makes the scan 6× larger. Keep it tight.
 */
const SAFETY_MARGIN = 10;
/**
 * Minimum time the `catching-up` status is shown, in ms. If a scan
 * finishes faster than this we hold the banner until the minimum
 * elapses — otherwise the UI flashes on every delta-scan and the user
 * sees a nervous strobe rather than a status.
 */
const MIN_CATCHUP_VISIBLE_MS = 3_000;

export interface IndexerSnapshot {
  status: 'indexing' | 'catching-up' | 'ready';
  startBlock: number;
  scannedThrough: number;
  head: number | null;
  remarks: IndexedRemark[];
  error: string | null;
  /** True if we booted from a persisted snapshot on this mount. */
  cacheHit: boolean;
  /**
   * Kick off a catch-up scan immediately, ignoring CATCHUP_THRESHOLD.
   * Called right after a voter's own announce/vote extrinsic lands
   * in a block so they don't have to wait ~2 minutes for the next
   * threshold trip before seeing their own action reflected in the
   * UI. Safe to call repeatedly — serializes on the in-flight lock,
   * identical to the normal head-tick path.
   *
   * Pass the block number the extrinsic just landed in to ensure we
   * scan up to at least that block even if the head subscription
   * hasn't caught up yet.
   */
  forceCatchUp: (upToBlock?: number) => void;
}

export function useIndexer(config: ProposalConfig): IndexerSnapshot {
  const [snapshot, setSnapshot] = useState<IndexerSnapshot>(() => ({
    status: 'indexing',
    startBlock: config.startBlock,
    scannedThrough: config.startBlock - 1,
    head: null,
    remarks: [],
    error: null,
    cacheHit: false,
    // Placeholder; reassigned below once useCallback runs. Keeping
    // the field always-defined avoids `?.` everywhere in consumers.
    forceCatchUp: () => {},
  }));

  // Mutable refs so the async loops can read the latest state without
  // closing over stale values. `useState` alone would lock them to the
  // snapshot at subscription time.
  const remarksRef = useRef<IndexedRemark[]>([]);
  const scannedThroughRef = useRef<number>(config.startBlock - 1);
  const headRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const cacheHitRef = useRef<boolean>(false);
  // Timestamp of when the current catching-up banner appeared. Null
  // when not catching up. Used to enforce MIN_CATCHUP_VISIBLE_MS so
  // sub-second scans don't flash the banner on and off.
  const catchUpShownAtRef = useRef<number | null>(null);
  const catchUpHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Held by the useEffect below and reassigned on re-run. The outer
  // `forceCatchUp` exposed in the snapshot routes through this ref so
  // the returned function identity stays stable across re-renders.
  const forceCatchUpImplRef = useRef<(upToBlock?: number) => void>(() => {});
  const forceCatchUp = useCallback((upToBlock?: number) => {
    forceCatchUpImplRef.current(upToBlock);
  }, []);

  useEffect(() => {
    const slot: CacheSlot = {
      genesisHash: EXPECTED_GENESIS_HASH,
      proposalId: config.id,
      startBlock: config.startBlock,
    };

    // Seed from cache BEFORE the first render settles so consumers see
    // cached data immediately instead of an empty remarks list.
    const cached = readCache(slot);
    if (cached) {
      remarksRef.current = cached.remarks;
      scannedThroughRef.current = cached.scannedThrough;
      cacheHitRef.current = true;
      setSnapshot({
        status: 'ready',
        startBlock: config.startBlock,
        scannedThrough: cached.scannedThrough,
        head: null,
        remarks: cached.remarks,
        error: null,
        cacheHit: true,
        forceCatchUp,
      });
    } else {
      remarksRef.current = [];
      scannedThroughRef.current = config.startBlock - 1;
      cacheHitRef.current = false;
      setSnapshot({
        status: 'indexing',
        startBlock: config.startBlock,
        scannedThrough: config.startBlock - 1,
        head: null,
        remarks: [],
        error: null,
        cacheHit: false,
        forceCatchUp,
      });
    }
    headRef.current = null;

    const abort = new AbortController();
    let api: ApiPromise | null = null;
    let unsubHead: UnsubscribePromise | null = null;

    const persist = (): void => {
      writeCache(slot, {
        scannedThrough: scannedThroughRef.current,
        remarks: remarksRef.current,
      });
    };

    /**
     * Merge freshly-scanned remarks into `remarksRef`, dropping any
     * cached entries from the rescanned window so reorged-out remarks
     * disappear cleanly. Cheap for realistic proposal sizes (O(N) over
     * the remark list, and N stays in the low hundreds typically).
     */
    const mergeFresh = (fresh: IndexedRemark[], from: number): void => {
      const preserved = remarksRef.current.filter((r) => r.blockNumber < from);
      remarksRef.current = [...preserved, ...fresh];
    };

    const emit = (status: IndexerSnapshot['status']): void => {
      const head = headRef.current;
      const scanned = scannedThroughRef.current;
      setSnapshot({
        status,
        startBlock: config.startBlock,
        scannedThrough: Math.max(scanned, config.startBlock - 1),
        head,
        remarks: remarksRef.current,
        error: null,
        cacheHit: cacheHitRef.current,
        forceCatchUp,
      });
    };

    const updateSnapshot = (override?: {
      status?: IndexerSnapshot['status'];
    }): void => {
      const head = headRef.current;
      const scanned = scannedThroughRef.current;
      const lag = head === null ? Infinity : head - scanned;
      // Status rules differ by path:
      //   - Cached resume: we deliberately skip scanning when lag is
      //     under CATCHUP_THRESHOLD, so anything below that counts as
      //     `ready` — the user should NOT see a perpetual "catching
      //     up" banner just because head grew 4 blocks faster than we
      //     scanned.
      //   - Cold start (no cache): we want `ready` only when we're
      //     within READY_LAG_BLOCKS because every block is load-
      //     bearing until the initial scan is close to head.
      const naturalStatus: IndexerSnapshot['status'] =
        override?.status ??
        (cacheHitRef.current
          ? lag < CATCHUP_THRESHOLD
            ? 'ready'
            : 'catching-up'
          : lag <= READY_LAG_BLOCKS
            ? 'ready'
            : 'indexing');

      // Minimum-visible-time for the catching-up banner. If we're
      // entering it, stamp the start time. If we're leaving it
      // early, either defer the transition or emit immediately if
      // enough time has already passed. Remarks/scannedThrough in
      // the snapshot are NOT delayed — only the status string is
      // held back, so downstream data keeps flowing live.
      if (naturalStatus === 'catching-up') {
        if (catchUpShownAtRef.current === null) {
          catchUpShownAtRef.current = performance.now();
        }
        if (catchUpHoldTimerRef.current !== null) {
          clearTimeout(catchUpHoldTimerRef.current);
          catchUpHoldTimerRef.current = null;
        }
        emit('catching-up');
        return;
      }

      if (catchUpShownAtRef.current !== null) {
        const shownFor = performance.now() - catchUpShownAtRef.current;
        const remaining = MIN_CATCHUP_VISIBLE_MS - shownFor;
        if (remaining > 0) {
          // Keep the banner for the remainder; the current snapshot
          // still needs to flush remarks + scannedThrough to the UI,
          // so emit with 'catching-up' now and schedule the flip.
          emit('catching-up');
          if (catchUpHoldTimerRef.current !== null) {
            clearTimeout(catchUpHoldTimerRef.current);
          }
          catchUpHoldTimerRef.current = setTimeout(() => {
            catchUpHoldTimerRef.current = null;
            catchUpShownAtRef.current = null;
            if (abort.signal.aborted) return;
            // Re-evaluate natural status when the hold expires —
            // head may have advanced during the hold and we might
            // actually still be catching up.
            updateSnapshot();
          }, remaining);
          return;
        }
        catchUpShownAtRef.current = null;
      }
      if (catchUpHoldTimerRef.current !== null) {
        clearTimeout(catchUpHoldTimerRef.current);
        catchUpHoldTimerRef.current = null;
      }
      emit(naturalStatus);
    };

    /**
     * Catch up from `scannedThroughRef.current + 1` (minus safety
     * margin on the FIRST pass after a cache resume) to `head`.
     * Serialized via `inFlightRef` so overlapping head ticks don't
     * spawn duplicate workers.
     */
    const catchUp = async (head: number): Promise<void> => {
      if (inFlightRef.current) {
        await inFlightRef.current;
      }
      if (abort.signal.aborted) return;

      // Clamp `from` to startBlock so we never reach into pre-proposal
      // territory, even after subtracting SAFETY_MARGIN on the first
      // post-cache scan.
      const base = scannedThroughRef.current + 1;
      const from = cacheHitRef.current
        ? Math.max(config.startBlock, base - SAFETY_MARGIN)
        : base;
      const to = head;
      if (from > to) {
        updateSnapshot();
        return;
      }

      updateSnapshot({
        status: cacheHitRef.current ? 'catching-up' : 'indexing',
      });

      const t0 = performance.now();
      const run = (async () => {
        try {
          if (!api) return;
          const collected: IndexedRemark[] = [];
          const { scannedThrough } = await scanRemarks(api, from, to, {
            // Bumped from 8: an archive WS happily multiplexes more
            // in-flight requests than that, and the "catching up"
            // dead-time is dominated by RPC roundtrips, not by local
            // decoding.
            concurrency: 16,
            signal: abort.signal,
            onRemarks: (found) => {
              collected.push(...found);
            },
            onProgress: (st) => {
              scannedThroughRef.current = Math.max(
                scannedThroughRef.current,
                st,
              );
              // Live re-render so the progress bar actually moves
              // during the scan instead of freezing until completion.
              // Cheap — this fires a handful of times per scan, not
              // per block.
              updateSnapshot();
            },
          });
          if (abort.signal.aborted) return;

          scannedThroughRef.current = Math.max(
            scannedThroughRef.current,
            scannedThrough,
          );
          mergeFresh(collected, from);
          persist();
          updateSnapshot();
          const dt = Math.round(performance.now() - t0);
          console.debug(
            `[indexer] scanned ${from}..${to} (${to - from + 1} blocks) in ${dt}ms, ${collected.length} remark(s)`,
          );
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

      // Head may have advanced while we were scanning. Only recurse
      // if we're now CATCHUP_THRESHOLD or more behind — otherwise
      // the next new-head tick will handle it naturally. Without
      // this gate, a slow RPC + growing head would chain scans end-
      // to-end and "catching up…" would never clear even for tiny
      // deltas.
      if (
        !abort.signal.aborted &&
        cacheHitRef.current &&
        headRef.current !== null &&
        headRef.current - scannedThroughRef.current >= CATCHUP_THRESHOLD
      ) {
        await catchUp(headRef.current);
      } else if (
        !abort.signal.aborted &&
        !cacheHitRef.current &&
        headRef.current !== null &&
        headRef.current > scannedThroughRef.current
      ) {
        // Cold start: no cache, so we need every block up to head
        // regardless of threshold — otherwise the first load would
        // sit on an incomplete initial scan forever.
        await catchUp(headRef.current);
      }
    };

    /**
     * Head-tick handler. Kicks off a catch-up only when far enough
     * behind head, so that a tab that's up-to-date stays calm and
     * doesn't flicker "catching-up" for every 1-block advance.
     */
    const onHead = (n: number): void => {
      headRef.current = Math.max(headRef.current ?? 0, n);
      const lag = headRef.current - scannedThroughRef.current;
      // Never spawn a scan on top of another — catchUp awaits the
      // in-flight one anyway, but we'd duplicate the "should scan"
      // decision and could spam scans while one is running. Cold
      // start (no cache) always scans the first head; subsequent
      // ticks only trigger when we're CATCHUP_THRESHOLD or more
      // blocks behind, so a live tab doesn't flicker on every tick.
      const shouldScan =
        !inFlightRef.current &&
        (!cacheHitRef.current || lag >= CATCHUP_THRESHOLD);
      if (shouldScan) {
        void catchUp(headRef.current);
      } else {
        updateSnapshot();
      }
    };

    // Wire up the public forceCatchUp so callers (VoteScreen after
    // a successful register/vote) can pull a scan immediately instead
    // of waiting for CATCHUP_THRESHOLD to accumulate.
    forceCatchUpImplRef.current = (upToBlock) => {
      if (abort.signal.aborted) return;
      if (typeof upToBlock === 'number') {
        headRef.current = Math.max(headRef.current ?? 0, upToBlock);
      }
      if (headRef.current === null) return;
      void catchUp(headRef.current);
    };

    (async () => {
      try {
        api = await getApi();
        if (abort.signal.aborted) return;

        unsubHead = api.rpc.chain.subscribeNewHeads((header) => {
          if (abort.signal.aborted) return;
          onHead(header.number.toNumber());
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
      if (catchUpHoldTimerRef.current !== null) {
        clearTimeout(catchUpHoldTimerRef.current);
        catchUpHoldTimerRef.current = null;
      }
      forceCatchUpImplRef.current = () => {};
    };
  }, [config.startBlock, config.id, forceCatchUp]);

  return snapshot;
}
