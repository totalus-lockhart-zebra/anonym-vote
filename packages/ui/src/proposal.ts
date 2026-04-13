/**
 * Hardcoded proposal configuration.
 *
 * There is no backend of record — the UI is a static site that talks
 * directly to the chain. The allowlist, the start block, and the
 * announce cutoff all live here. Editing this file and rebuilding
 * the UI is how a new proposal is launched.
 *
 * Why not runtime env vars: the whole point of this design is "no
 * server to trust." Config served at runtime would just move the
 * trust back to whoever serves it. Making the config a git-tracked
 * file keeps everything auditable and means anyone verifying the
 * tally can point at a commit hash.
 */

export interface ProposalConfig {
  /** Stable string identifier used in announce/vote remark prefixes. */
  readonly id: string;
  readonly title: string;
  /** Markdown-ish HTML allowed — rendered via dangerouslySetInnerHTML. */
  readonly description: string;
  /**
   * SS58 addresses permitted to publish `announce` remarks. The chain
   * runtime already verifies sr25519 signatures, so we only need to check
   * the signer is on this list. Allowlist membership is evaluated at
   * announce-time; after that, eligibility is carried by ring membership.
   */
  readonly allowedVoters: readonly string[];
  /**
   * First block the indexer scans. Everything earlier is ignored —
   * announces from older proposals don't bleed into this one, and
   * vote remarks from before this block are out of scope. Per-
   * proposal isolation comes from setting a fresh `startBlock`
   * for each new proposal.
   *
   * There is no end block: voting is open-ended. Late voters in
   * other timezones can vote whenever they want.
   */
  readonly startBlock: number;
  /**
   * SS58 address of the coordinator wallet. The coordinator's
   * only protocol power is to publish a `start` remark on chain
   * (signed by this address) at the moment voting should open.
   * Until that remark is observed, the UI shows the announce
   * phase and refuses to let voters cast. After it's observed,
   * the UI flips to the voting phase.
   *
   * MUST match `COORDINATOR_ADDRESS` in the faucet's .env.
   */
  readonly coordinatorAddress: string;
}

export const PROPOSAL: ProposalConfig = {
  id: 'proposal-1',
  title: 'Release to Mainnet (Week of Apr 13)',
  description: `Features to be releases: <br>
                   1. Lock cost based Liquidity Injection on New Subnet Registration. <br>
                   2. Auto Child hotkeys`,
  allowedVoters: [
    '5FTU22ZFWmzYWqCk5hJTyjq4W7VP3MTzJ1RB4NPec1h8sYCP',
    '5FU9u1fGX5x2XgR5FZpkawZ4dXy7oLbQj8SxHdtydzWtyMXm',
    '5H3DTzx9gQnqio9ixjxLtr7MyjzLrx5ZgRWDEsxgBELN4TJP',
  ],
  startBlock: 329195,
  coordinatorAddress: '5Ff9wuYWk2r8qKutC5NKGBqEVY2rty5JXCBTXz5Tm7ndiWwQ',
};
