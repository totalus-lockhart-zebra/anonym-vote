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
  findVotingStartBlock,
  parseAnnounceRemark,
  reconstructRing,
} from '@anon-vote/shared';
import type { IndexedRemark } from '../indexer';
import type { ProposalConfig } from '../proposal';

export interface AnnounceMeta {
  /** Block number of the earliest announce we've seen for this voter. */
  blockNumber: number;
  /** Block hash for deep-linking to a chain explorer. */
  blockHash: string;
}

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
  /**
   * Earliest announce seen per allowlisted signer, keyed by SS58.
   * Used by the Participants screen to show a "Registered at block X"
   * status + explorer deep-link per voter. Voters without an entry
   * have not been observed announcing yet (or the indexer hasn't
   * caught up to their announce).
   */
  announcedAt: Map<string, AnnounceMeta>;
}

export function useRing(
  remarks: readonly IndexedRemark[],
  config: ProposalConfig,
  realAddress: string | null,
): RingState {
  return useMemo(() => {
    const allowedSet = new Set(config.allowedVoters);

    // Voting-phase boundary. Announces at or after this block are
    // dropped by `reconstructRing`; before it, latest-wins per
    // signer. Returned `null` during the announce phase when no
    // start remark has been observed yet — in that case the full
    // latest-wins sweep across all known announces applies.
    const votingStartBlock = findVotingStartBlock([...remarks], {
      proposalId: config.id,
      coordinatorAddress: config.coordinatorAddress,
    });

    const ring = reconstructRing([...remarks], {
      proposalId: config.id,
      allowedRealAddresses: allowedSet,
      votingStartBlock,
    });

    let myAnnouncedVk: string | null = null;
    let myAnnounceBlock: number | null = null;
    // Per-signer record of the effective announce (matches
    // `reconstructRing` semantics: latest pre-start). The
    // Participants screen shows this as "Registered at block X".
    const announcedAt = new Map<string, AnnounceMeta>();

    for (const r of remarks) {
      if (!allowedSet.has(r.signer)) continue;
      const parsed = parseAnnounceRemark(r.text);
      if (!parsed || parsed.proposalId !== config.id) continue;
      if (votingStartBlock !== null && r.blockNumber >= votingStartBlock) {
        // Post-start announces are rejected by the protocol — don't
        // expose them as if they were valid registrations.
        continue;
      }

      const existing = announcedAt.get(r.signer);
      if (!existing || r.blockNumber > existing.blockNumber) {
        announcedAt.set(r.signer, {
          blockNumber: r.blockNumber,
          blockHash: r.blockHash,
        });
      }

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
      announcedVoterCount: announcedAt.size,
      announcedAt,
    };
  }, [
    remarks,
    config.id,
    config.allowedVoters,
    config.coordinatorAddress,
    realAddress,
  ]);
}
