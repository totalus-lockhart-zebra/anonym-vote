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
    '5CsvRJXuR955WojnGMdok1hbhffZyB4N5ocrv82f3p5A2zVp',
    '5D4gEn5S422dTGR5NJJKZ93FNV6hDmfwDPfxFNgcoVnUkZ4f',
    '5DXdHixxtCvoa6GHKs2Jgrdzc61882Ftx1zN2sYFQuwgL1S1',
    '5Dd8gaRNdhm1YP7G1hcB1N842ecAUQmbLjCRLqH5ycaTGrWv',
    '5FxcZraZACr4L78jWkcYe3FHdiwiAUzrKLVtsSwkvFobBKqq',
    '5Fy3MjrdKRvUWSuJa4Yd5dmBYunzKNmXnLcvP22NfaTvhQCY',
    '5G3wMP3g3d775hauwmAZioYFVZYnvw6eY46wkFy8hEWD5KP3',
    '5GKH9FPPnWSUoeeTJp19wVtd84XqFW4pyK2ijV2GsFbhTrP1',
    '5GP7c3fFazW9GXK8Up3qgu2DJBk8inu4aK9TZy3RuoSWVCMi',
    '5Gq2gs4ft5dhhjbHabvVbAhjMCV2RgKmVJKAFCUWiirbRT21',
    '5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN',
    '5HmkM6X1D3W3CuCSPuHhrbYyZNBy2aGAiZy9NczoJmtY25H7',
  ],
  startBlock: 7961726,
  coordinatorAddress: '5Ff9wuYWk2r8qKutC5NKGBqEVY2rty5JXCBTXz5Tm7ndiWwQ',
};
