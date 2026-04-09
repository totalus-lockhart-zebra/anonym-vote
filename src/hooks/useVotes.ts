import { useState, useEffect, useCallback } from 'react';
import { loadVotes, hasVoted } from '../github';
import { decryptChoice, tallyDecrypted } from '../crypto';
import { ALLOWED_VOTERS, ACTIVE_PROPOSAL } from '../config';

export function useVotes(address) {
  const [votes, setVotes] = useState([]);
  const [tally, setTally] = useState(null);
  const [loading, setLoading] = useState(true);
  const [alreadyVoted, setAlreadyVoted] = useState(false);
  const [error, setError] = useState(null);

  const [decrypting, setDecrypting] = useState(false);
  const [decryptProgress, setDecryptProgress] = useState(0); // 0-100
  const [decryptError, setDecryptError] = useState(null);
  const [decrypted, setDecrypted] = useState(false); // true after successful run

  const proposalId = ACTIVE_PROPOSAL.id;
  const deadline = new Date(ACTIVE_PROPOSAL.deadline);
  const isPastDeadline = Date.now() > deadline.getTime();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const v = await loadVotes(proposalId);
      setVotes(v);

      if (address) {
        const voted = await hasVoted(proposalId, address);
        setAlreadyVoted(voted);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [proposalId, address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isPastDeadline) return;
    if (votes.length === 0) return;
    if (decrypting || decrypted) return;
    runDecrypt(votes);
  }, [isPastDeadline, votes, decrypted]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runDecrypt(voteList) {
    setDecrypting(true);
    setDecryptError(null);
    setDecryptProgress(0);

    const results = [];
    for (let i = 0; i < voteList.length; i++) {
      const vote = voteList[i];
      try {
        const choice = await decryptChoice(vote.ciphertext);
        results.push({
          nullifier: vote.nullifier,
          address: vote.address,
          choice,
        });
      } catch (e) {
        results.push({
          nullifier: vote.nullifier,
          address: vote.address,
          choice: null,
          error: e.message,
        });
      }
      setDecryptProgress(Math.round(((i + 1) / voteList.length) * 100));
    }

    setTally(tallyDecrypted(results));
    setDecrypting(false);
    setDecrypted(true);
  }

  const retryDecrypt = useCallback(() => {
    if (votes.length === 0) return;
    setDecrypted(false);
    setTally(null);
    runDecrypt(votes);
  }, [votes]); // eslint-disable-line react-hooks/exhaustive-deps

  const votedAddresses = new Set(votes.map((v) => v.address));
  const participants = ALLOWED_VOTERS.map((addr) => ({
    address: addr,
    voted: votedAddresses.has(addr),
  }));

  return {
    votes,
    tally,
    loading,
    error,
    alreadyVoted,
    participants,
    isPastDeadline,
    refresh,
    decrypting,
    decryptProgress,
    decryptError,
    decrypted,
    retryDecrypt,
  };
}
