import { ACTIVE_PROPOSAL, ALLOWED_VOTERS } from '../config';

function Bar({ label, count, total, color }) {
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

function DecryptingState({ progress }) {
  return (
    <div className="res-decrypting">
      <div className="res-decrypt-header">
        <div className="vs-spinner" />
        <span>Fetching drand beacons &amp; decrypting votes…</span>
      </div>
      <div className="res-progress-track">
        <div className="res-progress-fill" style={{ width: `${progress}%` }} />
      </div>
      <div className="res-progress-label">{progress}%</div>
      <p className="res-decrypt-note">
        The app is fetching the drand randomness beacon published at the
        deadline and decrypting each ciphertext locally in your browser. No data
        is sent to any server.
      </p>
    </div>
  );
}

export default function ResultsScreen({
  tally,
  votes,
  loading,
  error,
  refresh,
  isPastDeadline,
  decrypting,
  decryptProgress,
  decryptError,
  decrypted,
  retryDecrypt,
}) {
  if (loading) {
    return (
      <div className="vs-status">
        <div className="vs-spinner" />
        <p>Loading votes from GitHub…</p>
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

  const deadline = new Date(ACTIVE_PROPOSAL.deadline);
  const quorum = ACTIVE_PROPOSAL.quorum;
  const totalVoted = votes.length;
  const quorumMet = totalVoted >= quorum;

  if (!isPastDeadline) {
    const msleft = deadline.getTime() - Date.now();
    const hours = Math.floor(msleft / 3600000);
    const mins = Math.floor((msleft % 3600000) / 60000);
    return (
      <div className="res-root">
        <div className="res-metrics">
          <div className="res-metric">
            <div className="res-metric-label">Voted</div>
            <div className="res-metric-value">
              {totalVoted}
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
            <div className="res-metric-label">Unlocks in</div>
            <div className="res-metric-value" style={{ fontSize: '1rem' }}>
              {hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}
            </div>
          </div>
          <div className="res-metric">
            <div className="res-metric-label">Outcome</div>
            <div className="res-metric-value" style={{ fontSize: '1rem' }}>
              Sealed
            </div>
          </div>
        </div>

        <div className="res-locked-card">
          <div className="res-locked-icon">🔒</div>
          <div className="res-locked-title">Results are time-locked</div>
          <p>
            All {totalVoted} encrypted votes are stored on GitHub but cannot be
            decrypted until the drand beacon for round{' '}
            <code>
              {Math.floor((deadline.getTime() - 1692803367000) / 3000) + 1}
            </code>{' '}
            is published on <strong>{deadline.toLocaleString()}</strong>.
          </p>
          <p>
            After that moment, open this tab and the app will automatically
            fetch the beacon and decrypt every vote — no action needed from
            voters.
          </p>
        </div>

        <button className="vs-btn-ghost res-refresh" onClick={refresh}>
          ↻ Refresh count
        </button>
      </div>
    );
  }

  const t = tally ?? { yes: 0, no: 0, abstain: 0, failed: 0, total: 0 };
  const counted = t.yes + t.no + t.abstain;

  let outcome = 'Pending';
  if (decrypted && counted > 0) {
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
            {totalVoted}
            <span className="res-metric-denom">/{ALLOWED_VOTERS.length}</span>
          </div>
        </div>
        <div className="res-metric">
          <div className="res-metric-label">Decrypted</div>
          <div className="res-metric-value">
            {t.total}
            <span className="res-metric-denom">/{totalVoted}</span>
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
          <div className="res-metric-label">Outcome</div>
          <div className="res-metric-value" style={{ fontSize: '1rem' }}>
            {outcome}
          </div>
        </div>
      </div>

      {decrypting && <DecryptingState progress={decryptProgress} />}

      {decryptError && !decrypting && (
        <div className="vs-error">
          <p>Decryption failed: {decryptError}</p>
          <p style={{ fontSize: '12px', opacity: 0.7 }}>
            This usually means the drand beacon for this round hasn't been
            published yet. Wait a few seconds and retry.
          </p>
          <button className="vs-btn-ghost" onClick={retryDecrypt}>
            Retry decrypt
          </button>
        </div>
      )}

      {decrypted && (
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
          {t.failed > 0 && (
            <div className="res-invalid">
              {t.failed} vote(s) failed to decrypt (beacon unavailable or
              corrupt ciphertext).
            </div>
          )}
        </div>
      )}

      {!decrypting && !decrypted && isPastDeadline && (
        <div className="res-card">
          <div className="res-card-title">Ready to decrypt</div>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--text2)',
              marginBottom: '16px',
            }}
          >
            The deadline has passed. Click below to fetch the drand beacon and
            decrypt all {totalVoted} votes in your browser.
          </p>
          <button className="vs-btn-primary" onClick={retryDecrypt}>
            Decrypt results now
          </button>
        </div>
      )}

      <div className="res-privacy">
        <div className="res-privacy-title">How time-lock encryption works</div>
        <p>
          Each vote was encrypted using{' '}
          <strong>identity-based encryption</strong> against the drand quicknet
          beacon at the deadline round. The decryption key (the beacon's BLS
          signature) only exists after drand publishes that round — making it
          mathematically impossible to decrypt early, even with access to all
          GitHub files. Decryption happens locally in your browser; no server
          sees the plaintext.
        </p>
      </div>

      <button className="vs-btn-ghost res-refresh" onClick={refresh}>
        ↻ Refresh
      </button>
    </div>
  );
}
