/**
 * Browser-side chain scanner.
 *
 * The UI talks to the Subtensor RPC directly and assembles the remark
 * list in-memory — there is no backend indexer in the loop. This
 * module exposes one low-level function; `useIndexer` wraps it in
 * head-subscription + progress reporting.
 */

import type { ApiPromise } from '@polkadot/api';
import { u8aToString } from '@polkadot/util';
import type { RemarkLike } from '@anon-vote/shared';

export interface IndexedRemark extends RemarkLike {
  /** Block hash — useful for linking into explorer views. */
  blockHash: string;
}

export interface ScanOptions {
  /**
   * How many blocks to fetch in parallel. The backend used 8; in the
   * browser with a single-threaded event loop the sweet spot is similar —
   * the bottleneck is the WS RPC, not local CPU.
   */
  concurrency?: number;
  /**
   * Optional callback fired whenever `scannedThrough` advances. Called
   * with the new value (monotonically increasing). Useful for driving a
   * progress bar without re-rendering on every block.
   */
  onProgress?: (scannedThrough: number) => void;
  /**
   * If set to `true` at any point, the scanner aborts at the next safe
   * spot and returns whatever it has. Used by the hook to cancel pending
   * work when the component unmounts.
   */
  signal?: AbortSignal;
}

/**
 * Scan blocks `[fromBlock..toBlock]` inclusive for signed `system.remark`
 * extrinsics and return them in block-ascending order.
 *
 * Mirrors the contiguous-prefix trick from the backend: workers pick
 * blocks out of order, each successfully-scanned block enters a `done`
 * set, and `scannedThrough` advances across the contiguous prefix as
 * soon as each block lands. This lets the caller surface live progress
 * during long catch-ups instead of jumping 0 → 100% when the last
 * worker finishes.
 *
 * Errors from individual block fetches are logged (via console.warn) and
 * the offending block is left un-marked — the next call will retry it.
 */
export async function scanRemarks(
  api: ApiPromise,
  fromBlock: number,
  toBlock: number,
  opts: ScanOptions = {},
): Promise<{ remarks: IndexedRemark[]; scannedThrough: number }> {
  if (fromBlock > toBlock) {
    return { remarks: [], scannedThrough: fromBlock - 1 };
  }

  const concurrency = opts.concurrency ?? 8;
  const remarks: IndexedRemark[] = [];
  const done = new Set<number>();
  let scannedThrough = fromBlock - 1;
  let next = fromBlock;

  // Walk `scannedThrough` forward across the contiguous prefix of `done`,
  // same trick as the backend. Called after every successful block fetch.
  const advance = (): void => {
    while (done.has(scannedThrough + 1)) {
      scannedThrough++;
      done.delete(scannedThrough);
    }
    opts.onProgress?.(scannedThrough);
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (opts.signal?.aborted) return;
      const n = next++;
      if (n > toBlock) return;

      try {
        const hash = await api.rpc.chain.getBlockHash(n);
        const hashHex = hash.toHex();
        const signedBlock = await api.rpc.chain.getBlock(hash);
        const exs = signedBlock.block.extrinsics;

        for (const ex of exs) {
          const { section, method } = ex.method;
          if (section !== 'system' || method !== 'remark') continue;
          if (!ex.isSigned) continue;

          // The remark arg is a `Bytes` scale type; `.toU8a(true)` strips
          // the compact-length prefix so we get just the payload bytes.
          const arg = ex.method.args[0] as unknown as {
            toU8a: (bare: boolean) => Uint8Array;
          };
          let text: string;
          try {
            text = u8aToString(arg.toU8a(true));
          } catch {
            // Non-UTF-8 remark — not for us, skip silently.
            continue;
          }

          remarks.push({
            blockNumber: n,
            blockHash: hashHex,
            signer: ex.signer.toString(),
            text,
          });
        }

        done.add(n);
        advance();
      } catch (err) {
        // Log and move on. Leaving `n` out of `done` means the next scan
        // will retry it — no need to throw out of the worker.
        // eslint-disable-next-line no-console
        console.warn(
          `indexer: block ${n} fetch failed —`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  };

  const workerCount = Math.min(concurrency, toBlock - fromBlock + 1);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  // A last sweep in case workers finished out-of-order across gaps we
  // couldn't bridge earlier (e.g. transient RPC error retried on a later
  // worker's retry). In practice this is a no-op for clean runs.
  advance();

  remarks.sort((a, b) => a.blockNumber - b.blockNumber);
  return { remarks, scannedThrough };
}
