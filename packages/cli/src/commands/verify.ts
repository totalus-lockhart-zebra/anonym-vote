/**
 * `anon-vote verify` — independent auditor tally.
 *
 * Minimum input is the RPC endpoint, the pinned genesis, and the
 * faucet URL. Proposal id, start block, allowlist, and coordinator
 * address are all pulled from `/faucet/info` so there's one source
 * of truth and the caller can't accidentally verify against a
 * different snapshot than the faucet itself uses. Each of those
 * four can still be overridden explicitly — useful for replaying
 * a historical tally or auditing against a hypothetical config.
 *
 * The command scans the chain, feeds remarks through `tallyRemarks`
 * (the same function the UI uses), prints the result, and emits a
 * deterministic hash over the outcome so two independent runs can
 * be compared with a single string compare.
 */

import { createHash } from 'node:crypto';
import {
  computeRingAt,
  tallyRemarks,
  type AcceptedVote,
  type InvalidVoteEntry,
  type Tally,
} from '@anon-vote/shared';
import { connect, scanRemarks } from '../chain';
import { getFaucetInfo } from '../faucet';
import { verifyRingSig } from '../verifier';

export interface VerifyArgs {
  ws: string;
  expectedGenesis: string;
  faucetUrl: string;
  /** Overrides for values otherwise pulled from `/faucet/info`. */
  proposal?: string;
  startBlock?: number;
  allowed?: string[];
  coordinator?: string;
  toBlock?: number;
  concurrency: number;
  json: boolean;
}

interface VerifyResult {
  proposalId: string;
  wsUrl: string;
  genesisHash: string;
  startBlock: number;
  scannedThrough: number;
  head: number;
  coordinatorAddress: string;
  allowlistSize: number;
  ring: string[];
  votingStartBlock: number | null;
  tally: Tally;
  votes: AcceptedVote[];
  invalidReasons: InvalidVoteEntry[];
  turnoutPct: number;
}

export async function runVerify(args: VerifyArgs): Promise<number> {
  process.stderr.write(`Fetching faucet info from ${args.faucetUrl}…\n`);
  const info = await getFaucetInfo(args.faucetUrl);
  if (args.proposal && args.proposal !== info.proposalId) {
    throw new Error(
      `--proposal "${args.proposal}" disagrees with faucet ("${info.proposalId}")`,
    );
  }
  const proposalId = args.proposal ?? info.proposalId;
  const startBlock = args.startBlock ?? info.startBlock;
  const allowed = args.allowed ?? info.allowedVoters;
  const coordinator = args.coordinator ?? info.coordinatorAddress;
  process.stderr.write(
    `Faucet: proposal=${info.proposalId}  startBlock=${info.startBlock}  allowed=${info.allowedVoters.length}  coordinator=${info.coordinatorAddress}\n`,
  );
  const allowedSet = new Set(allowed);

  process.stderr.write(`Connecting to ${args.ws}…\n`);
  const chain = await connect(args.ws, args.expectedGenesis);
  process.stderr.write(
    `Connected. head=${chain.head} genesis=${chain.genesisHash}\n`,
  );

  try {
    const toBlock = args.toBlock ?? chain.head;
    if (toBlock < startBlock) {
      throw new Error(
        `toBlock (${toBlock}) < startBlock (${startBlock}); nothing to scan.`,
      );
    }

    const span = toBlock - startBlock + 1;
    process.stderr.write(
      `Scanning blocks [${startBlock}..${toBlock}] (${span.toLocaleString()} blocks, head=${chain.head})…\n`,
    );
    if (span > 100_000) {
      process.stderr.write(
        `\n[warn] Span is ${span.toLocaleString()} blocks. At ~5 blocks/s per worker\n` +
          `       (${args.concurrency} workers) this will take roughly ` +
          `${Math.round(span / args.concurrency / 5 / 60)} minutes.\n` +
          `       If that's wrong, consider --to-block.\n\n`,
      );
    }
    const remarks = await scanRemarks(
      chain.api,
      startBlock,
      toBlock,
      {
        concurrency: args.concurrency,
        onProgress: (done, total, matched) => {
          if (done % 100 === 0 || done === total) {
            const pct = ((done / total) * 100).toFixed(1);
            process.stderr.write(
              `\r  scanned ${done}/${total} (${pct}%) — ${matched} matching remarks`,
            );
          }
        },
      },
    );
    process.stderr.write('\n');

    const { tally, votes, votingStartBlock, invalidReasons } = tallyRemarks(
      remarks,
      {
        proposalId,
        coordinatorAddress: coordinator,
        allowedRealAddresses: allowedSet,
        verify: verifyRingSig,
      },
    );

    // Use the same pre/post-start rule as `tallyRemarks` so the
    // header ring matches the rings each vote was verified against.
    // `votingStartBlock` here is the one tallyRemarks already
    // computed above.
    const ring = computeRingAt(remarks, {
      proposalId,
      atBlock: toBlock,
      allowedRealAddresses: allowedSet,
      votingStartBlock,
    });

    const result: VerifyResult = {
      proposalId,
      wsUrl: args.ws,
      genesisHash: chain.genesisHash,
      startBlock,
      scannedThrough: toBlock,
      head: chain.head,
      coordinatorAddress: coordinator,
      allowlistSize: allowed.length,
      ring,
      votingStartBlock,
      tally,
      votes,
      invalidReasons,
      turnoutPct:
        allowed.length === 0 ? 0 : (tally.totalVoted / allowed.length) * 100,
    };

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      printHumanReadable(result);
    }

    // Exit code: 0 clean, 1 if any invalid votes or no start remark.
    if (tally.invalid > 0) return 1;
    if (votingStartBlock === null) return 1;
    return 0;
  } finally {
    await chain.disconnect();
  }
}

function printHumanReadable(r: VerifyResult): void {
  const L = (k: string, v: string | number): string =>
    `  ${k.padEnd(22)} ${v}`;

  const out: string[] = [];
  out.push('');
  out.push('─── audit header ───────────────────────────────────────────');
  out.push(L('proposal', r.proposalId));
  out.push(L('endpoint', r.wsUrl));
  out.push(L('genesis', r.genesisHash));
  out.push(L('start block', r.startBlock));
  out.push(L('scanned through', r.scannedThrough));
  out.push(L('head', r.head));
  out.push(L('coordinator', r.coordinatorAddress));
  out.push(L('allowlist size', r.allowlistSize));
  out.push(
    L(
      'voting opened at',
      r.votingStartBlock === null
        ? '(no start remark observed)'
        : String(r.votingStartBlock),
    ),
  );

  out.push('');
  out.push(`─── canonical ring (${r.ring.length} keys, sorted) ───────`);
  for (const pk of r.ring) out.push(`  ${pk}`);

  out.push('');
  out.push(`─── accepted votes (${r.votes.length}) ──────────────────`);
  if (r.votes.length === 0) {
    out.push('  (none)');
  } else {
    for (const v of r.votes) {
      out.push(
        `  block=${v.blockNumber}  rb=${v.rb}  ${v.c.padEnd(7)}  ki=${v.sig.key_image}`,
      );
    }
  }

  if (r.invalidReasons.length > 0) {
    out.push('');
    out.push(`─── invalid votes (${r.invalidReasons.length}) ───────────────────`);
    for (const i of r.invalidReasons) {
      out.push(
        `  block=${i.blockNumber}  rb=${i.rb ?? '—'}  ${i.reason}${i.detail ? ` — ${i.detail}` : ''}`,
      );
    }
  }

  out.push('');
  out.push('─── tally ──────────────────────────────────────────────────');
  out.push(L('yes', r.tally.yes));
  out.push(L('no', r.tally.no));
  out.push(L('abstain', r.tally.abstain));
  out.push(L('invalid', r.tally.invalid));
  out.push(L('total accepted', r.tally.totalVoted));
  out.push(L('turnout', `${r.turnoutPct.toFixed(1)}%`));

  out.push('');
  out.push(L('result hash', resultHash(r)));
  out.push('');

  process.stdout.write(out.join('\n') + '\n');
}

/**
 * sha256 of a canonicalized subset of the result. Two independent
 * runs that agree on the chain state produce the same hash.
 */
function resultHash(r: VerifyResult): string {
  const canonical = {
    proposalId: r.proposalId,
    genesisHash: r.genesisHash,
    startBlock: r.startBlock,
    scannedThrough: r.scannedThrough,
    coordinatorAddress: r.coordinatorAddress,
    allowlistSize: r.allowlistSize,
    votingStartBlock: r.votingStartBlock,
    ring: r.ring,
    tally: r.tally,
    votes: r.votes
      .map((v) => ({
        block: v.blockNumber,
        rb: v.rb,
        c: v.c,
        ki: v.sig.key_image,
      }))
      .sort((a, b) =>
        a.block - b.block || (a.ki < b.ki ? -1 : a.ki > b.ki ? 1 : 0),
      ),
  };
  return (
    'sha256:' +
    createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  );
}
