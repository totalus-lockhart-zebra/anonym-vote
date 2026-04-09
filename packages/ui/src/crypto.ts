/**
 * Vote payload format and verification.
 *
 * Every vote is a single `system.remark` extrinsic, signed on-chain by a
 * freshly generated stealth sr25519 account. The remark body is a compact
 * JSON blob:
 *
 *   {
 *     "v":   1,                       // schema version
 *     "p":   "proposal-1",            // proposal id
 *     "s":   "5Foo...",               // stealth address (must match extrinsic signer)
 *     "n":   "0x...32 bytes...",      // nullifier (HMAC from the faucet)
 *     "c":   "yes" | "no" | "abstain",
 *     "sig": "0x...64 bytes..."       // coordinator sr25519 signature over credentialMessage()
 *   }
 *
 * Nothing in here links back to the real voter address. Eligibility is proved
 * by `sig`, a coordinator signature issued by the faucet — never by the
 * voter's wallet. The nullifier is deterministic per (realAddress, proposalId)
 * so double votes can be caught even across faucet restarts.
 */

import { decodeAddress, sr25519Verify } from '@polkadot/util-crypto';
import { hexToU8a, stringToU8a } from '@polkadot/util';
import type { RawRemark } from './subtensor';

export type Choice = 'yes' | 'no' | 'abstain';
export const CHOICES: Choice[] = ['yes', 'no', 'abstain'];

export interface VotePayload {
  v: 1;
  p: string;
  s: string;
  n: string;
  c: Choice;
  sig: string;
}

export interface AcceptedVote extends VotePayload {
  blockNumber: number;
}

export interface Tally {
  yes: number;
  no: number;
  abstain: number;
  invalid: number;
  totalVoted: number;
}

/**
 * Bytes the coordinator signs when issuing a credential. MUST be identical
 * on voter, faucet, and verifier sides — any mismatch breaks verification.
 */
export function credentialMessage(
  proposalId: string,
  stealthAddress: string,
  nullifierHex: string,
): Uint8Array {
  const s = `anon-vote-cred:v1:${proposalId}:${stealthAddress}:${nullifierHex}`;
  return stringToU8a(s);
}

/**
 * Bytes the real wallet signs when asking the faucet to fund a stealth
 * address. This message does NOT contain the vote choice.
 */
export function fundRequestMessage(
  proposalId: string,
  stealthAddress: string,
): string {
  return `anon-vote-fund:v1:${proposalId}:${stealthAddress}`;
}

/** Build the JSON string that goes into system.remark(). */
export function encodeRemark(args: {
  proposalId: string;
  stealthAddress: string;
  nullifier: string;
  choice: Choice;
  credSig: string;
}): string {
  const obj: VotePayload = {
    v: 1,
    p: args.proposalId,
    s: args.stealthAddress,
    n: args.nullifier,
    c: args.choice,
    sig: args.credSig,
  };
  return JSON.stringify(obj);
}

/** Parse a raw remark text into our vote payload shape. Returns null if not ours. */
export function decodeRemark(text: string): VotePayload | null {
  if (!text || text[0] !== '{') return null;
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (obj?.v !== 1) return null;
  if (typeof obj.p !== 'string') return null;
  if (typeof obj.s !== 'string') return null;
  if (typeof obj.n !== 'string') return null;
  if (typeof obj.c !== 'string') return null;
  if (typeof obj.sig !== 'string') return null;
  return obj as VotePayload;
}

/**
 * Verify a credential signature against the coordinator public key.
 * `coordPubkey` is either an SS58 address or raw Uint8Array public key.
 */
export function verifyCredential(
  payload: VotePayload,
  coordPubkey: string | Uint8Array,
): boolean {
  const pk =
    typeof coordPubkey === 'string' ? decodeAddress(coordPubkey) : coordPubkey;
  const msg = credentialMessage(payload.p, payload.s, payload.n);
  try {
    return sr25519Verify(msg, hexToU8a(payload.sig), pk);
  } catch {
    return false;
  }
}

/**
 * Aggregate remarks into a tally.
 *
 * Each remark must: (1) parse, (2) target this proposal, (3) be signed
 * on-chain by the stealth address it declares, (4) carry a valid choice,
 * and (5) carry a coordinator-signed credential. First remark per nullifier
 * wins; later duplicates are silently dropped to defeat replay attempts.
 */
export function tallyRemarks(
  remarks: RawRemark[],
  opts: { proposalId: string; coordPubkey: string | Uint8Array },
): { tally: Tally; votes: AcceptedVote[] } {
  const tally: Tally = { yes: 0, no: 0, abstain: 0, invalid: 0, totalVoted: 0 };
  const seen = new Set<string>();
  const accepted: AcceptedVote[] = [];

  for (const r of remarks) {
    const payload = decodeRemark(r.text);
    if (!payload) continue;
    if (payload.p !== opts.proposalId) continue;

    if (!r.signer || r.signer !== payload.s) {
      tally.invalid++;
      continue;
    }
    if (!CHOICES.includes(payload.c)) {
      tally.invalid++;
      continue;
    }
    if (!verifyCredential(payload, opts.coordPubkey)) {
      tally.invalid++;
      continue;
    }
    if (seen.has(payload.n)) continue;
    seen.add(payload.n);

    tally[payload.c]++;
    tally.totalVoted++;
    accepted.push({ ...payload, blockNumber: r.blockNumber });
  }

  return { tally, votes: accepted };
}
