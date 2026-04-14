/**
 * ResultsScreen — live ring-signature tally.
 *
 * No /faucet/votes endpoint, no deadline, no quorum. Everything
 * comes from the in-browser indexer and is tallied locally via
 * `tallyRemarks` with WASM verification. Each accepted-vote row
 * shows the block hash, the extrinsic signer (a throwaway gas
 * address, not the voter's real account), and the key image — the
 * only stable per-voter identifier observers can see. Key images
 * prove "same voter wrote these two remarks" but cannot be inverted
 * to find the real voter.
 */

import type { ProposalConfig } from '../proposal';
import type { IndexerSnapshot } from '../hooks/useIndexer';
import type { RingState } from '../hooks/useRing';
import type { AcceptedVote, InvalidVoteEntry, Tally } from '@anon-vote/shared';
import { SUBTENSOR_WS } from '../config';

function explorerLink(blockHash: string): string {
  return `https://polkadot.js.org/apps/?rpc=${SUBTENSOR_WS}#/explorer/query/${blockHash}`;
}

function shortHash(h: string): string {
  if (!h) return '';
  return h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

function Bar({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="res-bar-row">
      <span className="res-bar-label">{label}</span>
      <div className="res-bar-track">
        <div
          className="res-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="res-bar-count">{count}</span>
      <span className="res-bar-pct">{pct}%</span>
    </div>
  );
}

export interface ResultsScreenProps {
  indexer: IndexerSnapshot;
  ring: RingState;
  tally: Tally;
  votes: AcceptedVote[];
  invalidReasons: InvalidVoteEntry[];
  config: ProposalConfig;
}

export default function ResultsScreen({
  indexer,
  ring,
  tally,
  votes,
  invalidReasons,
  config,
}: ResultsScreenProps) {
  const counted = tally.yes + tally.no + tally.abstain;

  // Map key image → block hash so the remark list can deep-link to
  // each accepted vote. We only keep the first occurrence per key
  // image, matching the tally's "first wins" behavior.
  const indexedByKeyImage = new Map<string, number>();
  for (const v of votes) {
    if (!indexedByKeyImage.has(v.sig.key_image)) {
      indexedByKeyImage.set(v.sig.key_image, v.blockNumber);
    }
  }
  const blockHashByNumber = new Map<number, string>();
  for (const r of indexer.remarks) {
    blockHashByNumber.set(r.blockNumber, r.blockHash);
  }

  // Outcome rule: abstain votes count toward YES for the passed /
  // failed decision. The `tally.abstain` bucket still holds the raw
  // count so the distribution chart below shows the real split, but
  // the status metric uses yes + abstain.
  const effectiveYes = tally.yes + tally.abstain;
  let outcome: string;
  if (counted === 0) {
    outcome = 'Pending';
  } else if (effectiveYes > tally.no) {
    outcome = 'Passing ✓';
  } else if (tally.no > effectiveYes) {
    outcome = 'Failing ✗';
  } else {
    outcome = 'Tied';
  }

  return (
    <div className="res-root">
      <div className="res-metrics">
        <div className="res-metric">
          <div className="res-metric-label">Voted</div>
          <div className="res-metric-value">
            {tally.totalVoted}
            <span className="res-metric-denom">
              /{config.allowedVoters.length}
            </span>
          </div>
        </div>
        <div className="res-metric">
          <div className="res-metric-label">Registered</div>
          <div className="res-metric-value">
            {ring.ring.length}
            <span className="res-metric-denom">
              /{config.allowedVoters.length}
            </span>
          </div>
        </div>
        <div className="res-metric">
          <div className="res-metric-label">Invalid</div>
          <div className="res-metric-value">{tally.invalid}</div>
        </div>
        <div className="res-metric">
          <div className="res-metric-label">Status</div>
          <div className="res-metric-value" style={{ fontSize: '1rem' }}>
            {outcome}
          </div>
        </div>
      </div>

      <div className="res-card">
        <div className="res-card-title">Vote distribution</div>
        <Bar label="Yes" count={tally.yes} total={counted} color="#22c55e" />
        <Bar label="No" count={tally.no} total={counted} color="#ef4444" />
        <Bar
          label="Abstain"
          count={tally.abstain}
          total={counted}
          color="#f59e0b"
        />
        {tally.invalid > 0 && (
          <div className="res-invalid">
            <strong>
              {tally.invalid} remark{tally.invalid === 1 ? '' : 's'} not
              counted.
            </strong>
            <ul
              style={{
                margin: '8px 0 0 0',
                padding: '0 0 0 18px',
                fontSize: '12px',
                lineHeight: '1.6',
              }}
            >
              {invalidReasons.map((entry, i) => (
                <li key={i}>
                  block <code>{entry.blockNumber}</code>
                  {entry.rb !== null && (
                    <>
                      {' '}
                      (rb=<code>{entry.rb}</code>)
                    </>
                  )}{' '}
                  — <code>{entry.reason}</code>
                  {entry.detail && <>: {entry.detail}</>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div
          style={{
            fontSize: '12px',
            color: 'var(--text3)',
            marginTop: '12px',
          }}
        >
          Voting is open-ended in v2 — late voters are explicitly supported, so
          this tally keeps updating.
        </div>
      </div>

      {votes.length > 0 && (
        <div className="res-card">
          <div className="res-card-title">Accepted votes ({votes.length})</div>
          <p className="res-blocks-hint">
            Each row is a ring-signed <code>system.remark</code>. The{' '}
            <em>key image</em> is the stable per-voter identifier used for
            dedup; different key images mean different voters, but nothing in
            the row reveals which allowlisted account that voter is.
          </p>
          <div className="res-blocks">
            {votes.map((v) => {
              const blockHash = blockHashByNumber.get(v.blockNumber) ?? '';
              return (
                <a
                  key={v.sig.key_image}
                  className="res-block-row"
                  href={blockHash ? explorerLink(blockHash) : '#'}
                  target="_blank"
                  rel="noreferrer"
                  title="Open on polkadot.js Apps"
                >
                  <span className="res-block-num">#{v.blockNumber}</span>
                  <span className="res-block-hash">
                    {blockHash ? shortHash(blockHash) : '…'}
                  </span>
                  <span
                    className="res-block-signer"
                    style={{ color: `var(--${v.c})` }}
                  >
                    {v.c}
                  </span>
                  <span className="res-block-arrow">↗</span>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
