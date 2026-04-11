/**
 * CoordinatorScreen — private control panel for the coordinator.
 *
 * The coordinator's only protocol power is publishing a single
 * `system.remark("anon-vote-v2:start:<proposalId>")` from the
 * configured wallet to flip the proposal from the announce phase
 * into the voting phase. This screen wraps that action.
 *
 * Visibility logic:
 *   - Voting already opened          → "✓ already opened" view
 *   - Wallet not connected           → "connect to act as coordinator"
 *   - Wallet connected, not coord    → "switch to coordinator wallet"
 *   - Wallet connected, IS coord     → big "Publish start remark" button
 *
 * Anyone can OPEN this tab, but only the configured coordinator
 * wallet can do anything from it. That's by design — voters get
 * to see who their coordinator is and the current state of the
 * start signal even if they're not the coordinator themselves.
 */

import { useState } from 'react';
import { encodeStartRemark } from '@anon-vote/shared';
import { PROPOSAL } from '../proposal';
import { getApi } from '../subtensor';
import type { VotingPhase } from '../hooks/useVotingPhase';

type Step = 'idle' | 'signing' | 'in-block' | 'error';

export interface CoordinatorScreenProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any;
  phase: VotingPhase;
}

export default function CoordinatorScreen({
  wallet,
  phase,
}: CoordinatorScreenProps) {
  const [step, setStep] = useState<Step>('idle');
  const [errMsg, setErrMsg] = useState('');
  const [publishedBlock, setPublishedBlock] = useState<number | null>(null);

  const realAddress: string | null = wallet?.address ?? null;
  const coordAddr = PROPOSAL.coordinatorAddress;
  const isCoordinator =
    coordAddr.length > 0 && realAddress === coordAddr;

  async function publishStart(): Promise<void> {
    if (!realAddress || !isCoordinator) return;
    setErrMsg('');
    try {
      setStep('signing');
      const { web3FromAddress } = await import('@polkadot/extension-dapp');
      const injector = await web3FromAddress(realAddress);
      if (!injector?.signer) {
        throw new Error('Wallet extension did not provide a signer.');
      }
      const api = await getApi();
      const text = encodeStartRemark(PROPOSAL.id);

      const blockNumber = await new Promise<number>((resolve, reject) => {
        let unsub: (() => void) | null = null;
        api.tx.system
          .remark(text)
          .signAndSend(realAddress, { signer: injector.signer }, (result) => {
            const { status, dispatchError } = result;
            if (dispatchError) {
              unsub?.();
              reject(new Error(dispatchError.toString()));
              return;
            }
            if (status.isInBlock) {
              unsub?.();
              void api.rpc.chain
                .getHeader(status.asInBlock)
                .then((header) => resolve(header.number.toNumber()))
                .catch(() => resolve(0));
            }
          })
          .then((u) => {
            unsub = u as unknown as () => void;
          })
          .catch(reject);
      });

      setPublishedBlock(blockNumber);
      setStep('in-block');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  }

  // ---------- render ----------

  // Voting is already open — nothing more to do.
  if (phase.startBlock !== null) {
    return (
      <div className="vs-root">
        <div className="vs-proposal">
          <div className="vs-proposal-header">
            <span className="vs-pid">{PROPOSAL.id}</span>
            <span className="vs-deadline">coordinator</span>
          </div>
          <h2 className="vs-ptitle">Voting is already open</h2>
          <p className="vs-pdesc">
            The coordinator's start remark landed in block{' '}
            <code>{phase.startBlock}</code>. There is nothing more for the
            coordinator to do — voters can now publish ring-signed votes
            from any browser tab pointed at this UI.
          </p>
        </div>
        <div className="vs-done">
          <div className="vs-done-icon">✓</div>
          <h3>Start signal published</h3>
          <p>
            Block <code>{phase.startBlock}</code>
          </p>
        </div>
      </div>
    );
  }

  // Misconfiguration — empty coordinator address.
  if (coordAddr.length === 0) {
    return (
      <div className="vs-root">
        <div className="vs-warn">
          <strong>Coordinator address is not configured.</strong>
          <p>
            Set <code>coordinatorAddress</code> in{' '}
            <code>packages/ui/src/proposal.ts</code> to the SS58 of the
            wallet that should publish the start remark, then rebuild the
            UI.
          </p>
        </div>
      </div>
    );
  }

  // Wallet not connected.
  if (!realAddress) {
    return (
      <div className="vs-root">
        <PrivateBanner />
        <div className="vs-proposal">
          <div className="vs-proposal-header">
            <span className="vs-pid">{PROPOSAL.id}</span>
            <span className="vs-deadline">coordinator</span>
          </div>
          <h2 className="vs-ptitle">Coordinator action required</h2>
          <p className="vs-pdesc">
            Voting is currently in the <strong>announce</strong> phase.
            The coordinator can open voting by publishing a start remark
            from their wallet. Connect the coordinator wallet to access
            this action.
          </p>
        </div>
        <div className="vs-tlock-note">
          <span className="vs-tlock-icon">🔑</span>
          <span>
            Coordinator address:{' '}
            <code style={{ wordBreak: 'break-all' }}>{coordAddr}</code>
          </span>
        </div>
      </div>
    );
  }

  // Wrong wallet — connected but not the coordinator.
  if (!isCoordinator) {
    return (
      <div className="vs-root">
        <PrivateBanner />
        <div className="vs-proposal">
          <div className="vs-proposal-header">
            <span className="vs-pid">{PROPOSAL.id}</span>
            <span className="vs-deadline">coordinator</span>
          </div>
          <h2 className="vs-ptitle">Not the coordinator wallet</h2>
          <p className="vs-pdesc">
            You're connected as a regular voter. Only the coordinator can
            publish the start remark.
          </p>
        </div>
        <div className="vs-tlock-note">
          <span className="vs-tlock-icon">🔑</span>
          <span>
            Coordinator is{' '}
            <code style={{ wordBreak: 'break-all' }}>{coordAddr}</code>.
            Switch to that wallet in your Polkadot extension to publish
            the start signal.
          </span>
        </div>
      </div>
    );
  }

  // Connected as coordinator. Show the action.
  return (
    <div className="vs-root">
      <PrivateBanner />
      <div className="vs-proposal">
        <div className="vs-proposal-header">
          <span className="vs-pid">{PROPOSAL.id}</span>
          <span className="vs-deadline">coordinator</span>
        </div>
        <h2 className="vs-ptitle">Open voting</h2>
        <p className="vs-pdesc">
          Click below to publish a <code>system.remark</code> from your
          wallet that flips the proposal from announce phase to voting
          phase. After this remark lands in a block, every voter who has
          registered will be able to cast their vote with one click.
        </p>
      </div>

      <div className="vs-tlock-explain">
        <div className="vs-tlock-explain-title">What this does</div>
        <ol className="vs-steps">
          <li>
            Builds the text{' '}
            <code>anon-vote-v2:start:{PROPOSAL.id}</code>.
          </li>
          <li>
            Asks your wallet to sign a <code>system.remark</code>{' '}
            extrinsic carrying that text. (One extension popup.)
          </li>
          <li>
            Submits the extrinsic to chain. As soon as it lands in a
            block, every voter's UI will pick it up via the head
            subscription and switch to the voting phase automatically.
          </li>
        </ol>
      </div>

      {step === 'idle' && (
        <div className="vs-review-actions">
          <button className="vs-btn-primary" onClick={publishStart}>
            Publish start remark
          </button>
        </div>
      )}

      {step === 'signing' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>Approve the start remark in your wallet extension…</p>
          <small>
            You'll be signing{' '}
            <code>system.remark("anon-vote-v2:start:{PROPOSAL.id}")</code>
            .
          </small>
        </div>
      )}

      {step === 'in-block' && publishedBlock !== null && (
        <div className="vs-done">
          <div className="vs-done-icon">✓</div>
          <h3>Voting is now open</h3>
          <p>
            Start remark landed in block <code>{publishedBlock}</code>.
            Voters who have registered can now cast their votes; the UI
            in their browsers will switch to the voting phase on the
            next chain head tick (a few seconds).
          </p>
        </div>
      )}

      {step === 'error' && (
        <div className="vs-error">
          <p>{errMsg}</p>
          <button
            className="vs-btn-ghost"
            onClick={() => {
              setErrMsg('');
              setStep('idle');
            }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/** Small banner that marks the screen as private/coordinator-only. */
function PrivateBanner() {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        marginBottom: 16,
        borderRadius: 999,
        background: 'rgba(245, 158, 11, 0.12)',
        border: '1px solid rgba(245, 158, 11, 0.35)',
        color: '#f59e0b',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      🔒 Private — coordinator only
    </div>
  );
}
