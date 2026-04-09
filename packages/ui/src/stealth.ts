/**
 * Stealth wallet — a one-shot sr25519 keypair generated in the browser.
 *
 * Each real voter gets their own stealth keypair derived from a random
 * mnemonic. The mnemonic is stashed in sessionStorage and keyed by
 *   `stealth:${proposalId}:${realAddress}`
 * so it survives tab reloads but is wiped when the browser closes.
 *
 * Nothing about the stealth keypair should ever be persisted beyond the
 * session — that's what keeps the link `real → stealth` ephemeral.
 */

import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady, mnemonicGenerate } from '@polkadot/util-crypto';
import { ACTIVE_PROPOSAL } from './config';

let cryptoReady = false;
export async function ensureCryptoReady(): Promise<void> {
  if (cryptoReady) return;
  await cryptoWaitReady();
  cryptoReady = true;
}

export interface Stealth {
  address: string;
  pair: KeyringPair;
}

function storageKey(realAddress: string): string {
  return `stealth:${ACTIVE_PROPOSAL.id}:${realAddress}`;
}

/**
 * Get or create the stealth keypair for this (proposal, realAddress) pair.
 * Idempotent within a single tab session.
 */
export async function getOrCreateStealth(realAddress: string): Promise<Stealth> {
  await ensureCryptoReady();
  const key = storageKey(realAddress);
  let mnemonic = sessionStorage.getItem(key);
  if (!mnemonic) {
    mnemonic = mnemonicGenerate();
    sessionStorage.setItem(key, mnemonic);
  }
  const keyring = new Keyring({ type: 'sr25519' });
  const pair = keyring.addFromUri(mnemonic);
  return { address: pair.address, pair };
}

/**
 * Peek at the existing stealth wallet without creating one. Returns null if
 * the current session hasn't generated one yet.
 */
export async function peekStealth(realAddress: string): Promise<Stealth | null> {
  await ensureCryptoReady();
  const mnemonic = sessionStorage.getItem(storageKey(realAddress));
  if (!mnemonic) return null;
  const keyring = new Keyring({ type: 'sr25519' });
  const pair = keyring.addFromUri(mnemonic);
  return { address: pair.address, pair };
}
