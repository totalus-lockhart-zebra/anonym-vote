/**
 * Extrinsic helpers. Same shapes as the UI's `subtensor.ts`, adapted
 * for node: submit a signed `system.remark` and wait for inclusion,
 * poll `system.account` until an address has enough free balance.
 */

import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';

export interface SentRemark {
  blockHash: string;
  blockNumber: number;
}

export async function sendRemark(
  api: ApiPromise,
  pair: KeyringPair,
  text: string,
): Promise<SentRemark> {
  return new Promise<SentRemark>((resolve, reject) => {
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
          const blockHash = status.asInBlock.toHex();
          void api.rpc.chain
            .getHeader(status.asInBlock)
            .then((header) =>
              resolve({ blockHash, blockNumber: header.number.toNumber() }),
            )
            .catch(() => resolve({ blockHash, blockNumber: 0 }));
        }
      })
      .then((u) => {
        unsub = u as unknown as () => void;
      })
      .catch(reject);
  });
}

export async function waitForBalance(
  api: ApiPromise,
  address: string,
  minRao: bigint,
  {
    timeoutMs = 180_000,
    intervalMs = 3_000,
    onTick,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    onTick?: (current: bigint) => void;
  } = {},
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const acc = (await api.query.system.account(address)) as unknown as {
      data: { free: { toString: () => string } };
    };
    const free = BigInt(acc.data.free.toString());
    onTick?.(free);
    if (free >= minRao) return free;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${address} to reach ${minRao} rao free balance`);
}
