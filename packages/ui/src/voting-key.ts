/**
 * Voting key — the BLSAG keypair a voter uses to sign their vote and
 * faucet drip request.
 *
 * Lifecycle:
 *   1. During the announce window the voter generates a fresh keypair.
 *   2. The public key is broadcast on chain via an `announce` remark
 *      signed by the voter's REAL wallet — that is the only on-chain
 *      link between the real account and this VK, and it carries no
 *      information about the eventual vote.
 *   3. During the voting window the voter signs `vote:<id>:<choice>`
 *      with the secret key under a ring of all announced VKs. The ring
 *      signature hides which VK signed; the deterministic key image
 *      acts as the nullifier so the same voter can't double-vote.
 *
 * Storage: localStorage, keyed by `(proposalId, realAddress)`.
 * Survives tab close so a voter who started the flow on Friday can
 * come back on Saturday to finish. Per-proposal isolation is by
 * design — each new proposal generates a fresh VK, no cross-
 * proposal key reuse, no cross-proposal key-image linkability.
 *
 * Plain text. Encrypting it under a user password is a future
 * upgrade; for now we trade that protection against the much bigger
 * risk of locking voters out by losing their tab.
 *
 * Note: the voting key is a raw Ristretto255 scalar used only with
 * the BLSAG primitive — it is not a Polkadot account and has no
 * SS58 address. Do not confuse it with the `gas-wallet.ts` sr25519
 * keypair, which is a real account that pays gas for the vote
 * extrinsic.
 */

import { keygen as ringKeygen, type RingSigKeypair } from './ring-sig';

function storageKey(proposalId: string, realAddress: string): string {
  return `voting-key:${proposalId}:${realAddress}`;
}

interface StoredVotingKey {
  sk: string;
  pk: string;
  /** ISO timestamp the key was generated, for debugging only. */
  createdAt: string;
}

/**
 * Get the existing voting keypair for `(proposalId, realAddress)`
 * from localStorage; otherwise generate a fresh one and persist it.
 *
 * Idempotent across tabs and reloads: calling twice returns the
 * same key. The first call performs the keygen.
 */
export function getOrCreateVotingKey(
  proposalId: string,
  realAddress: string,
): RingSigKeypair {
  const existing = peekVotingKey(proposalId, realAddress);
  if (existing) return existing;

  const fresh = ringKeygen();
  const stored: StoredVotingKey = {
    sk: fresh.sk,
    pk: fresh.pk,
    createdAt: new Date().toISOString(),
  };
  localStorage.setItem(storageKey(proposalId, realAddress), JSON.stringify(stored));
  return fresh;
}

/**
 * Read the voting key for `(proposalId, realAddress)` without generating
 * one if absent. Returns null when the session has not yet produced a key.
 *
 * Used by screens that want to know "has this voter announced yet" without
 * accidentally creating a key on a read-only render path.
 */
export function peekVotingKey(
  proposalId: string,
  realAddress: string,
): RingSigKeypair | null {
  const raw = localStorage.getItem(storageKey(proposalId, realAddress));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredVotingKey>;
    if (typeof parsed.sk !== 'string' || typeof parsed.pk !== 'string') {
      return null;
    }
    return { sk: parsed.sk, pk: parsed.pk };
  } catch {
    // Corrupted entry — treat as absent. We deliberately don't clear it
    // here so a developer poking at devtools can see what was wrong.
    return null;
  }
}

/**
 * Drop the stored voting key. Useful in tests, after a successful vote
 * (so the sk doesn't linger in localStorage longer than needed), or as
 * an explicit "start over" affordance in the UI.
 */
export function clearVotingKey(proposalId: string, realAddress: string): void {
  localStorage.removeItem(storageKey(proposalId, realAddress));
}
