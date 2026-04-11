/**
 * Pure logic shared between the browser UI and the faucet API.
 *
 * This package holds everything that does NOT depend on a specific JS
 * runtime: wire formats, parsers, ring reconstruction, tally, and the
 * plain-data shape of a BLSAG signature. Both packages import from
 * here, so there is one source of truth for message bytes and
 * canonical ring ordering.
 *
 * What is NOT in here:
 *   - The BLSAG primitive itself (lives in `packages/ring-sig`, built
 *     to two wasm targets: `bundler` for Vite, `nodejs` for NestJS).
 *   - Platform plumbing: React, @polkadot/api, NestJS decorators,
 *     storage, RPC, fetch.
 *
 * Rule of thumb: if your function reads or writes the outside world,
 * it doesn't belong here. If it turns some bytes into some other
 * bytes, it does.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type Choice = 'yes' | 'no' | 'abstain';
export const CHOICES: Choice[] = ['yes', 'no', 'abstain'];

/**
 * Wire shape of a BLSAG ring signature — same field names as the
 * upstream `BlsagSignature` struct, all hex-encoded so JSON
 * round-trips cleanly. This is the type that flows between the UI,
 * the faucet, and on-chain remarks.
 */
export interface RingSignature {
  /** 32-byte initial challenge scalar, hex. */
  challenge: string;
  /** 32-byte response scalars, one per ring member, hex. */
  responses: string[];
  /** 32-byte key image, hex. Deterministic per signer. */
  key_image: string;
}

/** Parsed announce remark text. */
export interface AnnouncePayload {
  proposalId: string;
  /** 32-byte compressed Ristretto255 voting public key, hex. */
  vkPub: string;
}

/**
 * Parsed vote remark JSON.
 *
 * `rb` (ring block) is the chain block number at which the voter
 * computed the canonical ring before signing. Verifiers reconstruct
 * the ring at exactly this block — that's how a vote signed against
 * a smaller ring (because not everyone had announced yet) stays
 * verifiable later, when more announces have landed.
 */
export interface VotePayload {
  v: 2;
  p: string;
  c: Choice;
  rb: number;
  sig: RingSignature;
}

export interface AcceptedVote extends VotePayload {
  blockNumber: number;
}

/**
 * Reason a vote remark was bucketed as `invalid`. Surfaced in the
 * tally so the UI can show "vote at block X rejected because Y"
 * instead of a generic "failed verification" counter.
 */
export type InvalidReason =
  | 'no-start-remark' // coordinator hasn't opened voting yet
  | 'pre-start-vote' // vote landed at or before the start block
  | 'ring-too-small' // ring at vote.rb has < 2 members
  | 'sig-verify-failed' // BLSAG verify returned false (math)
  | 'sig-structural-error' // verifier threw (malformed bytes)
  | 'unknown-error';

export interface InvalidVoteEntry {
  blockNumber: number;
  /** ringBlock embedded in the vote payload (if parseable). */
  rb: number | null;
  reason: InvalidReason;
  /** Optional extra detail for the operator (e.g. ring size at rb). */
  detail?: string;
}

export interface Tally {
  yes: number;
  no: number;
  abstain: number;
  invalid: number;
  totalVoted: number;
}

/**
 * Minimum shape the scan-and-tally pipeline needs from each indexed
 * extrinsic. Decoupled from any backend / RPC type so the same code
 * path runs against mocks, the browser's RPC scan, and the server's
 * indexer.
 */
export interface RemarkLike {
  blockNumber: number;
  signer: string;
  text: string;
}

/**
 * Signature of a BLSAG verifier — injected into `tallyRemarks` so
 * this module stays WASM-free. Concrete implementations live in
 * `packages/ui/src/ring-sig.ts` (bundler target) and
 * `packages/api/src/faucet/ring-sig-verifier.ts` (nodejs target).
 */
export type RingSigVerify = (
  sig: RingSignature,
  ring: string[],
  messageHex: string,
) => boolean;

// ---------------------------------------------------------------------------
// Announce remark
// ---------------------------------------------------------------------------

const ANNOUNCE_PREFIX = 'anon-vote-v2:announce:';
const START_PREFIX = 'anon-vote-v2:start:';

/**
 * Build the text body of an announce remark. Caller publishes it via
 * `system.remark` signed by their REAL wallet.
 *
 * Format: `anon-vote-v2:announce:<proposalId>:<vkPubHex>`. Colon-
 * separated instead of JSON because announces are short and need to
 * be grep-able on block explorers.
 */
export function encodeAnnounceRemark(
  proposalId: string,
  vkPubHex: string,
): string {
  if (proposalId.includes(':')) {
    // The simple parser splits on `:` so a colon in the proposal id
    // would corrupt the round-trip. Caller's mistake — fail loudly.
    throw new Error(`proposalId must not contain ':' (got "${proposalId}")`);
  }
  if (!isHex32(vkPubHex)) {
    throw new Error(`vkPub must be 32-byte hex (got "${vkPubHex}")`);
  }
  return `${ANNOUNCE_PREFIX}${proposalId}:${vkPubHex.toLowerCase()}`;
}

/**
 * Parse a remark text as an announce payload. Returns null for
 * anything that doesn't match the prefix or the shape — every
 * indexer scans every `system.remark` on chain, so most inputs will
 * be unrelated.
 */
export function parseAnnounceRemark(text: string): AnnouncePayload | null {
  if (typeof text !== 'string' || !text.startsWith(ANNOUNCE_PREFIX)) {
    return null;
  }
  const rest = text.slice(ANNOUNCE_PREFIX.length);
  // proposalId : vkPub — proposalId disallows ':' so the split is unambiguous.
  const idx = rest.indexOf(':');
  if (idx <= 0) return null;
  const proposalId = rest.slice(0, idx);
  const vkPub = rest.slice(idx + 1).toLowerCase();
  if (!isHex32(vkPub)) return null;
  return { proposalId, vkPub };
}

// ---------------------------------------------------------------------------
// Start remark — published by the coordinator to open the voting
// window. Voters and verifiers refuse to count any vote remark
// before the block this lands in.
//
// The coordinator's only protocol power is "decide WHEN voting
// opens". They cannot affect WHO votes (allowlist + ring) or
// WHAT (the choices). They cannot forge or block individual
// votes. The chain runtime verifies the sr25519 extrinsic
// signature, so all the verifier needs to do is check that
// the signer matches the configured coordinator address.
// ---------------------------------------------------------------------------

/**
 * Build the text body of a start remark. Caller publishes it via
 * `system.remark` signed by the coordinator wallet at the moment
 * voting should open.
 */
export function encodeStartRemark(proposalId: string): string {
  if (proposalId.includes(':')) {
    throw new Error(`proposalId must not contain ':' (got "${proposalId}")`);
  }
  return `${START_PREFIX}${proposalId}`;
}

/**
 * Parse a remark text as a start payload. Returns the proposalId
 * if the text matches the expected shape, null otherwise. The
 * caller is responsible for verifying that the on-chain extrinsic
 * signer matches the configured coordinator address — that's the
 * authentication we trust the chain runtime for.
 */
export function parseStartRemark(text: string): { proposalId: string } | null {
  if (typeof text !== 'string' || !text.startsWith(START_PREFIX)) return null;
  const proposalId = text.slice(START_PREFIX.length);
  if (proposalId.length === 0 || proposalId.includes(':')) return null;
  return { proposalId };
}

/**
 * Find the chain block number at which the coordinator opened
 * voting for `proposalId`. The first start remark from the
 * coordinator wins (if multiple are published, later ones are
 * harmless dust). Returns null if no valid start remark exists.
 */
export function findVotingStartBlock(
  remarks: RemarkLike[],
  opts: { proposalId: string; coordinatorAddress: string },
): number | null {
  let earliest: number | null = null;
  for (const r of remarks) {
    if (r.signer !== opts.coordinatorAddress) continue;
    const parsed = parseStartRemark(r.text);
    if (!parsed || parsed.proposalId !== opts.proposalId) continue;
    if (earliest === null || r.blockNumber < earliest) {
      earliest = r.blockNumber;
    }
  }
  return earliest;
}

// ---------------------------------------------------------------------------
// Vote remark
// ---------------------------------------------------------------------------

export function encodeVoteRemark(args: {
  proposalId: string;
  choice: Choice;
  ringBlock: number;
  sig: RingSignature;
}): string {
  const payload: VotePayload = {
    v: 2,
    p: args.proposalId,
    c: args.choice,
    rb: args.ringBlock,
    sig: args.sig,
  };
  return JSON.stringify(payload);
}

/**
 * Parse a remark text as a vote payload. Returns null for anything
 * that doesn't structurally match — invalid signatures are filtered
 * later by `tallyRemarks` (which needs a verifier function).
 */
export function parseVoteRemark(text: string): VotePayload | null {
  if (typeof text !== 'string' || text[0] !== '{') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(obj)) return null;
  if ((obj as { v?: unknown }).v !== 2) return null;

  const o = obj as Record<string, unknown>;
  if (typeof o.p !== 'string') return null;
  if (typeof o.c !== 'string' || !CHOICES.includes(o.c as Choice)) return null;
  if (typeof o.rb !== 'number' || !Number.isInteger(o.rb) || o.rb < 0) return null;
  if (!isPlainObject(o.sig)) return null;

  const sig = o.sig as Record<string, unknown>;
  if (!isHex32(sig.challenge)) return null;
  if (!isHex32(sig.key_image)) return null;
  if (!Array.isArray(sig.responses)) return null;
  if (!sig.responses.every(isHex32)) return null;

  return {
    v: 2,
    p: o.p,
    c: o.c as Choice,
    rb: o.rb,
    sig: {
      challenge: (sig.challenge as string).toLowerCase(),
      responses: (sig.responses as string[]).map((s) => s.toLowerCase()),
      key_image: (sig.key_image as string).toLowerCase(),
    },
  };
}

// ---------------------------------------------------------------------------
// Signed messages
// ---------------------------------------------------------------------------

/**
 * Bytes (as hex) signed by the voter when casting a vote. Bound to
 * the proposal id, the choice, AND the ringBlock the signature was
 * computed against. Embedding ringBlock in the signed message means
 * the verifier knows exactly which ring to reconstruct, and a
 * signature can't be replayed against a different ring snapshot of
 * the same proposal.
 */
export function voteMessageHex(
  proposalId: string,
  choice: Choice,
  ringBlock: number,
): string {
  return utf8ToHex(`vote:${proposalId}:${choice}:${ringBlock}`);
}

/**
 * Bytes (as hex) signed by the voter when requesting a faucet drip.
 * Bound to proposal id, gas address, AND the ringBlock the signature
 * was computed against. The gas address is bound so the faucet
 * cannot substitute a different recipient; the ringBlock is bound
 * so the faucet knows which ring to verify against.
 *
 * Same VK sk produces the same key image for drip and vote. We
 * accept that — dedup works correctly in both places, and the
 * operational trade-off is documented in the design notes.
 */
export function dripMessageHex(
  proposalId: string,
  gasAddress: string,
  ringBlock: number,
): string {
  return utf8ToHex(`drip:${proposalId}:${gasAddress}:${ringBlock}`);
}

// ---------------------------------------------------------------------------
// Ring reconstruction
// ---------------------------------------------------------------------------

/**
 * Rebuild the canonical ring for `proposalId` from a list of indexed
 * remarks.
 *
 * Rules:
 *   - Only remarks parseable as announces for this proposal count.
 *   - We trust the on-chain extrinsic signer to identify the real
 *     voter (the chain runtime already verified the sr25519
 *     signature). Whether that signer is on the allowlist is
 *     enforced via the optional `allowedRealAddresses` set; we keep
 *     the function pure and leave that check at the call site.
 *   - If a real voter announces multiple keys (e.g. regenerated
 *     after closing a tab), the LATEST announce wins.
 *   - The result is sorted lexicographically by hex public key. That
 *     is the canonical order every observer must produce, otherwise
 *     BLSAG verification fails — the ring is part of the key-prefix
 *     hash, and order matters.
 *
 * Callers are responsible for any block-window pre-filtering they
 * want — this function does not know about block ranges. Use
 * `computeRingAt` if you want a ring "as of" a specific block.
 */
export function reconstructRing(
  remarks: RemarkLike[],
  opts: { proposalId: string; allowedRealAddresses?: ReadonlySet<string> },
): string[] {
  // realAddress -> { vkPub, blockNumber }
  const latestByVoter = new Map<
    string,
    { vkPub: string; blockNumber: number }
  >();

  for (const r of remarks) {
    const parsed = parseAnnounceRemark(r.text);
    if (!parsed) continue;
    if (parsed.proposalId !== opts.proposalId) continue;
    if (
      opts.allowedRealAddresses &&
      !opts.allowedRealAddresses.has(r.signer)
    ) {
      continue;
    }
    const prev = latestByVoter.get(r.signer);
    if (!prev || r.blockNumber > prev.blockNumber) {
      latestByVoter.set(r.signer, {
        vkPub: parsed.vkPub,
        blockNumber: r.blockNumber,
      });
    }
  }

  // Deduplicate by vkPub as well — two voters announcing the same key
  // is either a copy-paste mistake or an attack; either way the ring
  // should contain each key at most once.
  const seenPub = new Set<string>();
  const ring: string[] = [];
  for (const { vkPub } of latestByVoter.values()) {
    if (seenPub.has(vkPub)) continue;
    seenPub.add(vkPub);
    ring.push(vkPub);
  }
  ring.sort();
  return ring;
}

/**
 * Reconstruct the canonical ring "as of" a specific block — i.e.
 * including only announce remarks that landed at or before
 * `atBlock`. This is what every verifier calls per-vote: it takes
 * the vote's embedded `rb` (ring block) and rebuilds the exact ring
 * the voter signed against.
 *
 * Why this is a one-liner wrapper rather than inline at every call
 * site: it's the canonical "ring-at-time-T" semantics, and having a
 * single function name makes the call sites self-documenting and
 * the behavior trivially testable.
 */
export function computeRingAt(
  remarks: RemarkLike[],
  opts: {
    proposalId: string;
    atBlock: number;
    allowedRealAddresses?: ReadonlySet<string>;
  },
): string[] {
  const inWindow = remarks.filter((r) => r.blockNumber <= opts.atBlock);
  return reconstructRing(inWindow, {
    proposalId: opts.proposalId,
    allowedRealAddresses: opts.allowedRealAddresses,
  });
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

/**
 * Aggregate vote remarks into a tally.
 *
 * No fixed ring is passed in. The function takes ALL remarks
 * (announce + vote, mixed) and for each vote internally
 * reconstructs the ring "as of" the vote's embedded `rb` field.
 * That's how we support a growing ring across the lifetime of a
 * proposal: every vote is verified against the exact snapshot the
 * voter saw at sign time.
 *
 * Each vote remark must satisfy ALL of:
 *   1. parses as a vote payload (and includes a non-negative `rb`)
 *   2. targets the requested proposal
 *   3. has a structurally-valid choice
 *   4. its ring signature verifies against the ring computed at
 *      `payload.rb` under `voteMessageHex(proposalId, choice, rb)`
 *   5. its key image has not been seen in an earlier remark
 *
 * Anything that fails (1)-(4) is counted as `invalid`. Anything
 * that fails (5) is silently dropped — duplicate key images are how
 * we prevent double-voting, not an error.
 *
 * Order matters for (5): we walk vote remarks in block-ascending
 * order so "first remark wins per nullifier". Caller doesn't need
 * to pre-sort.
 */
export function tallyRemarks(
  remarks: RemarkLike[],
  opts: {
    proposalId: string;
    coordinatorAddress: string;
    allowedRealAddresses?: ReadonlySet<string>;
    verify: RingSigVerify;
  },
): {
  tally: Tally;
  votes: AcceptedVote[];
  votingStartBlock: number | null;
  invalidReasons: InvalidVoteEntry[];
} {
  const tally: Tally = {
    yes: 0,
    no: 0,
    abstain: 0,
    invalid: 0,
    totalVoted: 0,
  };
  const seenKeyImage = new Set<string>();
  const accepted: AcceptedVote[] = [];
  const invalidReasons: InvalidVoteEntry[] = [];

  // The coordinator opens voting by publishing a start remark.
  // Until that remark is observed, no votes count. The check
  // below uses `<` (strict) so a vote in the same block as the
  // start remark is considered post-start — they were both
  // included by the chain author, the temporal ordering within
  // a block is irrelevant for our protocol.
  const votingStartBlock = findVotingStartBlock(remarks, {
    proposalId: opts.proposalId,
    coordinatorAddress: opts.coordinatorAddress,
  });

  const recordInvalid = (
    blockNumber: number,
    rb: number | null,
    reason: InvalidReason,
    detail?: string,
  ): void => {
    tally.invalid++;
    invalidReasons.push({ blockNumber, rb, reason, detail });
  };

  // Sort once by block number so vote dedup ("first wins") is
  // deterministic regardless of how remarks were collected.
  const sorted = [...remarks].sort((a, b) => a.blockNumber - b.blockNumber);

  for (const r of sorted) {
    const payload = parseVoteRemark(r.text);
    if (!payload) continue;
    if (payload.p !== opts.proposalId) continue;

    // Pre-start guard. Two cases:
    //   - no start remark at all: all votes invalid
    //   - vote in a block strictly before start: invalid
    if (votingStartBlock === null) {
      recordInvalid(
        r.blockNumber,
        payload.rb,
        'no-start-remark',
        'no start remark from coordinator observed yet',
      );
      continue;
    }
    if (r.blockNumber < votingStartBlock) {
      recordInvalid(
        r.blockNumber,
        payload.rb,
        'pre-start-vote',
        `vote in block ${r.blockNumber} but start remark at ${votingStartBlock}`,
      );
      continue;
    }

    // Reconstruct the ring as the voter saw it. Note we recompute
    // per vote — for typical small senates this is trivial in cost.
    const ring = computeRingAt(remarks, {
      proposalId: opts.proposalId,
      atBlock: payload.rb,
      allowedRealAddresses: opts.allowedRealAddresses,
    });

    // BLSAG requires ring size >= 2 to be a meaningful anonymity
    // set. We're stricter than the upstream crate (which would
    // also reject) for clarity in tally output.
    if (ring.length < 2) {
      recordInvalid(
        r.blockNumber,
        payload.rb,
        'ring-too-small',
        `ring at rb=${payload.rb} has only ${ring.length} member(s)`,
      );
      continue;
    }

    let valid = false;
    let threwError: string | null = null;
    try {
      valid = opts.verify(
        payload.sig,
        ring,
        voteMessageHex(payload.p, payload.c, payload.rb),
      );
    } catch (e) {
      threwError = e instanceof Error ? e.message : String(e);
      valid = false;
    }
    if (!valid) {
      if (threwError !== null) {
        recordInvalid(
          r.blockNumber,
          payload.rb,
          'sig-structural-error',
          `verifier threw: ${threwError}`,
        );
      } else {
        recordInvalid(
          r.blockNumber,
          payload.rb,
          'sig-verify-failed',
          `BLSAG verify returned false against ring of size ${ring.length} at rb=${payload.rb}`,
        );
      }
      continue;
    }

    if (seenKeyImage.has(payload.sig.key_image)) continue;
    seenKeyImage.add(payload.sig.key_image);

    tally[payload.c]++;
    tally.totalVoted++;
    accepted.push({ ...payload, blockNumber: r.blockNumber });
  }

  return { tally, votes: accepted, votingStartBlock, invalidReasons };
}

// ---------------------------------------------------------------------------
// Helpers — deliberately private. Exported helpers would invite
// accidental use at call sites where the invariants don't hold.
// ---------------------------------------------------------------------------

const HEX32_RE = /^[0-9a-fA-F]{64}$/;

function isHex32(v: unknown): v is string {
  return typeof v === 'string' && HEX32_RE.test(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * UTF-8 → lowercase hex. We deliberately avoid `Buffer` because the
 * same code runs in browsers (no Buffer) and in Node (has Buffer but
 * pulling it in bloats bundlers). `TextEncoder` is a platform
 * primitive in both.
 */
function utf8ToHex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
