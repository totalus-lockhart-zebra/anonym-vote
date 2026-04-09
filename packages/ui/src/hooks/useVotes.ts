import { useState, useEffect, useCallback } from 'react';
import { getCurrentBlock, scanRemarks } from '../subtensor';
import { tallyRemarks } from '../crypto';
import type { AcceptedVote, Tally } from '../crypto';
import { ACTIVE_PROPOSAL } from '../config';
import { getCoordPubkey } from '../faucet';
import { peekStealth } from '../stealth';

export function useVotes(realAddress: string | null) {
  const [votes, setVotes] = useState<AcceptedVote[]>([]);
  const [tally, setTally] = useState<Tally | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ scanned: 0, total: 0 });
  const [alreadyVoted, setAlreadyVoted] = useState(false);

  const proposalId = ACTIVE_PROPOSAL.id;
  const startBlock = ACTIVE_PROPOSAL.startBlock;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const coordPubkey = await getCoordPubkey();
      const current = await getCurrentBlock();
      const endBlock = Math.max(startBlock, current);
      setProgress({ scanned: 0, total: endBlock - startBlock + 1 });

      const raw = await scanRemarks(startBlock, endBlock, {
        onProgress: setProgress,
      });
      const { tally: t, votes: v } = tallyRemarks(raw, {
        proposalId,
        coordPubkey,
      });
      setTally(t);
      setVotes(v);

      if (realAddress) {
        try {
          const stealth = await peekStealth(realAddress);
          setAlreadyVoted(
            stealth ? v.some((vote) => vote.s === stealth.address) : false,
          );
        } catch {
          setAlreadyVoted(false);
        }
      } else {
        setAlreadyVoted(false);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [proposalId, startBlock, realAddress]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deadline = new Date(ACTIVE_PROPOSAL.deadline);
  const isPastDeadline = Date.now() > deadline.getTime();

  return {
    votes,
    tally,
    loading,
    error,
    progress,
    alreadyVoted,
    isPastDeadline,
    refresh,
  };
}
