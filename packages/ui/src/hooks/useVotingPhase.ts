/**
 * Two-phase voting clock.
 *
 * Reads the indexer's remark list and returns the current phase
 * plus the block number at which the coordinator opened voting (if
 * they have). The phase is `'announce'` until the coordinator's
 * `start` remark is observed, then flips to `'voting'`. Tally is
 * always available from a separate tab.
 *
 * Why two phases instead of inferring from time / block deltas:
 * the coordinator publishes their start remark when they decide
 * voting should open. There is no clock-driven boundary. This
 * keeps the protocol simple — anyone with the coordinator's
 * sr25519 key can open the window, and the chain runtime
 * guarantees the signature on the start extrinsic is real.
 */

import { useMemo } from 'react';
import {
  findVotingStartBlock,
  type RemarkLike,
} from '@anon-vote/shared';
import type { ProposalConfig } from '../proposal';

export type Phase = 'announce' | 'voting';

export interface VotingPhase {
  phase: Phase;
  /**
   * Block number at which the coordinator's start remark landed,
   * or null if it hasn't yet. Voters use this to know when their
   * vote will land in a "post-start" block (i.e., be counted).
   */
  startBlock: number | null;
}

export function useVotingPhase(
  remarks: readonly RemarkLike[],
  config: ProposalConfig,
): VotingPhase {
  return useMemo(() => {
    const startBlock = findVotingStartBlock([...remarks], {
      proposalId: config.id,
      coordinatorAddress: config.coordinatorAddress,
    });
    return {
      phase: startBlock === null ? 'announce' : 'voting',
      startBlock,
    };
  }, [remarks, config.id, config.coordinatorAddress]);
}
