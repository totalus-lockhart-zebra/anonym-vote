/**
 * Ring reconstruction hook.
 *
 * Walks the indexer's announce remarks and produces:
 *   - the current ring (ring "as of head") for ringBlock-aware
 *     signing in VoteScreen,
 *   - the voting public key the connected real wallet has announced
 *     on chain (if any),
 *   - the block at which that announce was published (so VoteScreen
 *     can wait for the local indexer to catch up to it before
 *     signing),
 *   - the count of distinct allowlist members that have announced
 *     (for UI display of "anonymity set so far").
 *
 * No block-window filtering — there is no end block. Every announce
 * since `startBlock` is in scope. Per-proposal isolation is achieved
 * by setting a fresh `startBlock` per proposal in proposal.ts; the
 * ring naturally rebuilds from a clean slate.
 */

import { useMemo } from 'react';
import {
  parseAnnounceRemark,
  reconstructRing,
  type RemarkLike,
} from '@anon-vote/shared';
import type { ProposalConfig } from '../proposal';

export interface RingState {
  /**
   * Canonical ring as of the latest scanned block. Used by the UI
   * to display "your vote will be in a ring of N" before the user
   * commits.
   */
  ring: string[];
  /**
   * Voting public key the connected real wallet has announced on
   * chain (the latest one, in case of multiple announces). Null if
   * the wallet has not announced yet.
   */
  myAnnouncedVk: string | null;
  /**
   * Block number at which `myAnnouncedVk` was first observed by
   * the indexer. Null if no announce.
   */
  myAnnounceBlock: number | null;
  /** Count of distinct real voters that have announced. */
  announcedVoterCount: number;
}

export function useRing(
  remarks: readonly RemarkLike[],
  config: ProposalConfig,
  realAddress: string | null,
): RingState {
  return useMemo(() => {
    const allowedSet = new Set(config.allowedVoters);

    const ring = reconstructRing([...remarks], {
      proposalId: config.id,
      allowedRealAddresses: allowedSet,
    });

    let myAnnouncedVk: string | null = null;
    let myAnnounceBlock: number | null = null;
    const voterSeen = new Set<string>();

    for (const r of remarks) {
      if (!allowedSet.has(r.signer)) continue;
      const parsed = parseAnnounceRemark(r.text);
      if (!parsed || parsed.proposalId !== config.id) continue;
      voterSeen.add(r.signer);
      if (
        realAddress &&
        r.signer === realAddress &&
        (myAnnounceBlock === null || r.blockNumber > myAnnounceBlock)
      ) {
        myAnnouncedVk = parsed.vkPub;
        myAnnounceBlock = r.blockNumber;
      }
    }

    return {
      ring,
      myAnnouncedVk,
      myAnnounceBlock,
      announcedVoterCount: voterSeen.size,
    };
  }, [remarks, config.id, config.allowedVoters, realAddress]);
}
