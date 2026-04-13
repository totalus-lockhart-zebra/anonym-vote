/**
 * Frontend configuration — endpoint URLs and chain identity.
 *
 * RPC endpoint precedence (highest wins):
 *   1. User override in localStorage (set from the RPC settings modal)
 *   2. VITE_SUBTENSOR_WS env var at build time
 *   3. Baked-in default (dev.chain.opentensor.ai)
 *
 * The expected genesis hash pins the chain identity: on every API init
 * we compare it against what the RPC reports, and refuse to use data
 * from an RPC pointing at a different chain (wrong network, stale
 * testnet, etc.) The hash is per-deployment and should be set via
 * VITE_EXPECTED_GENESIS_HASH for each environment.
 */

const STORAGE_KEY_WS = 'rpc:subtensor-ws';

export const DEFAULT_SUBTENSOR_WS =
  (import.meta.env.VITE_SUBTENSOR_WS as string | undefined) ??
  'wss://dev.chain.opentensor.ai:443';

export const EXPECTED_GENESIS_HASH = (
  (import.meta.env.VITE_EXPECTED_GENESIS_HASH as string | undefined) ??
  '0x077899043eb684c5277b6814a39161f4ce072b45e782e12c81a521c63fb4f3e5'
).toLowerCase();

export function getSubtensorWs(): string {
  try {
    const override = localStorage.getItem(STORAGE_KEY_WS);
    if (override && override.trim()) return override.trim();
  } catch {
    console.warn(
      'Falling through to default SUBTENSOR_WS: localStorage is unavailable.',
    );
  }
  return DEFAULT_SUBTENSOR_WS;
}

/** Persist a user RPC override. Pass null or empty to clear and revert to default. */
export function setSubtensorWs(url: string | null): void {
  try {
    if (!url || !url.trim()) localStorage.removeItem(STORAGE_KEY_WS);
    else localStorage.setItem(STORAGE_KEY_WS, url.trim());
  } catch {
    // noop
  }
}

/**
 * Resolved WS URL at module load. Existing consumers that import this
 * constant continue to work; changes to the override only take effect
 * after a page reload (which the settings modal triggers).
 */
export const SUBTENSOR_WS = getSubtensorWs();

export const FAUCET_URL =
  (import.meta.env.VITE_FAUCET_URL as string | undefined) ??
  'http://localhost:3000';
