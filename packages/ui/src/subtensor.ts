/**
 * Subtensor client — thin wrapper around @polkadot/api.
 *
 * The UI no longer scans the chain itself for vote remarks — that lives
 * on the backend `IndexerService`. What's left here is the bits the
 * voter flow still needs from chain directly:
 *
 *   - getApi()            singleton ApiPromise
 *   - sendRemark(pair, t) submit a signed system.remark extrinsic
 *   - waitForBalance(a,m) poll until address has >= m rao free balance
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { SUBTENSOR_WS } from './config';

let apiPromise: Promise<ApiPromise> | null = null;

export function getApi(): Promise<ApiPromise> {
  if (!apiPromise) {
    const provider = new WsProvider(SUBTENSOR_WS);
    apiPromise = ApiPromise.create({ provider });
  }
  return apiPromise;
}

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
 * Poll until `address` has at least `minRao` free balance, or `timeoutMs`
 * elapses. Uses the system.account storage query.
 */
export async function waitForBalance(
  address: string,
  minRao: bigint,
  {
    timeoutMs = 180_000,
    intervalMs = 3_000,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<bigint> {
  const api = await getApi();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const acc = (await api.query.system.account(address)) as any;
    const free = BigInt(acc.data.free.toString());
    if (free >= minRao) return free;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out waiting for gas address ${address} to be funded.`,
  );
}
