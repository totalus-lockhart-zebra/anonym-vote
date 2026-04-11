/**
 * VoteScreen — two-phase voting UI with a Register → Vote → Done
 * timeline.
 *
 * The proposal lives in one of two phases, decided by chain state:
 *
 *   ANNOUNCE PHASE (no coordinator start remark seen yet):
 *     - Voter sees a single "Register" button.
 *     - Click → generate VK locally + publish announce extrinsic
 *       via real wallet (one extension popup) → wait for indexer.
 *     - After registration, UI shows "✓ Registered, waiting for
 *       coordinator to open voting…".
 *
 *   VOTING PHASE (coordinator start remark observed):
 *     - Voter sees Yes / No / Abstain buttons.
 *     - Click → ring-sign drip → POST faucet → wait for funds →
 *       ring-sign vote → publish via gas wallet → done.
 *     - For voters who already registered in the announce phase,
 *       this is a single click and zero extension popups. The
 *       temporal gap between their announce and vote is hours/
 *       days, breaking timing-correlation attacks.
 *
 *   LATE VOTER (didn't register in time, voting phase already open):
 *     - Voter sees the choice buttons.
 *     - Click → UI invisibly does announce-then-vote in one
 *       session (one extension popup, then automatic). They get
 *       through, but their announce and vote are temporally
 *       adjacent and an observer can correlate them. We don't
 *       warn — they accept the trade-off implicitly.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { PROPOSAL } from '../proposal';
import {
  type Choice,
  dripMessageHex,
  encodeAnnounceRemark,
  encodeVoteRemark,
  computeRingAt,
  voteMessageHex,
} from '@anon-vote/shared';
import { getOrCreateVotingKey, peekVotingKey } from '../voting-key';
import { getOrCreateGasWallet, clearGasWallet, type GasWallet } from '../gas-wallet';
import { getApi, sendRemark, waitForBalance } from '../subtensor';
import { keyImage as wasmKeyImage, sign as ringSign } from '../ring-sig';
import { requestDrip, type DripError } from '../faucet-drip';
import type { IndexerSnapshot } from '../hooks/useIndexer';
import type { RingState } from '../hooks/useRing';
import type { VotingPhase } from '../hooks/useVotingPhase';
import type { AcceptedVote } from '@anon-vote/shared';

const MIN_GAS_BALANCE_RAO = 100_000n;

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

type Step =
  | 'pick'
  | 'announcing'
  | 'waiting-for-announce'
  | 'registered'
  | 'requesting-drip'
  | 'gas-fund'
  | 'signing'
  | 'submitting'
  | 'done'
  | 'error';

function shortAddr(addr?: string | null): string {
  if (!addr) return '';
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export interface VoteScreenProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any;
  indexer: IndexerSnapshot;
  ring: RingState;
  phase: VotingPhase;
  votes: AcceptedVote[];
}

export default function VoteScreen({
  wallet,
  indexer,
  ring,
  phase,
  votes,
}: VoteScreenProps) {
  const [step, setStep] = useState<Step>('pick');
  const [selected, setSelected] = useState<Choice | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const [gas, setGas] = useState<GasWallet | null>(null);
  const [blockHash, setBlockHash] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>('');

  // The cast() async pipeline lives across many React re-renders.
  // It captures `indexer` in its closure on the first call, which
  // means it never sees subsequent indexer updates from the parent —
  // and the wait-for-announce step would hang forever even after
  // the indexer caught up. We mirror the latest snapshot into a ref
  // so async closures can read the current head/scannedThrough/
  // remarks instead of the stale snapshot from click-time.
  const indexerRef = useRef(indexer);
  useEffect(() => {
    indexerRef.current = indexer;
  }, [indexer]);

  const realAddress: string | null = wallet?.address ?? null;

  // Did this voter already cast a counted vote? Detect by computing
  // the key image of the local VK secret (if any) and matching it
  // against accepted votes. If we have no local VK, we can't have
  // voted from this device — fall back to ring.myAnnouncedVk only.
  const alreadyVoted = useMemo(() => {
    if (!realAddress) return false;
    const vk = peekVotingKey(PROPOSAL.id, realAddress);
    if (!vk) return false;
    let myKi: string;
    try {
      myKi = wasmKeyImage(vk.sk);
    } catch {
      return false;
    }
    return votes.some((v) => v.sig.key_image === myKi);
  }, [realAddress, votes]);

  function reset(): void {
    setSelected(null);
    setStep('pick');
    setErrMsg('');
    setBlockHash(null);
    setStatusMsg('');
  }

  /**
   * Announce-only path. Used during the announce phase: the voter
   * publishes their VK on chain via the real wallet, then waits
   * (potentially hours/days) for the coordinator to open voting.
   * No drip, no vote — just step A of the lazy flow.
   *
   * Per-phase isolation: VK + announce live in localStorage and
   * survive tab close, so the voter can register on Friday and
   * come back on Saturday once the coordinator opens voting.
   */
  async function register(): Promise<void> {
    if (!realAddress) return;
    setErrMsg('');
    setStatusMsg('');
    try {
      setStep('announcing');
      setStatusMsg('Generating voting key locally…');
      const vk = getOrCreateVotingKey(PROPOSAL.id, realAddress);

      setStatusMsg('Approve announce in your wallet extension…');
      const announceText = encodeAnnounceRemark(PROPOSAL.id, vk.pk);
      const announceBlock = await publishAnnounceFromRealWallet(
        realAddress,
        announceText,
      );

      setStep('waiting-for-announce');
      setStatusMsg(`Waiting for indexer to observe announce (block ${announceBlock})…`);
      await waitUntil(() => {
        const snap = indexerRef.current;
        return snap.scannedThrough >= announceBlock;
      }, 120_000);

      setStep('registered');
      setStatusMsg('');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  }

  /**
   * The whole cast pipeline. One method, several phases — easier
   * to read than splitting into per-phase callbacks because the
   * whole thing is one linear "happy path → done | catch → error"
   * sequence.
   */
  async function cast(choice: Choice): Promise<void> {
    if (!realAddress) return;
    setSelected(choice);
    setErrMsg('');
    setStatusMsg('');

    try {
      // ── Step A: get a voting key, possibly announcing it ──
      let vk = peekVotingKey(PROPOSAL.id, realAddress);
      let announceBlock = ring.myAnnounceBlock;

      if (!vk || announceBlock === null) {
        // First-time path: gen VK, publish announce via real wallet,
        // wait for the local indexer to see it.
        setStep('announcing');
        setStatusMsg('Generating voting key locally…');
        vk = getOrCreateVotingKey(PROPOSAL.id, realAddress);

        setStatusMsg('Approve announce in your wallet extension…');
        const announceText = encodeAnnounceRemark(PROPOSAL.id, vk.pk);
        announceBlock = await publishAnnounceFromRealWallet(
          realAddress,
          announceText,
        );

        setStep('waiting-for-announce');
        setStatusMsg(`Waiting for indexer to observe announce (block ${announceBlock})…`);
        // We need the indexer to actually have the announce in its
        // remark list, not just to have advanced its head past it.
        // `scannedThrough` is the strictly correct guarantee — it
        // means every block in [startBlock..scannedThrough] has
        // been fully fetched and parsed. Read from the ref so we
        // see live updates as the indexer catches up.
        await waitUntil(() => {
          const snap = indexerRef.current;
          return snap.scannedThrough >= (announceBlock as number);
        }, 120_000);
      }

      // ── Step B: pick a ringBlock and reconstruct the ring ──
      // Use the latest scanned block from the LIVE indexer ref —
      // the announce we just waited for must be at or before
      // `scannedThrough`, so the ring at this block is guaranteed
      // to include our VK.
      const liveSnap = indexerRef.current;
      const ringBlock = liveSnap.scannedThrough;
      const currentRing = computeRingAt([...liveSnap.remarks], {
        proposalId: PROPOSAL.id,
        atBlock: ringBlock,
        allowedRealAddresses: new Set(PROPOSAL.allowedVoters),
      });

      if (currentRing.length < 2) {
        // BLSAG hard-rejects rings of size < 2 because a 1-element
        // ring provides zero anonymity (it trivially identifies the
        // signer). The voter's announce IS already on chain — they
        // just need at least one other allowlist member to also
        // announce, then come back here. Their VK is preserved in
        // localStorage; the next attempt will skip the announce
        // step entirely.
        throw new Error(
          `Ring has only ${currentRing.length} member${currentRing.length === 1 ? '' : 's'}. ` +
            `Your registration is already on chain — once at least one other allowlisted voter has clicked "Vote" and registered, ` +
            `come back to this page (or just click again) and the rest of the flow will go through automatically.`,
        );
      }
      if (!currentRing.includes(vk.pk)) {
        throw new Error(
          'Your voting key is not in the canonical ring at this block — the indexer may not have caught up yet, please wait a few seconds and try again.',
        );
      }

      // ── Step C: gen gas wallet, ring-sign drip, request from faucet ──
      setStep('requesting-drip');
      setStatusMsg('Generating gas wallet…');
      const g = await getOrCreateGasWallet(PROPOSAL.id, realAddress);
      setGas(g);

      setStatusMsg('Ring-signing drip request locally…');
      const dripSig = ringSign(
        vk.sk,
        currentRing,
        dripMessageHex(PROPOSAL.id, g.address, ringBlock),
      );

      setStatusMsg('Requesting drip from faucet…');
      try {
        await requestDrip({
          proposalId: PROPOSAL.id,
          gasAddress: g.address,
          ringBlock,
          ringSig: dripSig,
        });
      } catch (e) {
        const err = e as Partial<DripError>;
        if (err && err.kind === 'conflict') {
          // Same voter already got a drip — usually means a
          // previous attempt funded `g` and we just need to wait
          // for it to land. Fall through to the gas-fund poll.
          setStatusMsg('Faucet says you already have a drip — checking gas balance…');
        } else if (
          !err?.kind ||
          err.kind === 'network' ||
          err.kind === 'server' ||
          err.kind === 'ring-not-ready'
        ) {
          // Faucet down or not ready. Fall back to manual funding.
          setStatusMsg(
            `Faucet unavailable (${err?.kind ?? 'network'}). Send ${MIN_GAS_BALANCE_RAO.toString()} rao to the gas address shown below.`,
          );
        } else {
          throw e;
        }
      }

      // ── Step D: wait for gas balance ──
      setStep('gas-fund');
      await waitForBalance(g.address, MIN_GAS_BALANCE_RAO, {
        timeoutMs: 600_000,
        intervalMs: 4_000,
      });

      // ── Step E: ring-sign the actual vote, publish via gas ──
      setStep('signing');
      setStatusMsg('Ring-signing vote locally…');
      const voteSig = ringSign(
        vk.sk,
        currentRing,
        voteMessageHex(PROPOSAL.id, choice, ringBlock),
      );
      const remarkText = encodeVoteRemark({
        proposalId: PROPOSAL.id,
        choice,
        ringBlock,
        sig: voteSig,
      });

      setStep('submitting');
      setStatusMsg('Publishing vote remark…');
      const { blockHash: bh } = await sendRemark(g.pair, remarkText);
      setBlockHash(bh);
      setStep('done');

      // Gas wallet has done its job — wipe it.
      clearGasWallet(PROPOSAL.id, realAddress);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  }

  /**
   * Publish an announce remark by asking the polkadot.js extension
   * to sign it from the real wallet. Returns the block number it
   * landed in (so we can wait for the indexer to catch up).
   */
  async function publishAnnounceFromRealWallet(
    realAddress: string,
    text: string,
  ): Promise<number> {
    const { web3FromAddress } = await import('@polkadot/extension-dapp');
    const injector = await web3FromAddress(realAddress);
    if (!injector?.signer) {
      throw new Error('Wallet extension did not provide a signer.');
    }
    const api = await getApi();
    return new Promise<number>((resolve, reject) => {
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
  }

  // ---------- render ----------

  // Whether this user can take any action. Non-eligible viewers
  // (no wallet, or wrong wallet) still see the timeline + proposal
  // info, just with a warning instead of action buttons.
  const canAct = Boolean(realAddress && wallet?.isAllowed);

  // The voter is "registered" if their announce remark is on
  // chain (ring.myAnnouncedVk) AND we still have the secret half
  // in localStorage. The localStorage check matters for the case
  // where the voter cleared storage between phases — they'd see
  // their announce on chain but be unable to actually vote with
  // it, and the UI should treat that as "needs to register again".
  const localVk = realAddress ? peekVotingKey(PROPOSAL.id, realAddress) : null;
  const isRegistered =
    ring.myAnnouncedVk !== null && localVk !== null && localVk.pk === ring.myAnnouncedVk;

  // Map voter state to which dot in the timeline is active.
  // For non-eligible viewers (no wallet / wrong wallet), the
  // timeline reflects the OBJECTIVE proposal phase (announce or
  // voting), not any per-voter progression.
  const timelineState: 'register' | 'vote' | 'done' =
    step === 'done' || alreadyVoted
      ? 'done'
      : phase.phase === 'voting'
        ? 'vote'
        : 'register';

  return (
    <div className="vs-root">
      <Timeline
        state={timelineState}
        phase={phase}
        registered={ring.announcedVoterCount}
        voted={votes.length}
        totalAllowed={PROPOSAL.allowedVoters.length}
      />

      <div className="vs-proposal">
        <div className="vs-proposal-header">
          <span className="vs-pid">{PROPOSAL.id}</span>
          <span className="vs-deadline">
            ring: {ring.ring.length} of {PROPOSAL.allowedVoters.length}
          </span>
        </div>
        <h2 className="vs-ptitle">{PROPOSAL.title}</h2>
        <p
          className="vs-pdesc"
          dangerouslySetInnerHTML={{ __html: PROPOSAL.description }}
        />
      </div>

      {/* Non-eligible viewer (no wallet, or wrong wallet). Timeline
          and proposal info above are still rendered so they can see
          the proposal state — they just can't take action. */}
      {step === 'pick' && !canAct && (
        <div className="vs-warn">
          {!realAddress
            ? 'Connect your Polkadot wallet to take part in this proposal. The timeline above shows the current state.'
            : 'This wallet is not on the allowlist for this proposal. Switch to an allowlisted wallet in your Polkadot extension to register or vote.'}
        </div>
      )}

      {step === 'pick' && canAct && alreadyVoted && (
        <div className="vs-already">
          <div className="vs-already-icon">✓</div>
          <h3>Vote already counted</h3>
          <p>
            A vote with your voting key's key image is already on chain
            and accepted by the tally. Further submissions are silently
            dropped by the nullifier check.
          </p>
        </div>
      )}

      {step === 'pick' &&
        canAct &&
        !alreadyVoted &&
        phase.phase === 'announce' &&
        !isRegistered && (
          <>
            <div className="vs-review-actions" style={{ marginTop: 16 }}>
              <button className="vs-btn-primary" onClick={() => register()}>
                Register for this proposal
              </button>
            </div>
            <div className="vs-tlock-note">
              <span className="vs-tlock-icon">🕶</span>
              <span>
                Voting hasn't been opened by the coordinator yet. This step
                publishes your voting public key via your wallet so you'll be
                part of the ring when voting opens. Your vote choice is{' '}
                <strong>not</strong> in this transaction — only your VK.
              </span>
            </div>
          </>
        )}

      {step === 'pick' &&
        canAct &&
        !alreadyVoted &&
        phase.phase === 'announce' &&
        isRegistered && (
          <div className="vs-already">
            <div className="vs-already-icon">✓</div>
            <h3>Registered</h3>
            <p>
              Your voting key is on chain. {ring.announcedVoterCount} of{' '}
              {PROPOSAL.allowedVoters.length} allowlisted voters have
              registered so far. Voting opens once the coordinator publishes
              the start remark — this page will switch to choice buttons
              automatically when that happens.
            </p>
          </div>
        )}

      {step === 'pick' && canAct && !alreadyVoted && phase.phase === 'voting' && (
        <>
          <div className="vs-choices">
            {CHOICES.map((c) => (
              <button
                key={c.id}
                className="vs-choice"
                style={{ '--accent': c.color } as React.CSSProperties}
                onClick={() => cast(c.id)}
              >
                <span className="vs-choice-label">{c.label}</span>
                <span className="vs-choice-sub">{c.sub}</span>
              </button>
            ))}
          </div>
          <div className="vs-tlock-note">
            <span className="vs-tlock-icon">🕶</span>
            <span>
              {isRegistered
                ? `You're registered. Click a choice — no wallet popup needed. Ring size ${ring.ring.length} of ${PROPOSAL.allowedVoters.length}.`
                : `You haven't registered yet. Clicking a choice will publish a registration via your wallet (one extension popup), then immediately ring-sign and publish your vote.`}
            </span>
          </div>
        </>
      )}

      {step === 'registered' && (
        <div className="vs-already">
          <div className="vs-already-icon">✓</div>
          <h3>Registered</h3>
          <p>
            Your voting key is now on chain. Voting opens once the
            coordinator publishes the start remark.
          </p>
        </div>
      )}

      {step === 'announcing' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>{statusMsg || 'Publishing announce…'}</p>
          <small>
            Your real wallet is signing a one-time registration for this
            proposal. The signature contains only your voting public key,
            not your choice.
          </small>
        </div>
      )}

      {step === 'waiting-for-announce' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>{statusMsg}</p>
          <small>
            Indexer head: {indexer.head ?? '?'} · scanned through{' '}
            {indexer.scannedThrough}
          </small>
        </div>
      )}

      {step === 'requesting-drip' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>{statusMsg || 'Preparing drip request…'}</p>
        </div>
      )}

      {step === 'gas-fund' && gas && (
        <div className="vs-status">
          <p>
            Waiting for gas balance at{' '}
            <code style={{ wordBreak: 'break-all' }}>{gas.address}</code>
          </p>
          {statusMsg && <small>{statusMsg}</small>}
          <div className="vs-spinner" style={{ marginTop: 12 }} />
        </div>
      )}

      {step === 'signing' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>{statusMsg || 'Ring-signing vote…'}</p>
          <small>Your voting key never leaves this browser.</small>
        </div>
      )}

      {step === 'submitting' && (
        <div className="vs-status">
          <div className="vs-spinner" />
          <p>{statusMsg || 'Publishing remark from gas wallet…'}</p>
          {gas && (
            <small>
              Gas: <code>{shortAddr(gas.address)}</code>
            </small>
          )}
        </div>
      )}

      {step === 'done' && (
        <div className="vs-done">
          <div className="vs-done-icon">✓</div>
          <h3>Vote submitted</h3>
          <p>
            Your choice <strong>{selected?.toUpperCase()}</strong> is on
            chain. Extrinsic signer is a throwaway gas address; the ring
            signature inside proves some ring member voted, without
            revealing which.
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

      {step === 'error' && (
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

/**
 * Three-stage horizontal timeline:
 *
 *   ●━━━━━━━━━━━━●━━━━━━━━━━━━●
 *   Register  Coordinator  Voting
 *               starts     period
 *
 *         ┌─────────────────┐
 *         │ 3 / 12 registered│
 *         └─────────────────┘
 *
 * The first row is the conceptual progression of the proposal
 * (independent of any specific voter). The second row is a
 * single prominent stat — `registered` count during announce
 * phase, `voted` count during voting phase.
 *
 * Stage activations:
 *   - announce phase    : Register active, others pending
 *   - voting phase      : Register done ✓, Coordinator done ✓, Voting active
 *   - this voter voted  : all three done ✓
 */
type StageStatus = 'active' | 'done' | 'pending';

function stageMetaLabel(status: StageStatus): string {
  if (status === 'active') return 'In progress';
  if (status === 'done') return 'Completed';
  return 'Upcoming';
}

function Timeline({
  state,
  phase,
  registered,
  voted,
  totalAllowed,
}: {
  state: 'register' | 'vote' | 'done';
  phase: VotingPhase;
  registered: number;
  voted: number;
  totalAllowed: number;
}) {
  const stage = (n: number, label: string, status: StageStatus) => (
    <div className={`tl-stage tl-${status}`}>
      <div className="tl-dot">{n}</div>
      <div className="tl-label">{label}</div>
      <div className="tl-meta">{stageMetaLabel(status)}</div>
    </div>
  );

  // Stage 1 (Register) — active during announce phase, done after.
  const stage1: StageStatus = phase.phase === 'announce' ? 'active' : 'done';

  // Stage 2 (Coordinator starts) — instantaneous checkpoint, never
  // the "current" stage on its own. Pending until the start remark
  // appears, then immediately Done.
  const stage2: StageStatus = phase.phase === 'voting' ? 'done' : 'pending';

  // Stage 3 (Voting period) — active in voting phase until this
  // particular voter has voted, then done.
  const stage3: StageStatus =
    state === 'done' ? 'done' : phase.phase === 'voting' ? 'active' : 'pending';

  // The lines connecting stages mirror the destination stage's
  // status: a line going INTO a stage that has been reached
  // (done or active) is itself "done" (green).
  const line1Done = stage2 !== 'pending';
  const line2Done = stage3 !== 'pending';

  // Prominent stat under the timeline. Switches its meaning by
  // phase: registered count during announce, voted count during
  // voting.
  const stat =
    phase.phase === 'announce'
      ? { value: registered, total: totalAllowed, label: 'registered' }
      : { value: voted, total: totalAllowed, label: 'voted' };

  // Sub-stat: contextual one-liner.
  const subStat =
    phase.phase === 'voting' && phase.startBlock !== null
      ? `coordinator opened voting at block ${phase.startBlock}`
      : phase.phase === 'announce'
        ? 'waiting for coordinator to publish the start remark'
        : 'voting is open';

  return (
    <div className="tl-root">
      <div className="tl-stages">
        {stage(1, 'Register', stage1)}
        <div className={`tl-line ${line1Done ? 'tl-line-done' : ''}`} />
        {stage(2, 'Coordinator starts', stage2)}
        <div className={`tl-line ${line2Done ? 'tl-line-done' : ''}`} />
        {stage(3, 'Voting period', stage3)}
      </div>
      <div className="tl-stat">
        <strong>{stat.value}</strong>
        <span className="tl-stat-denom">
          {' '}
          / {stat.total} {stat.label}
        </span>
      </div>
      <div className="tl-substat">{subStat}</div>
    </div>
  );
}

/**
 * Wait until `predicate()` returns true, polling at a fixed
 * interval. Times out after `timeoutMs`. Used to wait for the
 * local indexer to catch up to a block we just published into.
 */
function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate()) {
      resolve();
      return;
    }
    const start = Date.now();
    const id = setInterval(() => {
      if (predicate()) {
        clearInterval(id);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(id);
        reject(new Error('Timed out waiting for chain state to advance.'));
      }
    }, 1500);
  });
}
