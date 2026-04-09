import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { stringToU8a, u8aToHex } from '@polkadot/util';
import { signatureVerify } from '@polkadot/util-crypto';

/**
 * Message bytes that the coordinator signs when issuing a credential.
 * MUST be byte-identical across voter, faucet, and verifier.
 */
export function credentialMessage(
  proposalId: string,
  stealthAddress: string,
  nullifierHex: string,
): Uint8Array {
  return stringToU8a(
    `anon-vote-cred:v1:${proposalId}:${stealthAddress}:${nullifierHex}`,
  );
}

/**
 * Message bytes that the real wallet signs when asking the faucet to
 * fund a stealth address. Does NOT contain the vote choice.
 */
export function fundRequestMessage(
  proposalId: string,
  stealthAddress: string,
): Uint8Array {
  return stringToU8a(`anon-vote-fund:v1:${proposalId}:${stealthAddress}`);
}

/**
 * Deterministic nullifier, derived from the coordinator secret and the
 * real voter address. Identical across faucet restarts, so on-chain
 * dedup catches double votes even if the backend loses state.
 */
export function computeNullifier(
  coordHmacSecret: string,
  proposalId: string,
  realAddress: string,
): string {
  const key = stringToU8a(coordHmacSecret);
  const msg = stringToU8a(`${proposalId}:${realAddress}`);
  return u8aToHex(hmac(sha256, key, msg));
}

/**
 * Verify a wallet signature using @polkadot/util-crypto.
 *
 * `signatureVerify` is smart about the `<Bytes>...</Bytes>` wrapper that
 * the Polkadot.js extension adds when signing raw messages with
 * `type: 'bytes'`, so we can hand it the original unwrapped payload and
 * still get a valid result.
 */
export function verifyWalletSignature(
  message: Uint8Array,
  signatureHex: string,
  signerAddress: string,
): boolean {
  try {
    const res = signatureVerify(message, signatureHex, signerAddress);
    return res.isValid;
  } catch {
    return false;
  }
}
