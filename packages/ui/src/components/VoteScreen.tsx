import { useState } from 'react';
import { encodeRemark } from '../crypto';
import type { Choice } from '../crypto';
import { fundRequestMessage } from '../crypto';
import { ACTIVE_PROPOSAL } from '../config';
import { getOrCreateStealth } from '../stealth';
import type { Stealth } from '../stealth';
import { requestCredential, isDevStub } from '../faucet';
import { sendRemark, waitForBalance } from '../subtensor';

const CHOICES: { id: Choice; label: string; sub: string; color: string }[] = [
  { id: 'yes', label: 'Yes', sub: 'Support the proposal', color: '#22c55e' },
  { id: 'no', label: 'No', sub: 'Reject the proposal', color: '#ef4444' },
  {
    id: 'abstain',
    label: 'Abstain',
    sub: 'Acknowledge without preference',
    color: '#f59e0b',
  },
];

// Minimum stealth balance (planck) before we try to submit the remark.
// TAO has 9 decimals; 10_000_000 planck = 0.01 TAO — enough headroom for a
// single system.remark fee on Finney.
const MIN_STEALTH_BALANCE = 10_000_000n;

function shortAddr(addr?: string | null) {
  if (!addr) return '';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

type Phase =
  | 'pick'
  | 'review'
  | 'signing'
  | 'funding'
  | 'submitting'
  | 'done'
  | 'error';

export default function VoteScreen({ wallet, alreadyVoted, onVoted }) {
  const [phase, setPhase] = useState<Phase>('pick');
  const [selected, setSelected] = useState<Choice | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const [stealth, setStealth] = useState<Stealth | null>(null);
  const [blockHash, setBlockHash] = useState<string | null>(null);

  const proposal = ACTIVE_PROPOSAL;
  const deadline = new Date(proposal.deadline);
  const daysLeft = Math.max(
    0,
    Math.ceil((deadline.getTime() - Date.now()) / 86400000),
  );

  function reset() {
    setSelected(null);
    setStealth(null);
    setBlockHash(null);
    setPhase('pick');
    setErrMsg('');
  }

  function pick(choice: Choice) {
    setSelected(choice);
    setPhase('review');
  }

  async function castVote() {
    if (!selected) return;
    setErrMsg('');
    setPhase('signing');
    try {
      // 1. Generate (or reuse) the session stealth wallet for this voter.
      const st = await getOrCreateStealth(wallet.address);
      setStealth(st);

      // 2. Real wallet signs the fund-request message. Does NOT reveal choice.
      const msg = fundRequestMessage(proposal.id, st.address);
      const realSig = await wallet.sign(msg);

      // 3. Ask the faucet for a credential (and for funding, in real mode).
      const cred = await requestCredential({
        proposalId: proposal.id,
        stealthAddress: st.address,
        realAddress: wallet.address,
        realSignature: realSig,
      });

      // 4. Wait for the stealth address to become fundable.
      setPhase('funding');
      await waitForBalance(st.address, MIN_STEALTH_BALANCE);

      // 5. Build and submit the remark. Chain now only sees the stealth.
      setPhase('submitting');
      const payload = encodeRemark({
        proposalId: proposal.id,
        stealthAddress: st.address,
        nullifier: cred.nullifier,
        choice: selected,
        credSig: cred.credSig,
      });
      const { blockHash: bh } = await sendRemark(st.pair, payload);
      setBlockHash(bh);

      setPhase('done');
      onVoted?.();
    } catch (e: any) {
      setErrMsg(e?.message ?? String(e));
      setPhase('error');
    }
  }

  if (alreadyVoted && phase !== 'done') {
    return (
      <div className="vs-already">
        <div className="vs-already-icon">✓</div>
        <h3>Vote already on chain</h3>
        <p>
          A vote from this browser's stealth wallet is already accepted into
          the subtensor chain for proposal <strong>{proposal.id}</strong>.
          Further attempts are dropped by the on-chain nullifier check.
        </p>
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
                style={{ '--accent': c.color } as React.CSSProperties}
                disabled={!wallet.isAllowed}
                onClick={() => pick(c.id)}
              >
                <span className="vs-choice-label">{c.label}</span>
                <span className="vs-choice-sub">{c.sub}</span>
              </button>
            ))}
          </div>
          <div className="vs-tlock-note">
            <span className="vs-tlock-icon">🕶</span>
            <span>
              Your vote is published by a fresh stealth sr25519 wallet
              generated in this browser. On-chain data never links back to
              your real address.
            </span>
          </div>
        </>
      )}

      {phase === 'review' && selected && (
        <div className="vs-review">
          <div
            className="vs-review-choice"
            style={
              {
                '--accent': CHOICES.find((c) => c.id === selected)?.color,
              } as React.CSSProperties
            }
          >
            You chose: <strong>{selected.toUpperCase()}</strong>
          </div>
          <div className="vs-tlock-explain">
            <div className="vs-tlock-explain-title">What happens next</div>
            <ol className="vs-steps">
              <li>A fresh stealth sr25519 wallet is generated in your browser.</li>
              <li>Your real wallet signs a fund request — without your choice in it.</li>
              <li>
                The faucet funds the stealth address and returns a
                coordinator-signed credential.
              </li>
              <li>
                The stealth wallet publishes a <code>system.remark</code> with
                your choice + credential.
              </li>
              <li>On-chain there is no link back to your real address.</li>
            </ol>
            {isDevStub() && (
              <div className="vs-warn" style={{ marginTop: '1rem' }}>
                Dev stub mode: the local faucet does NOT fund the stealth
                address. You must manually transfer a small amount of TAO to
                it before the remark can go through.
              </div>
            )}
          </div>
          <div className="vs-review-actions">
            <button className="vs-btn-ghost" onClick={reset}>
              Back
            </button>
            <button className="vs-btn-primary" onClick={castVote}>
              Sign &amp; submit
            </button>
          </div>
        </div>
      )}

      {phase === 'signing' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>Waiting for wallet signature…</p>
          <small>
            Your choice is NOT in the signed message — only the stealth address
            is.
          </small>
        </div>
      )}

      {phase === 'funding' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>Waiting for the faucet to fund your stealth address…</p>
          {stealth && (
            <small>
              Stealth: <code>{shortAddr(stealth.address)}</code>
            </small>
          )}
          {isDevStub() && stealth && (
            <div className="vs-warn" style={{ marginTop: '1rem' }}>
              Dev stub mode: send a tiny bit of TAO to{' '}
              <code style={{ wordBreak: 'break-all' }}>{stealth.address}</code>{' '}
              manually to continue.
            </div>
          )}
        </div>
      )}

      {phase === 'submitting' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>Publishing remark on subtensor…</p>
        </div>
      )}

      {phase === 'done' && (
        <div className="vs-done">
          <div className="vs-done-icon">✓</div>
          <h3>Vote submitted</h3>
          <p>
            The remark is in the block. On-chain it is signed by your stealth
            address, which nobody can link back to your real wallet.
          </p>
          {blockHash && (
            <div className="vs-tlock-note" style={{ wordBreak: 'break-all' }}>
              <span className="vs-tlock-icon">⛓</span>
              <span>
                Included in block <code>{blockHash}</code>
              </span>
            </div>
          )}
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
