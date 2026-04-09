/**
 * Faucet / coordinator client.
 *
 * Two modes:
 *
 *   1. Real mode (FAUCET_URL set): POSTs to the backend faucet, which funds
 *      the stealth address and returns a signed credential.
 *
 *   2. Dev-stub mode (FAUCET_URL empty): runs entirely in the browser. A
 *      hard-coded dev mnemonic derives a coordinator keypair that signs
 *      credentials locally. No HTTP, no funding — the user must manually
 *      transfer a tiny bit of TAO to the stealth address before the remark
 *      can be submitted. Only use for local testing.
 *
 * In both modes the returned credential shape is identical, and the voter
 * never learns (or cares) which mode was used.
 */

import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { u8aToHex, stringToU8a } from '@polkadot/util';
import { FAUCET_URL, COORD_PUBKEY_SS58 } from './config';
import { credentialMessage } from './crypto';
import { ensureCryptoReady } from './stealth';

export interface Credential {
  proposalId: string;
  stealthAddress: string;
  nullifier: string;
  credSig: string;
}

export function isDevStub(): boolean {
  return !FAUCET_URL;
}

// ─── Dev stub ────────────────────────────────────────────────────────────

// Fixed dev mnemonic — DO NOT REUSE in production. This entire file path is
// only exercised when FAUCET_URL is empty, which should never be the case
// in a real deployment.
const DEV_COORD_MNEMONIC =
  'bottom drive obey lake curtain smoke basket hold race lonely fit walk';

// Arbitrary HMAC key for the dev stub. The real backend faucet has its own
// COORD_SECRET env var that nobody else sees.
const DEV_COORD_HMAC_KEY = stringToU8a('anon-vote-dev-stub-hmac-key-v1');

let devCoordPair: KeyringPair | null = null;

async function getDevCoordPair(): Promise<KeyringPair> {
  await ensureCryptoReady();
  if (!devCoordPair) {
    const keyring = new Keyring({ type: 'sr25519' });
    devCoordPair = keyring.addFromUri(DEV_COORD_MNEMONIC);
  }
  return devCoordPair;
}

function devNullifier(proposalId: string, realAddress: string): string {
  const msg = stringToU8a(`${proposalId}:${realAddress}`);
  const tag = hmac(sha256, DEV_COORD_HMAC_KEY, msg);
  return u8aToHex(tag);
}

async function issueDevCredential(args: {
  proposalId: string;
  stealthAddress: string;
  realAddress: string;
}): Promise<Credential> {
  const pair = await getDevCoordPair();
  const nullifier = devNullifier(args.proposalId, args.realAddress);
  const msg = credentialMessage(args.proposalId, args.stealthAddress, nullifier);
  const sig = pair.sign(msg);
  return {
    proposalId: args.proposalId,
    stealthAddress: args.stealthAddress,
    nullifier,
    credSig: u8aToHex(sig),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Return the coordinator's public key (SS58) used to verify credentials.
 * Dev-stub mode returns the stub's derived address; real mode returns the
 * value from config (COORD_PUBKEY_SS58).
 */
export async function getCoordPubkey(): Promise<string> {
  if (isDevStub()) {
    const pair = await getDevCoordPair();
    return pair.address;
  }
  if (!COORD_PUBKEY_SS58) {
    throw new Error(
      'COORD_PUBKEY_SS58 is not configured. Set VITE_COORD_PUBKEY_SS58.',
    );
  }
  return COORD_PUBKEY_SS58;
}

/**
 * Request a credential (and funding, in real mode) for a stealth address.
 *
 * `realSignature` must be a hex string produced by the real wallet over
 * `fundRequestMessage(proposalId, stealthAddress)`. The faucet verifies
 * that it came from an allowed voter before issuing the credential.
 */
export async function requestCredential(args: {
  proposalId: string;
  stealthAddress: string;
  realAddress: string;
  realSignature: string;
}): Promise<Credential> {
  await cryptoWaitReady();

  if (isDevStub()) {
    return issueDevCredential(args);
  }

  const res = await fetch(`${FAUCET_URL.replace(/\/$/, '')}/fund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Faucet error ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as Credential;
  if (!body?.credSig || !body?.nullifier || !body?.stealthAddress) {
    throw new Error('Faucet returned a malformed credential.');
  }
  return body;
}
