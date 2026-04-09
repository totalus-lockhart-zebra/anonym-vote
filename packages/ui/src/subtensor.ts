/**
 * Subtensor client — thin wrapper around @polkadot/api.
 *
 * Only the bits this app needs:
 *   - getApi()            singleton ApiPromise
 *   - getCurrentBlock()   latest head block number
 *   - scanRemarks(a, b)   all system.remark extrinsics in [a..b]
 *   - sendRemark(pair, t) submit a signed system.remark extrinsic
 *   - waitForBalance(a,m) poll until address has >= m planck free balance
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { u8aToString } from '@polkadot/util';
import { SUBTENSOR_WS } from './config';

// ─── Singleton API connection ────────────────────────────────────────────

let apiPromise: Promise<ApiPromise> | null = null;

export function getApi(): Promise<ApiPromise> {
  if (!apiPromise) {
    const provider = new WsProvider(SUBTENSOR_WS);
    apiPromise = ApiPromise.create({ provider });
  }
  return apiPromise;
}

// ─── Reads ───────────────────────────────────────────────────────────────

export async function getCurrentBlock(): Promise<number> {
  const api = await getApi();
  const header = await api.rpc.chain.getHeader();
  return header.number.toNumber();
}

export interface RawRemark {
  blockNumber: number;
  signer: string;
  text: string;
}

/**
 * Scan blocks [fromBlock .. toBlock] inclusive, return every `system.remark`
 * extrinsic as { blockNumber, signer, text }. Extrinsics without a signer are
 * skipped (we only care about user-signed remarks).
 */
export async function scanRemarks(
  fromBlock: number,
  toBlock: number,
  opts?: { onProgress?: (p: { scanned: number; total: number }) => void },
): Promise<RawRemark[]> {
  const api = await getApi();
  const total = Math.max(0, toBlock - fromBlock + 1);
  const out: RawRemark[] = [];

  // Modest parallelism — enough to saturate one WS connection without
  // overwhelming the public RPC endpoint.
  const CONCURRENCY = 8;
  let next = fromBlock;
  let scanned = 0;

  async function worker() {
    while (true) {
      const n = next++;
      if (n > toBlock) return;
      try {
        const hash = await api.rpc.chain.getBlockHash(n);
        const signedBlock = await api.rpc.chain.getBlock(hash);
        for (const ex of signedBlock.block.extrinsics) {
          const { section, method } = ex.method;
          if (section !== 'system' || method !== 'remark') continue;
          if (!ex.isSigned) continue;
          const arg = ex.method.args[0];
          // `system.remark(remark: Bytes)` — arg is a Bytes (u8a with length prefix).
          // `.toU8a(true)` drops the length prefix and gives us the raw payload.
          let text: string;
          try {
            text = u8aToString((arg as any).toU8a(true));
          } catch {
            continue;
          }
          out.push({
            blockNumber: n,
            signer: ex.signer.toString(),
            text,
          });
        }
      } catch {
        // One bad block shouldn't kill the whole scan.
      } finally {
        scanned++;
        opts?.onProgress?.({ scanned, total });
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total || 1) }, () =>
    worker(),
  );
  await Promise.all(workers);

  out.sort((a, b) => a.blockNumber - b.blockNumber);
  return out;
}

// ─── Writes ──────────────────────────────────────────────────────────────

/**
 * Submit a `system.remark(text)` signed by `pair`. Resolves when the extrinsic
 * lands in a block (we don't wait for finalization to keep UX snappy).
 */
export async function sendRemark(
  pair: KeyringPair,
  text: string,
): Promise<{ blockHash: string }> {
  const api = await getApi();
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | null = null;
    api.tx.system
      .remark(text)
      .signAndSend(pair, (result) => {
        const { status, dispatchError } = result;
        if (dispatchError) {
          unsub?.();
          reject(new Error(dispatchError.toString()));
          return;
        }
        if (status.isInBlock) {
          unsub?.();
          resolve({ blockHash: status.asInBlock.toHex() });
        }
      })
      .then((u) => {
        unsub = u as unknown as () => void;
      })
      .catch(reject);
  });
}

/**
 * Poll until `address` has at least `minPlanck` free balance, or `timeoutMs`
 * elapses. Uses the system.account storage query.
 */
export async function waitForBalance(
  address: string,
  minPlanck: bigint,
  { timeoutMs = 180_000, intervalMs = 3_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<bigint> {
  const api = await getApi();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const acc = (await api.query.system.account(address)) as any;
    const free = BigInt(acc.data.free.toString());
    if (free >= minPlanck) return free;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out waiting for stealth address ${address} to be funded.`,
  );
}
