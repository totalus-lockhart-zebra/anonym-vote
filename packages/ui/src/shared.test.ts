/**
 * Tests for @anon-vote/shared.
 *
 * Two layers:
 *   1. Pure: encode/parse round-trips, ring reconstruction edge
 *      cases, tally with a stub verifier. These are the only places
 *      shared adds logic on top of raw data, so these are the only
 *      places it needs its own coverage.
 *   2. Real WASM: a happy-path tally that runs actual BLSAG
 *      signatures through the Node-target wasm-pack output. This
 *      proves the wire format we encode here is byte-compatible
 *      with what the verifier expects.
 *
 * The Node-target WASM is imported via a relative path so we don't
 * need a second package.json entry. The browser code goes through
 * the bundler target via the `ring-sig-wasm` package alias.
 */

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — wasm-pack nodejs target ships its own .d.ts; we use
// it directly without going through a package alias.
import * as nodeRingSig from '../../ring-sig/wasm/pkg/ring_sig_wasm.js';
import {
  CHOICES,
  computeRingAt,
  encodeAnnounceRemark,
  parseAnnounceRemark,
  encodeStartRemark,
  parseStartRemark,
  findVotingStartBlock,
  encodeVoteRemark,
  parseVoteRemark,
  voteMessageHex,
  dripMessageHex,
  reconstructRing,
  tallyRemarks,
  type RemarkLike,
  type RingSigVerify,
  type RingSignature,
} from '@anon-vote/shared';

const PROPOSAL = 'proposal-test-1';
const COORDINATOR = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

// Bridge nodeRingSig (typed as `any` because the .d.ts says JsValue) into
// the typed surface @anon-vote/shared expects. Wrapping it once at the test
// boundary keeps each individual test free of casts.
const realVerify: RingSigVerify = (sig, ring, msgHex) =>
  nodeRingSig.verify_js(sig, ring, msgHex);

const realSign = (sk: string, ring: string[], msgHex: string): RingSignature =>
  nodeRingSig.sign_js(sk, ring, msgHex) as RingSignature;

const realKeygen = (): { sk: string; pk: string } =>
  nodeRingSig.keygen() as { sk: string; pk: string };

// ---------------------------------------------------------------------------
// announce remark
// ---------------------------------------------------------------------------

describe('announce remark', () => {
  const vkPub = 'a'.repeat(64); // 32-byte hex placeholder; format check only

  it('round-trips', () => {
    const text = encodeAnnounceRemark(PROPOSAL, vkPub);
    expect(parseAnnounceRemark(text)).toEqual({
      proposalId: PROPOSAL,
      vkPub,
    });
  });

  it('rejects non-hex vkPub', () => {
    expect(() => encodeAnnounceRemark(PROPOSAL, 'not-hex')).toThrow();
    expect(parseAnnounceRemark(`anon-vote-v2:announce:${PROPOSAL}:zz`)).toBeNull();
  });

  it('rejects proposalId containing colon', () => {
    expect(() => encodeAnnounceRemark('bad:id', vkPub)).toThrow();
  });

  it('returns null for unrelated remark text', () => {
    expect(parseAnnounceRemark('hello world')).toBeNull();
    expect(parseAnnounceRemark('')).toBeNull();
    expect(parseAnnounceRemark('anon-vote-v1:something')).toBeNull();
  });

  it('normalizes hex casing on parse', () => {
    const upper = vkPub.toUpperCase();
    const text = `anon-vote-v2:announce:${PROPOSAL}:${upper}`;
    expect(parseAnnounceRemark(text)?.vkPub).toBe(vkPub.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// vote remark
// ---------------------------------------------------------------------------

describe('vote remark', () => {
  const fakeSig: RingSignature = {
    challenge: '11'.repeat(32),
    responses: ['22'.repeat(32), '33'.repeat(32)],
    key_image: '44'.repeat(32),
  };

  it('round-trips with ringBlock', () => {
    const text = encodeVoteRemark({
      proposalId: PROPOSAL,
      choice: 'yes',
      ringBlock: 12345,
      sig: fakeSig,
    });
    const parsed = parseVoteRemark(text);
    expect(parsed).toEqual({
      v: 2,
      p: PROPOSAL,
      c: 'yes',
      rb: 12345,
      sig: fakeSig,
    });
  });

  it('rejects non-JSON text', () => {
    expect(parseVoteRemark('hello')).toBeNull();
    expect(parseVoteRemark('')).toBeNull();
    expect(parseVoteRemark('{invalid')).toBeNull();
  });

  it('rejects v != 2', () => {
    const text = JSON.stringify({ v: 1, p: PROPOSAL, c: 'yes', rb: 1, sig: fakeSig });
    expect(parseVoteRemark(text)).toBeNull();
  });

  it('rejects unknown choice', () => {
    const text = JSON.stringify({
      v: 2,
      p: PROPOSAL,
      c: 'maybe',
      rb: 1,
      sig: fakeSig,
    });
    expect(parseVoteRemark(text)).toBeNull();
  });

  it('rejects missing or non-integer ringBlock', () => {
    expect(
      parseVoteRemark(JSON.stringify({ v: 2, p: PROPOSAL, c: 'yes', sig: fakeSig })),
    ).toBeNull();
    expect(
      parseVoteRemark(
        JSON.stringify({ v: 2, p: PROPOSAL, c: 'yes', rb: -1, sig: fakeSig }),
      ),
    ).toBeNull();
    expect(
      parseVoteRemark(
        JSON.stringify({ v: 2, p: PROPOSAL, c: 'yes', rb: 1.5, sig: fakeSig }),
      ),
    ).toBeNull();
    expect(
      parseVoteRemark(
        JSON.stringify({ v: 2, p: PROPOSAL, c: 'yes', rb: '1', sig: fakeSig }),
      ),
    ).toBeNull();
  });

  it('rejects malformed sig fields', () => {
    const bad = { ...fakeSig, key_image: 'too-short' };
    const text = JSON.stringify({ v: 2, p: PROPOSAL, c: 'yes', rb: 1, sig: bad });
    expect(parseVoteRemark(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// signed messages
// ---------------------------------------------------------------------------

describe('voteMessageHex / dripMessageHex', () => {
  it('voteMessageHex binds proposal + choice + ringBlock', () => {
    const expected = Buffer.from(`vote:${PROPOSAL}:yes:42`, 'utf-8').toString('hex');
    expect(voteMessageHex(PROPOSAL, 'yes', 42)).toBe(expected);
    // Different choice → different bytes
    expect(voteMessageHex(PROPOSAL, 'no', 42)).not.toBe(
      voteMessageHex(PROPOSAL, 'yes', 42),
    );
    // Different proposal → different bytes
    expect(voteMessageHex('other', 'yes', 42)).not.toBe(
      voteMessageHex(PROPOSAL, 'yes', 42),
    );
    // Different ringBlock → different bytes (so two votes with same
    // sk + same choice but different ring snapshots can't be confused).
    expect(voteMessageHex(PROPOSAL, 'yes', 43)).not.toBe(
      voteMessageHex(PROPOSAL, 'yes', 42),
    );
  });

  it('dripMessageHex binds proposal + gas address + ringBlock', () => {
    expect(dripMessageHex(PROPOSAL, '5Foo', 1)).not.toBe(
      dripMessageHex(PROPOSAL, '5Bar', 1),
    );
    expect(dripMessageHex(PROPOSAL, '5Foo', 1)).not.toBe(
      dripMessageHex(PROPOSAL, '5Foo', 2),
    );
  });

  it('all defined choices produce distinct messages', () => {
    const seen = new Set(CHOICES.map((c) => voteMessageHex(PROPOSAL, c, 1)));
    expect(seen.size).toBe(CHOICES.length);
  });
});

// ---------------------------------------------------------------------------
// start remark
// ---------------------------------------------------------------------------

describe('start remark', () => {
  it('encodes and parses round-trip', () => {
    const text = encodeStartRemark(PROPOSAL);
    expect(text).toBe(`anon-vote-v2:start:${PROPOSAL}`);
    expect(parseStartRemark(text)).toEqual({ proposalId: PROPOSAL });
  });

  it('rejects proposalId with colon', () => {
    expect(() => encodeStartRemark('bad:id')).toThrow();
  });

  it('returns null for unrelated remark text', () => {
    expect(parseStartRemark('hello')).toBeNull();
    expect(parseStartRemark('')).toBeNull();
    expect(parseStartRemark('anon-vote-v2:announce:foo:bar')).toBeNull();
    expect(parseStartRemark('anon-vote-v2:start:')).toBeNull();
    expect(parseStartRemark('anon-vote-v2:start:has:colon')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findVotingStartBlock
// ---------------------------------------------------------------------------

describe('findVotingStartBlock', () => {
  const startText = encodeStartRemark(PROPOSAL);

  it('returns null when no start remark exists', () => {
    expect(
      findVotingStartBlock([], {
        proposalId: PROPOSAL,
        coordinatorAddress: COORDINATOR,
      }),
    ).toBeNull();
  });

  it('finds the start remark from the configured coordinator', () => {
    const remarks: RemarkLike[] = [
      { blockNumber: 100, signer: COORDINATOR, text: startText },
    ];
    expect(
      findVotingStartBlock(remarks, {
        proposalId: PROPOSAL,
        coordinatorAddress: COORDINATOR,
      }),
    ).toBe(100);
  });

  it('ignores start remarks signed by anyone other than the coordinator', () => {
    const remarks: RemarkLike[] = [
      { blockNumber: 100, signer: '5Imposter', text: startText },
    ];
    expect(
      findVotingStartBlock(remarks, {
        proposalId: PROPOSAL,
        coordinatorAddress: COORDINATOR,
      }),
    ).toBeNull();
  });

  it('ignores start remarks for other proposals', () => {
    const remarks: RemarkLike[] = [
      { blockNumber: 100, signer: COORDINATOR, text: encodeStartRemark('other') },
    ];
    expect(
      findVotingStartBlock(remarks, {
        proposalId: PROPOSAL,
        coordinatorAddress: COORDINATOR,
      }),
    ).toBeNull();
  });

  it('takes the earliest start remark when multiple exist', () => {
    const remarks: RemarkLike[] = [
      { blockNumber: 200, signer: COORDINATOR, text: startText },
      { blockNumber: 100, signer: COORDINATOR, text: startText },
      { blockNumber: 300, signer: COORDINATOR, text: startText },
    ];
    expect(
      findVotingStartBlock(remarks, {
        proposalId: PROPOSAL,
        coordinatorAddress: COORDINATOR,
      }),
    ).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// reconstructRing
// ---------------------------------------------------------------------------

describe('reconstructRing', () => {
  const alice = 'aa'.repeat(32);
  const bob = 'bb'.repeat(32);
  const eve = 'ee'.repeat(32);

  function announce(
    block: number,
    signer: string,
    vk: string,
    proposalId: string = PROPOSAL,
  ): RemarkLike {
    return {
      blockNumber: block,
      signer,
      text: encodeAnnounceRemark(proposalId, vk),
    };
  }

  it('produces sorted unique ring from valid announces', () => {
    const ring = reconstructRing(
      [announce(1, '5Alice', alice), announce(2, '5Bob', bob), announce(3, '5Eve', eve)],
      { proposalId: PROPOSAL },
    );
    expect(ring).toEqual([alice, bob, eve]);
  });

  it('keeps the latest announce per real address', () => {
    const aliceV1 = '11'.repeat(32);
    const aliceV2 = '22'.repeat(32);
    const ring = reconstructRing(
      [announce(1, '5Alice', aliceV1), announce(5, '5Alice', aliceV2)],
      { proposalId: PROPOSAL },
    );
    expect(ring).toEqual([aliceV2]);
  });

  it('filters out announces for other proposals', () => {
    const ring = reconstructRing(
      [announce(1, '5Alice', alice, 'other'), announce(2, '5Bob', bob)],
      { proposalId: PROPOSAL },
    );
    expect(ring).toEqual([bob]);
  });

  it('respects allowedRealAddresses', () => {
    const ring = reconstructRing(
      [announce(1, '5Alice', alice), announce(2, '5Outsider', bob)],
      { proposalId: PROPOSAL, allowedRealAddresses: new Set(['5Alice']) },
    );
    expect(ring).toEqual([alice]);
  });

  it('drops duplicate vkPub even if announced by two voters', () => {
    const ring = reconstructRing(
      [announce(1, '5Alice', alice), announce(2, '5Bob', alice)],
      { proposalId: PROPOSAL },
    );
    expect(ring.length).toBe(1);
  });

  it('returns empty for no announces', () => {
    expect(reconstructRing([], { proposalId: PROPOSAL })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeRingAt — block-window helper
// ---------------------------------------------------------------------------

describe('computeRingAt', () => {
  const alice = 'aa'.repeat(32);
  const bob = 'bb'.repeat(32);
  const eve = 'ee'.repeat(32);

  const remarks: RemarkLike[] = [
    {
      blockNumber: 100,
      signer: '5Alice',
      text: encodeAnnounceRemark(PROPOSAL, alice),
    },
    {
      blockNumber: 200,
      signer: '5Bob',
      text: encodeAnnounceRemark(PROPOSAL, bob),
    },
    {
      blockNumber: 300,
      signer: '5Eve',
      text: encodeAnnounceRemark(PROPOSAL, eve),
    },
  ];

  it('includes only announces at or before atBlock', () => {
    expect(computeRingAt(remarks, { proposalId: PROPOSAL, atBlock: 99 })).toEqual([]);
    expect(computeRingAt(remarks, { proposalId: PROPOSAL, atBlock: 100 })).toEqual([
      alice,
    ]);
    expect(computeRingAt(remarks, { proposalId: PROPOSAL, atBlock: 200 })).toEqual([
      alice,
      bob,
    ]);
    expect(computeRingAt(remarks, { proposalId: PROPOSAL, atBlock: 300 })).toEqual([
      alice,
      bob,
      eve,
    ]);
    expect(computeRingAt(remarks, { proposalId: PROPOSAL, atBlock: 999 })).toEqual([
      alice,
      bob,
      eve,
    ]);
  });

  it('threading allowedRealAddresses filters out non-allowlist signers', () => {
    const allowed = new Set(['5Alice', '5Bob']);
    expect(
      computeRingAt(remarks, {
        proposalId: PROPOSAL,
        atBlock: 999,
        allowedRealAddresses: allowed,
      }),
    ).toEqual([alice, bob]);
  });
});

// ---------------------------------------------------------------------------
// tallyRemarks — pure path with stub verifier
// ---------------------------------------------------------------------------

describe('tallyRemarks (stub verify)', () => {
  // For the stub-verifier tests we don't care about real ring sigs;
  // we just need at least 2 announces in scope so the ring meets
  // the minimum-2 constraint, AND a coordinator start remark so
  // the tally accepts post-start votes at all.
  const alice = 'aa'.repeat(32);
  const bob = 'bb'.repeat(32);
  const minimalSetup: RemarkLike[] = [
    { blockNumber: 1, signer: '5Alice', text: encodeAnnounceRemark(PROPOSAL, alice) },
    { blockNumber: 2, signer: '5Bob', text: encodeAnnounceRemark(PROPOSAL, bob) },
    { blockNumber: 5, signer: COORDINATOR, text: encodeStartRemark(PROPOSAL) },
  ];

  function fakeSig(keyImage: string): RingSignature {
    return {
      challenge: '11'.repeat(32),
      responses: ['22'.repeat(32), '33'.repeat(32)],
      key_image: keyImage,
    };
  }

  function makeVote(
    block: number,
    choice: string,
    keyImage: string,
    rb: number = 2,
  ): RemarkLike {
    return {
      blockNumber: block,
      signer: '5Whatever',
      text: encodeVoteRemark({
        proposalId: PROPOSAL,
        choice: choice as 'yes',
        ringBlock: rb,
        sig: fakeSig(keyImage),
      }),
    };
  }

  const acceptAll: RingSigVerify = () => true;
  const rejectAll: RingSigVerify = () => false;

  it('counts unique key images per choice', () => {
    const { tally } = tallyRemarks(
      [
        ...minimalSetup,
        makeVote(10, 'yes', 'aa'.repeat(32)),
        makeVote(11, 'no', 'bb'.repeat(32)),
        makeVote(12, 'yes', 'cc'.repeat(32)),
        makeVote(13, 'abstain', 'dd'.repeat(32)),
      ],
      { proposalId: PROPOSAL, coordinatorAddress: COORDINATOR, verify: acceptAll },
    );
    expect(tally).toEqual({ yes: 2, no: 1, abstain: 1, invalid: 0, totalVoted: 4 });
  });

  it('drops second remark with same key image (first wins)', () => {
    const dup = 'ee'.repeat(32);
    const { tally, votes } = tallyRemarks(
      [...minimalSetup, makeVote(10, 'yes', dup), makeVote(11, 'no', dup)],
      { proposalId: PROPOSAL, coordinatorAddress: COORDINATOR, verify: acceptAll },
    );
    expect(tally.yes).toBe(1);
    expect(tally.no).toBe(0);
    expect(tally.totalVoted).toBe(1);
    expect(votes.length).toBe(1);
    expect(votes[0].c).toBe('yes');
  });

  it('counts invalid signatures separately, not in totalVoted', () => {
    const { tally } = tallyRemarks(
      [...minimalSetup, makeVote(10, 'yes', 'aa'.repeat(32))],
      { proposalId: PROPOSAL, coordinatorAddress: COORDINATOR, verify: rejectAll },
    );
    expect(tally.invalid).toBe(1);
    expect(tally.totalVoted).toBe(0);
  });

  it('marks votes with empty ring (size < 2) as invalid', () => {
    // ringBlock=0 → no announces seen → ring size 0 → invalid.
    const { tally } = tallyRemarks(
      [...minimalSetup, makeVote(10, 'yes', 'aa'.repeat(32), 0)],
      { proposalId: PROPOSAL, coordinatorAddress: COORDINATOR, verify: acceptAll },
    );
    expect(tally.invalid).toBe(1);
    expect(tally.totalVoted).toBe(0);
  });

  it('ignores remarks for other proposals', () => {
    const otherText = encodeVoteRemark({
      proposalId: 'other',
      choice: 'yes',
      ringBlock: 2,
      sig: fakeSig('aa'.repeat(32)),
    });
    const { tally } = tallyRemarks(
      [...minimalSetup, { blockNumber: 10, signer: '5x', text: otherText }],
      { proposalId: PROPOSAL, coordinatorAddress: COORDINATOR, verify: acceptAll },
    );
    expect(tally.totalVoted).toBe(0);
    expect(tally.invalid).toBe(0);
  });

  it('treats verifier exceptions as invalid', () => {
    const throwing: RingSigVerify = () => {
      throw new Error('bad bytes');
    };
    const { tally } = tallyRemarks(
      [...minimalSetup, makeVote(10, 'yes', 'aa'.repeat(32))],
      { proposalId: PROPOSAL, coordinatorAddress: COORDINATOR, verify: throwing },
    );
    expect(tally.invalid).toBe(1);
  });

  it('accepts votes at the same block as the start remark', () => {
    // Boundary: start is at block 5, a vote at block 5 is allowed.
    // The chain author included both extrinsics in the same block,
    // so temporal ordering within a block is irrelevant — the vote
    // is "post-start" by chain consensus.
    const { tally } = tallyRemarks(
      [...minimalSetup, makeVote(5, 'yes', 'aa'.repeat(32))],
      { proposalId: PROPOSAL, coordinatorAddress: COORDINATOR, verify: acceptAll },
    );
    expect(tally.invalid).toBe(0);
    expect(tally.totalVoted).toBe(1);
    expect(tally.yes).toBe(1);
  });

  it('rejects votes in blocks strictly before the start remark', () => {
    // Vote at block 3 < start at block 5 → invalid.
    const { tally, invalidReasons } = tallyRemarks(
      [...minimalSetup, makeVote(3, 'yes', 'aa'.repeat(32))],
      { proposalId: PROPOSAL, coordinatorAddress: COORDINATOR, verify: acceptAll },
    );
    expect(tally.invalid).toBe(1);
    expect(tally.totalVoted).toBe(0);
    expect(invalidReasons).toHaveLength(1);
    expect(invalidReasons[0].reason).toBe('pre-start-vote');
  });

  it('rejects all votes as invalid when the start remark is missing entirely', () => {
    // Same setup but without the coordinator's start remark.
    const noStartSetup: RemarkLike[] = [
      { blockNumber: 1, signer: '5Alice', text: encodeAnnounceRemark(PROPOSAL, alice) },
      { blockNumber: 2, signer: '5Bob', text: encodeAnnounceRemark(PROPOSAL, bob) },
    ];
    const { tally, votingStartBlock, invalidReasons } = tallyRemarks(
      [...noStartSetup, makeVote(10, 'yes', 'aa'.repeat(32))],
      { proposalId: PROPOSAL, coordinatorAddress: COORDINATOR, verify: acceptAll },
    );
    expect(votingStartBlock).toBeNull();
    expect(tally.invalid).toBe(1);
    expect(tally.totalVoted).toBe(0);
    expect(invalidReasons).toHaveLength(1);
    expect(invalidReasons[0].reason).toBe('no-start-remark');
  });
});

// ---------------------------------------------------------------------------
// Real WASM end-to-end — proves the wire format we encode is what the
// verifier accepts. This is the bridge test between @anon-vote/shared
// and the vendored BLSAG crate.
// ---------------------------------------------------------------------------

describe('end-to-end with real BLSAG', () => {
  it('signs, encodes, parses, and tallies a real vote', () => {
    // Three voters announce in order. Alice will vote against the
    // ring at block 30 (containing all three).
    const alice = realKeygen();
    const bob = realKeygen();
    const eve = realKeygen();
    const announces: RemarkLike[] = [
      { blockNumber: 10, signer: '5Alice', text: encodeAnnounceRemark(PROPOSAL, alice.pk) },
      { blockNumber: 20, signer: '5Bob', text: encodeAnnounceRemark(PROPOSAL, bob.pk) },
      { blockNumber: 30, signer: '5Eve', text: encodeAnnounceRemark(PROPOSAL, eve.pk) },
      { blockNumber: 35, signer: COORDINATOR, text: encodeStartRemark(PROPOSAL) },
    ];
    const ringBlock = 30;
    const ring = computeRingAt(announces, {
      proposalId: PROPOSAL,
      atBlock: ringBlock,
    });
    expect(ring).toHaveLength(3);

    const sig = realSign(alice.sk, ring, voteMessageHex(PROPOSAL, 'yes', ringBlock));
    const remarkText = encodeVoteRemark({
      proposalId: PROPOSAL,
      choice: 'yes',
      ringBlock,
      sig,
    });

    const { tally, votes } = tallyRemarks(
      [...announces, { blockNumber: 42, signer: 'gas-addr', text: remarkText }],
      { proposalId: PROPOSAL, coordinatorAddress: COORDINATOR, verify: realVerify },
    );
    expect(tally).toEqual({ yes: 1, no: 0, abstain: 0, invalid: 0, totalVoted: 1 });
    expect(votes[0].blockNumber).toBe(42);
    expect(votes[0].rb).toBe(ringBlock);
    expect(votes[0].sig.key_image).toBe(sig.key_image);
  });

  it('verifies a vote signed against an EARLIER ring snapshot', () => {
    // The whole point of `rb` (ringBlock): Alice signs against the
    // ring as it existed at her sign-time. Bob and Eve announce
    // afterwards. Alice's vote stays valid because the tally
    // reconstructs her ring at HER ringBlock, not at head.
    const alice = realKeygen();
    const bob = realKeygen();
    const eve = realKeygen();
    const david = realKeygen();

    // Alice and Bob announce; ring at block 20 = {alice, bob}.
    const remarks: RemarkLike[] = [
      {
        blockNumber: 10,
        signer: '5Alice',
        text: encodeAnnounceRemark(PROPOSAL, alice.pk),
      },
      {
        blockNumber: 20,
        signer: '5Bob',
        text: encodeAnnounceRemark(PROPOSAL, bob.pk),
      },
    ];

    // Alice signs against the ring of 2 known at block 20.
    const earlyRing = computeRingAt(remarks, {
      proposalId: PROPOSAL,
      atBlock: 20,
    });
    expect(earlyRing).toHaveLength(2);
    const aliceVote = realSign(
      alice.sk,
      earlyRing,
      voteMessageHex(PROPOSAL, 'yes', 20),
    );

    // Coordinator opens voting at block 21, before Alice's vote
    // lands.
    remarks.push({
      blockNumber: 21,
      signer: COORDINATOR,
      text: encodeStartRemark(PROPOSAL),
    });
    remarks.push({
      blockNumber: 22,
      signer: 'gas-alice',
      text: encodeVoteRemark({
        proposalId: PROPOSAL,
        choice: 'yes',
        ringBlock: 20,
        sig: aliceVote,
      }),
    });

    // Eve and David announce LATER. The current head ring is now
    // {alice, bob, eve, david}, but Alice's vote was committed to
    // the smaller earlier ring.
    remarks.push({
      blockNumber: 30,
      signer: '5Eve',
      text: encodeAnnounceRemark(PROPOSAL, eve.pk),
    });
    remarks.push({
      blockNumber: 40,
      signer: '5David',
      text: encodeAnnounceRemark(PROPOSAL, david.pk),
    });

    const { tally, votes } = tallyRemarks(remarks, {
      proposalId: PROPOSAL,
      coordinatorAddress: COORDINATOR,
      verify: realVerify,
    });
    // Tally verified Alice's vote against the ring at block 20
    // (size 2), not against the current head (size 4). Vote
    // accepted.
    expect(tally).toEqual({
      yes: 1,
      no: 0,
      abstain: 0,
      invalid: 0,
      totalVoted: 1,
    });
    expect(votes[0].rb).toBe(20);
  });

  it('verifies two voters with different ring snapshots', () => {
    // Alice announces, Bob announces, Alice votes (ring size 2),
    // Eve announces, Bob votes (ring size 3). Both votes should
    // verify because each is checked against its own ringBlock.
    const alice = realKeygen();
    const bob = realKeygen();
    const eve = realKeygen();

    const remarks: RemarkLike[] = [];
    remarks.push({
      blockNumber: 10,
      signer: '5Alice',
      text: encodeAnnounceRemark(PROPOSAL, alice.pk),
    });
    remarks.push({
      blockNumber: 20,
      signer: '5Bob',
      text: encodeAnnounceRemark(PROPOSAL, bob.pk),
    });

    // Coordinator opens voting at block 20.
    remarks.push({
      blockNumber: 20,
      signer: COORDINATOR,
      text: encodeStartRemark(PROPOSAL),
    });

    // Alice signs at block 20 → ring={Alice, Bob}, sorted.
    const ringAt20 = computeRingAt(remarks, { proposalId: PROPOSAL, atBlock: 20 });
    expect(ringAt20).toHaveLength(2);
    const aliceSig = realSign(
      alice.sk,
      ringAt20,
      voteMessageHex(PROPOSAL, 'yes', 20),
    );
    remarks.push({
      blockNumber: 21,
      signer: 'gas-alice',
      text: encodeVoteRemark({
        proposalId: PROPOSAL,
        choice: 'yes',
        ringBlock: 20,
        sig: aliceSig,
      }),
    });

    // Eve announces.
    remarks.push({
      blockNumber: 30,
      signer: '5Eve',
      text: encodeAnnounceRemark(PROPOSAL, eve.pk),
    });

    // Bob signs at block 30 → ring={Alice, Bob, Eve}.
    const ringAt30 = computeRingAt(remarks, { proposalId: PROPOSAL, atBlock: 30 });
    expect(ringAt30).toHaveLength(3);
    const bobSig = realSign(bob.sk, ringAt30, voteMessageHex(PROPOSAL, 'no', 30));
    remarks.push({
      blockNumber: 31,
      signer: 'gas-bob',
      text: encodeVoteRemark({
        proposalId: PROPOSAL,
        choice: 'no',
        ringBlock: 30,
        sig: bobSig,
      }),
    });

    const { tally, votes } = tallyRemarks(remarks, {
      proposalId: PROPOSAL,
      coordinatorAddress: COORDINATOR,
      verify: realVerify,
    });
    expect(tally).toEqual({
      yes: 1,
      no: 1,
      abstain: 0,
      invalid: 0,
      totalVoted: 2,
    });
    // Alice was first → smaller ring; Bob second → larger ring.
    const aliceVote = votes.find((v) => v.c === 'yes')!;
    const bobVote = votes.find((v) => v.c === 'no')!;
    expect(aliceVote.rb).toBe(20);
    expect(bobVote.rb).toBe(30);
  });

  it('a voter signing the same proposal twice produces one accepted vote', () => {
    // Alice and Bob announce. Alice signs YES against ring={A,B}.
    // Then Alice tries to sign NO against the same ring. Both
    // signatures share the same key image, so the second is
    // dropped by the tally.
    const alice = realKeygen();
    const bob = realKeygen();

    const remarks: RemarkLike[] = [
      {
        blockNumber: 10,
        signer: '5Alice',
        text: encodeAnnounceRemark(PROPOSAL, alice.pk),
      },
      {
        blockNumber: 20,
        signer: '5Bob',
        text: encodeAnnounceRemark(PROPOSAL, bob.pk),
      },
      {
        blockNumber: 25,
        signer: COORDINATOR,
        text: encodeStartRemark(PROPOSAL),
      },
    ];

    const ring = computeRingAt(remarks, { proposalId: PROPOSAL, atBlock: 20 });
    const sigYes = realSign(alice.sk, ring, voteMessageHex(PROPOSAL, 'yes', 20));
    const sigNo = realSign(alice.sk, ring, voteMessageHex(PROPOSAL, 'no', 20));
    // Same secret key → same key image regardless of message.
    expect(sigNo.key_image).toBe(sigYes.key_image);

    remarks.push({
      blockNumber: 30,
      signer: 'gas',
      text: encodeVoteRemark({
        proposalId: PROPOSAL,
        choice: 'yes',
        ringBlock: 20,
        sig: sigYes,
      }),
    });
    remarks.push({
      blockNumber: 31,
      signer: 'gas',
      text: encodeVoteRemark({
        proposalId: PROPOSAL,
        choice: 'no',
        ringBlock: 20,
        sig: sigNo,
      }),
    });

    const { tally, votes } = tallyRemarks(remarks, {
      proposalId: PROPOSAL,
      coordinatorAddress: COORDINATOR,
      verify: realVerify,
    });
    expect(tally).toEqual({
      yes: 1,
      no: 0,
      abstain: 0,
      invalid: 0,
      totalVoted: 1,
    });
    expect(votes.length).toBe(1);
    expect(votes[0].c).toBe('yes');
  });
});
