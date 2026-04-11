/**
 * Gas wallet — a one-shot sr25519 keypair whose sole purpose is to pay
 * gas for a vote remark.
 *
 * This is a deliberately separate concept from `voting-key.ts`:
 *   - Voting key = Ristretto255 scalar, used by BLSAG to sign the vote
 *     payload. Announced on chain via the real wallet. Never signs an
 *     extrinsic itself.
 *   - Gas wallet = sr25519 Polkadot account. Funded by the voter (or
 *     eventually by a ring-sig-authenticated faucet), pays for the
 *     `system.remark(vote payload)` extrinsic. Never touches the BLSAG
 *     primitive.
 *
 * Keeping them separate is the whole reason the design has any anonymity:
 * the ring signature hides which VK signed the payload, but if the
 * extrinsic signer is the voter's real allowlisted address, observers
 * trivially learn the choice. The gas wallet is a fresh key with no
 * history and no announced on-chain relationship, so publishing the vote
 * from it does not leak the voter's identity.
 *
 * Storage: localStorage, keyed by `(proposalId, realAddress)`.
 * Survives tab close — important because a voter who started the
 * cast flow on Friday and got TAO sent to their gas address must
 * be able to come back later and finish publishing the vote. If
 * the gas wallet were lost, the TAO at that address would be
 * unrecoverable and the voter would have to ask the faucet for a
 * second drip.
 */

import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady, mnemonicGenerate } from '@polkadot/util-crypto';

let cryptoReady = false;
async function ensureReady(): Promise<void> {
  if (cryptoReady) return;
  await cryptoWaitReady();
  cryptoReady = true;
}

export interface GasWallet {
  address: string;
  pair: KeyringPair;
}

function storageKey(proposalId: string, realAddress: string): string {
  return `gas-wallet:${proposalId}:${realAddress}`;
}

/**
 * Return the existing gas wallet for `(proposalId, realAddress)`,
 * or create a fresh one. Idempotent across reloads.
 */
export async function getOrCreateGasWallet(
  proposalId: string,
  realAddress: string,
): Promise<GasWallet> {
  await ensureReady();
  const key = storageKey(proposalId, realAddress);
  let mnemonic = localStorage.getItem(key);
  if (!mnemonic) {
    mnemonic = mnemonicGenerate();
    localStorage.setItem(key, mnemonic);
  }
  const keyring = new Keyring({ type: 'sr25519' });
  const pair = keyring.addFromUri(mnemonic);
  return { address: pair.address, pair };
}

/**
 * Clear the gas wallet. Called after a successful vote so the mnemonic
 * doesn't linger in localStorage longer than necessary.
 */
export function clearGasWallet(proposalId: string, realAddress: string): void {
  localStorage.removeItem(storageKey(proposalId, realAddress));
}
