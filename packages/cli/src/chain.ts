/**
 * Chain client for the CLI — connect to a Subtensor RPC, verify genesis,
 * then scan a block range and collect every signed `system.remark`.
 *
 * Output is a plain `RemarkLike[]` suitable for feeding straight into
 * `tallyRemarks` from @anon-vote/shared.
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import { u8aToString } from '@polkadot/util';
import type { RemarkLike } from '@anon-vote/shared';

export interface ScanOptions {
  concurrency?: number;
  onProgress?: (scanned: number, total: number, matched: number) => void;
}

export interface ConnectedChain {
  api: ApiPromise;
  genesisHash: string;
  head: number;
  disconnect: () => Promise<void>;
}

export async function connect(
  wsUrl: string,
  expectedGenesis: string,
): Promise<ConnectedChain> {
  const provider = new WsProvider(wsUrl);
  const api = await ApiPromise.create({ provider });
  const genesisHash = api.genesisHash.toHex().toLowerCase();
  const expected = expectedGenesis.toLowerCase();
  if (genesisHash !== expected) {
    await api.disconnect();
    throw new Error(
      `Genesis mismatch at ${wsUrl}: expected ${expected}, got ${genesisHash}. ` +
        `This endpoint is a different chain.`,
    );
  }
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  return {
    api,
    genesisHash,
    head,
    disconnect: () => api.disconnect(),
  };
}

/**
 * Scan [fromBlock..toBlock] inclusive and return every signed
 * `system.remark` in the range, unfiltered. Downstream consumers
 * (`tallyRemarks`, `reconstructRing`) use the shared parsers to
 * recognize their own remark shapes and ignore everything else —
 * same pattern as the UI indexer. No signer or prefix filter here
 * because votes are submitted by one-shot gas wallets outside the
 * allowlist (that's the anonymity property) and are raw-JSON, not
 * prefixed like announces are.
 */
export async function scanRemarks(
  api: ApiPromise,
  fromBlock: number,
  toBlock: number,
  opts: ScanOptions = {},
): Promise<RemarkLike[]> {
  if (fromBlock > toBlock) return [];
  const concurrency = opts.concurrency ?? 16;
  const total = toBlock - fromBlock + 1;

  const remarks: RemarkLike[] = [];
  let next = fromBlock;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const n = next++;
      if (n > toBlock) return;
      try {
        const hash = await api.rpc.chain.getBlockHash(n);
        const signed = await api.rpc.chain.getBlock(hash);
        for (const ex of signed.block.extrinsics) {
          if (!ex.isSigned) continue;
          const { section, method } = ex.method;
          if (section !== 'system' || method !== 'remark') continue;
          let text: string;
          try {
            const arg = ex.method.args[0] as unknown as {
              toU8a: (bare: boolean) => Uint8Array;
            };
            text = u8aToString(arg.toU8a(true));
          } catch {
            continue;
          }
          const signer = ex.signer.toString();
          remarks.push({ blockNumber: n, signer, text });
        }
      } catch (err) {
        // Per-block errors are logged but not fatal — a single failed
        // block shouldn't kill the whole scan. The caller decides what
        // to do with partial results (the verify command treats any
        // scan warning as a fatal since tally correctness requires a
        // complete window).
        console.warn(
          `\n[warn] block ${n} fetch failed:`,
          err instanceof Error ? err.message : err,
        );
        throw err;
      } finally {
        done++;
        opts.onProgress?.(done, total, remarks.length);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  remarks.sort((a, b) => a.blockNumber - b.blockNumber);
  return remarks;
}
