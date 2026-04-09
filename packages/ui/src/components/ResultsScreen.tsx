import { ACTIVE_PROPOSAL, ALLOWED_VOTERS } from '../config';
import type { Tally } from '../crypto';

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

interface Props {
  tally: Tally | null;
  loading: boolean;
  error: string | null;
  progress: { scanned: number; total: number };
  refresh: () => void;
  isPastDeadline: boolean;
}

export default function ResultsScreen({
  tally,
  loading,
  error,
  progress,
  refresh,
  isPastDeadline,
}: Props) {
  if (loading) {
    const pct =
      progress.total > 0
        ? Math.min(100, Math.round((progress.scanned / progress.total) * 100))
        : 0;
    return (
      <div className="vs-status">
        <div className="vs-spinner" />
        <p>Scanning subtensor blocks for vote remarks…</p>
        {progress.total > 0 && (
          <small>
            {progress.scanned} / {progress.total} blocks ({pct}%)
          </small>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="vs-error">
        <p>Failed to load: {error}</p>
        <button className="vs-btn-ghost" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  const t: Tally = tally ?? {
    yes: 0,
    no: 0,
    abstain: 0,
    invalid: 0,
    totalVoted: 0,
  };
  const counted = t.yes + t.no + t.abstain;
  const quorum = ACTIVE_PROPOSAL.quorum;
  const quorumMet = t.totalVoted >= quorum;

  let outcome = 'Pending';
  if (counted > 0) {
    if (!quorumMet) outcome = 'No quorum';
    else if (t.yes > t.no) outcome = 'Passed ✓';
    else if (t.no > t.yes) outcome = 'Rejected ✗';
    else outcome = 'Tied';
  }

  return (
    <div className="res-root">
      <div className="res-metrics">
        <div className="res-metric">
          <div className="res-metric-label">Voted</div>
          <div className="res-metric-value">
            {t.totalVoted}
            <span className="res-metric-denom">/{ALLOWED_VOTERS.length}</span>
          </div>
        </div>
        <div className="res-metric">
          <div className="res-metric-label">Quorum</div>
          <div
            className="res-metric-value"
            style={{ color: quorumMet ? '#22c55e' : 'inherit' }}
          >
            {quorum}
            <span className="res-metric-denom"> req.</span>
          </div>
        </div>
        <div className="res-metric">
          <div className="res-metric-label">Invalid</div>
          <div className="res-metric-value">{t.invalid}</div>
        </div>
        <div className="res-metric">
          <div className="res-metric-label">Outcome</div>
          <div className="res-metric-value" style={{ fontSize: '1rem' }}>
            {outcome}
          </div>
        </div>
      </div>

      <div className="res-card">
        <div className="res-card-title">Vote distribution</div>
        <Bar label="Yes" count={t.yes} total={counted} color="#22c55e" />
        <Bar label="No" count={t.no} total={counted} color="#ef4444" />
        <Bar
          label="Abstain"
          count={t.abstain}
          total={counted}
          color="#f59e0b"
        />
        {t.invalid > 0 && (
          <div className="res-invalid">
            {t.invalid} remark(s) failed credential verification — not counted.
          </div>
        )}
        {!isPastDeadline && (
          <div
            style={{
              fontSize: '12px',
              color: 'var(--text3)',
              marginTop: '12px',
            }}
          >
            Voting is still open. Results update as new remarks land on chain.
          </div>
        )}
      </div>

      <div className="res-privacy">
        <div className="res-privacy-title">Privacy guarantee</div>
        <p>
          Each vote is a <code>system.remark</code> extrinsic signed by a
          one-shot stealth sr25519 account generated in the voter's browser.
          Eligibility is proved by a coordinator signature over the stealth
          address — never by the voter's real wallet. On-chain data contains
          no link between real voters and their choices, and tallying does not
          require that link either.
        </p>
      </div>

      <button className="vs-btn-ghost res-refresh" onClick={refresh}>
        ↻ Refresh
      </button>
    </div>
  );
}
