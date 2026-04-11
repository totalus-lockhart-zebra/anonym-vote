/**
 * Hook that computes the live tally over the indexer snapshot.
 *
 * Pure transformation on top of `useIndexer`:
 *   1. Take the remarks from the indexer.
 *   2. Pass them through `tallyRemarks` along with the verifier and
 *      proposal config.
 *   3. tallyRemarks does per-vote ring reconstruction internally,
 *      using each vote's embedded `rb` (ring block).
 *
 * The verify function is injected at the call site so the pure
 * logic in `@anon-vote/shared` never has to import the browser-
 * specific wasm target.
 */

import { useMemo } from 'react';
import { tallyRemarks, type RemarkLike } from '@anon-vote/shared';
import { verify as ringVerify } from '../ring-sig';
import type { ProposalConfig } from '../proposal';

export function useTally(
  remarks: readonly RemarkLike[],
  config: ProposalConfig,
) {
  return useMemo(
    () =>
      tallyRemarks([...remarks], {
        proposalId: config.id,
        coordinatorAddress: config.coordinatorAddress,
        allowedRealAddresses: new Set(config.allowedVoters),
        verify: ringVerify,
      }),
    // Dependency on the array reference (immutable within an
    // indexer update) plus identity of allowedVoters/id is enough
    // for stable memoization.
    [remarks, config.id, config.coordinatorAddress, config.allowedVoters],
  );
}
