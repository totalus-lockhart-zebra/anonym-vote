/**
 * VoteScreen — single-screen voting flow.
 *
 * One screen. Three buttons. The voter clicks a choice and the
 * browser handles the rest. Internally there are two possible
 * paths depending on whether this voter has announced before:
 *
 *   FIRST-TIME VOTER (no VK in localStorage, no announce on chain):
 *     1. Generate VK locally (instant)
 *     2. Build announce remark, sign with REAL wallet via extension
 *        (one extension popup) and publish
 *     3. Wait for the local indexer to observe the announce
 *     4. Generate gas wallet, ring-sign drip, POST /faucet/drip
 *     5. Wait for gas balance
 *     6. Ring-sign vote, publish via gas wallet
 *     7. Done
 *
 *   RETURNING VOTER (VK already in localStorage, announce already on chain):
 *     4-7 above. No extension popup. No announce step.
 *
 * The split is invisible to the voter — they see one button, one
 * progress bar, one "done" state. The extension popup happens only
 * on the first interaction with each new proposal.
 *
 * Anonymity note: each vote is ring-signed against the ring as it
 * existed at the chain head when the voter clicked. Voters who
 * click while only 2-3 others have announced get smaller anonymity
 * sets than voters who click later. The UI shows the current ring
 * size before the click so voters can decide whether to wait.
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
  votes: AcceptedVote[];
}

export default function VoteScreen({
  wallet,
  indexer,
  ring,
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

  if (!realAddress || !wallet?.isAllowed) {
    return (
      <div className="vs-warn">
        Connect a wallet from the allowlist to vote.
      </div>
    );
  }

  if (alreadyVoted && step !== 'done') {
    return (
      <div className="vs-already">
        <div className="vs-already-icon">✓</div>
        <h3>Vote already counted</h3>
        <p>
          A vote with your voting key's key image is already on chain
          and accepted by the tally. Further submissions are silently
          dropped by the nullifier check.
        </p>
      </div>
    );
  }

  return (
    <div className="vs-root">
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

      {step === 'pick' && (
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
              {ring.myAnnouncedVk
                ? `You're already registered for this proposal. Click a choice — no wallet popup needed, ring size ${ring.ring.length}.`
                : `First click will publish a one-time registration via your wallet (one extension popup). Then your vote will be ring-signed locally and published from a fresh gas address. Current ring size ${ring.ring.length}.`}
            </span>
          </div>
        </>
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
