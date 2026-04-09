/**
 * RevealScreen — replaced by auto-decrypt in ResultsScreen.
 * This component now just explains the tlock scheme and redirects users
 * to the Results tab after the deadline.
 */
import { ACTIVE_PROPOSAL } from '../config';

export default function RevealScreen({ isPastDeadline, onNavigateResults }) {
  const deadline = new Date(ACTIVE_PROPOSAL.deadline);

  if (isPastDeadline) {
    return (
      <div className="rs-root">
        <div className="vs-done">
          <div className="vs-done-icon">🔓</div>
          <h3>Reveal is automatic</h3>
          <p>
            The deadline has passed. Open the <strong>Results</strong> tab — the
            app will automatically fetch the drand beacon and decrypt all votes.
            No salt or manual action needed.
          </p>
          {onNavigateResults && (
            <button
              className="vs-btn-primary"
              style={{ maxWidth: 260, marginTop: 8 }}
              onClick={onNavigateResults}
            >
              Go to Results →
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rs-root">
      <div className="rs-header">
        <h3>No reveal needed</h3>
        <p>
          This voting system uses <strong>time-lock encryption</strong>. Your
          vote was encrypted with a key that doesn't exist yet — it will only be
          published by the drand network at the deadline.
        </p>
      </div>

      <div className="rs-tlock-card">
        <div className="rs-tlock-row">
          <span className="rs-tlock-step">1</span>
          <div>
            <strong>When you voted</strong>
            <p>
              Your browser fetched the drand public key and encrypted your
              choice locally. The ciphertext was saved to GitHub.
            </p>
          </div>
        </div>
        <div className="rs-tlock-row">
          <span className="rs-tlock-step">2</span>
          <div>
            <strong>Until {deadline.toLocaleDateString()}</strong>
            <p>
              Nobody can decrypt anything. The decryption key doesn't exist yet
              — drand hasn't published the beacon for that round.
            </p>
          </div>
        </div>
        <div className="rs-tlock-row">
          <span className="rs-tlock-step">3</span>
          <div>
            <strong>After the deadline</strong>
            <p>
              drand publishes the beacon. The Results tab automatically fetches
              it and decrypts all votes simultaneously in every browser.
            </p>
          </div>
        </div>
      </div>

      <div className="rs-countdown">
        <div className="rs-countdown-label">Unlocks on</div>
        <div className="rs-countdown-date">{deadline.toLocaleString()}</div>
      </div>
    </div>
  );
}
