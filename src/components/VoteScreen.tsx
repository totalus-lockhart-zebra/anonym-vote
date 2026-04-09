import { useState } from 'react';
import {
  encryptChoice,
  makeNullifier,
  nullifierMessage,
  buildVoteArtifact,
} from '../crypto';
import { saveVote } from '../github';
import { ACTIVE_PROPOSAL } from '../config';

const CHOICES = [
  { id: 'yes', label: 'Yes', sub: 'Support the proposal', color: '#22c55e' },
  { id: 'no', label: 'No', sub: 'Reject the proposal', color: '#ef4444' },
  {
    id: 'abstain',
    label: 'Abstain',
    sub: 'Acknowledge without preference',
    color: '#f59e0b',
  },
];

export default function VoteScreen({ wallet, alreadyVoted, onVoted }) {
  const [phase, setPhase] = useState('pick');
  const [selected, setSelected] = useState(null);
  const [errMsg, setErrMsg] = useState('');

  const proposal = ACTIVE_PROPOSAL;
  const deadline = new Date(proposal.deadline);
  const daysLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 86400000));

  function pickChoice(choice) {
    setSelected(choice);
    setPhase('confirm');
  }

  async function castVote() {
    setErrMsg('');
    try {
      setPhase('encrypting');
      const { ciphertext, round } = await encryptChoice(
        selected,
        deadline.getTime(),
      );

      setPhase('signing');
      const msg = nullifierMessage(proposal.id);
      const sig = await wallet.sign(msg);

      const nul = await makeNullifier(proposal.id, wallet.address, sig);

      setPhase('saving');
      const artifact = buildVoteArtifact({
        proposalId: proposal.id,
        address: wallet.address,
        nullifier: nul,
        ciphertext,
        round,
        signature: sig,
      });
      await saveVote(proposal.id, wallet.address, artifact);

      setPhase('done');
      onVoted?.();
    } catch (e) {
      setErrMsg(e.message);
      setPhase('error');
    }
  }

  function reset() {
    setSelected(null);
    setPhase('pick');
    setErrMsg('');
  }

  if (alreadyVoted) {
    return (
      <div className="vs-already">
        <div className="vs-already-icon">✓</div>
        <h3>Vote recorded</h3>
        <p>
          Your encrypted vote is stored on GitHub. Results will be automatically
          revealed after the deadline on{' '}
          <strong>{deadline.toLocaleDateString()}</strong>. No action needed
          from you.
        </p>
        <div className="vs-tlock-note">
          <span className="vs-tlock-icon">🔒</span>
          <span>
            Your choice is time-locked with drand — unreadable by anyone until
            the deadline round fires.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="vs-root">
      <div className="vs-proposal">
        <div className="vs-proposal-header">
          <span className="vs-pid">{proposal.id}</span>
          <span className="vs-deadline">{daysLeft}d remaining</span>
        </div>
        <h2 className="vs-ptitle">{proposal.title}</h2>
        <p
          className="vs-pdesc"
          dangerouslySetInnerHTML={{ __html: proposal.description }}
        ></p>
      </div>

      {phase === 'pick' && (
        <>
          {!wallet.address && (
            <div className="vs-warn">Connect your Polkadot wallet to vote.</div>
          )}
          {wallet.address && !wallet.isAllowed && (
            <div className="vs-warn">
              Your address is not in the approved voter list.
            </div>
          )}
          <div className="vs-choices">
            {CHOICES.map((c) => (
              <button
                key={c.id}
                className="vs-choice"
                style={{ '--accent': c.color }}
                disabled={!wallet.isAllowed}
                onClick={() => pickChoice(c.id)}
              >
                <span className="vs-choice-label">{c.label}</span>
                <span className="vs-choice-sub">{c.sub}</span>
              </button>
            ))}
          </div>
          <div className="vs-tlock-note">
            <span className="vs-tlock-icon">🔒</span>
            <span>
              Your vote will be encrypted with{' '}
              <strong>time-lock encryption</strong> (drand). No one can read it
              until the deadline — not even you. No salt to save.
            </span>
          </div>
        </>
      )}

      {phase === 'confirm' && (
        <div className="vs-review">
          <div
            className="vs-review-choice"
            style={{
              '--accent': CHOICES.find((c) => c.id === selected)?.color,
            }}
          >
            You chose: <strong>{selected?.toUpperCase()}</strong>
          </div>
          <div className="vs-tlock-explain">
            <div className="vs-tlock-explain-title">What happens next</div>
            <ol className="vs-steps">
              <li>
                Your browser fetches the drand public key for round{' '}
                <strong>
                  {Math.floor((deadline.getTime() - 1692803367000) / 3000) + 1}
                </strong>
              </li>
              <li>
                Your choice is encrypted locally — ciphertext only stored on
                GitHub
              </li>
              <li>
                You sign a nullifier with your wallet (choice is NOT in the
                message)
              </li>
              <li>
                After <strong>{deadline.toLocaleDateString()}</strong> anyone
                can open the Results tab and the app decrypts everything
                automatically
              </li>
            </ol>
          </div>
          <div className="vs-review-actions">
            <button className="vs-btn-ghost" onClick={reset}>
              Back
            </button>
            <button className="vs-btn-primary" onClick={castVote}>
              Encrypt &amp; submit
            </button>
          </div>
        </div>
      )}

      {phase === 'encrypting' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>Encrypting your vote with drand time-lock…</p>
          <small>
            Fetching drand public key and computing IBE ciphertext locally.
          </small>
        </div>
      )}

      {phase === 'signing' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>Waiting for wallet signature…</p>
          <small>
            Your choice is NOT in the message — only your identity is signed.
          </small>
        </div>
      )}

      {phase === 'saving' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>Saving encrypted vote to GitHub…</p>
        </div>
      )}

      {phase === 'done' && (
        <div className="vs-done">
          <div className="vs-done-icon">✓</div>
          <h3>Vote locked in!</h3>
          <p>
            Your encrypted choice is on GitHub. Come back after{' '}
            <strong>{deadline.toLocaleDateString()}</strong> — results will
            decrypt automatically. Nothing to save.
          </p>
          <div className="vs-tlock-note">
            <span className="vs-tlock-icon">🔒</span>
            <span>Time-locked until drand round fires at deadline.</span>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="vs-error">
          <p>{errMsg}</p>
          <button className="vs-btn-ghost" onClick={reset}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
