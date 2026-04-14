/**
 * Proposal configuration.
 *
 * Values come from Vite env vars (VITE_PROPOSAL_*) at BUILD TIME,
 * with the hardcoded defaults below acting as a fallback. Vite inlines
 * `import.meta.env.VITE_*` into the bundle during `npm run build`, so
 * an auditor can still verify the running tally by pointing at a
 * specific git SHA + the .env.* used at build time — the config is
 * static once shipped, never served at runtime.
 *
 * To launch a new proposal: either edit the defaults here and commit,
 * or set the env vars in your deploy pipeline and rebuild. See
 * .env.example for the full list.
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

function envStr(key: string, fallback: string): string {
  const v = import.meta.env[key] as string | undefined;
  return v && v.trim() ? v : fallback;
}

function envCsv(key: string, fallback: readonly string[]): readonly string[] {
  const v = import.meta.env[key] as string | undefined;
  if (!v || !v.trim()) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function envInt(key: string, fallback: number): number {
  const v = import.meta.env[key] as string | undefined;
  if (!v || !v.trim()) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${key} must be an integer, got ${JSON.stringify(v)}`);
  }
  return n;
}

export const PROPOSAL: ProposalConfig = {
  id: envStr('VITE_PROPOSAL_ID', 'proposal-1'),
  title: envStr('VITE_PROPOSAL_TITLE', 'Release to Mainnet (Week of Apr 13)'),
  description: envStr('VITE_PROPOSAL_DESCRIPTION', ''),
  allowedVoters: envCsv('VITE_PROPOSAL_ALLOWED_VOTERS', []),
  startBlock: envInt('VITE_PROPOSAL_START_BLOCK', 7962121),
  coordinatorAddress: envStr(
    'VITE_PROPOSAL_COORDINATOR',
    '5Ff9wuYWk2r8qKutC5NKGBqEVY2rty5JXCBTXz5Tm7ndiWwQ',
  ),
};
