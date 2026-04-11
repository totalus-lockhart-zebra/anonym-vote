/**
 * Client for the v2 faucet `/drip` endpoint.
 *
 * The faucet is a strictly trust-minimized service: every drip request
 * is authenticated by a ring signature, so a misbehaving faucet can
 * only censor (refuse to issue) or waste its own budget. It cannot
 * learn which voter it is funding, it cannot forge requests, and it
 * cannot link drips to votes any better than any other on-chain
 * observer can (by the same ring sig + key image anyway).
 *
 * The UI treats the faucet as optional plumbing:
 *   - If the faucet is up and honest, the drip happens automatically
 *     and the voter doesn't have to think about gas.
 *   - If the faucet is down, returns a 4xx, or times out, the UI
 *     falls back to the manual path: show the gas address, wait for
 *     the voter to fund it by hand. The design docs call this out
 *     explicitly — "faucet is convenience, not a trust anchor."
 */

import { FAUCET_URL } from './config';
import type { RingSignature } from './ring-sig';

function faucetUrl(path: string): string {
  return `${FAUCET_URL.replace(/\/$/, '')}${path}`;
}

export interface FaucetInfo {
  faucetAddress: string;
  proposalId: string;
  startBlock: number;
  announceEndBlock: number;
  ringReady: boolean;
  ringSize: number;
  remainingBudgetRao: string;
}

/** Shape of a successful `/drip` response. */
export interface DripResponse {
  blockHash: string;
  gasAddress: string;
}

/**
 * Fetch faucet transparency info. Used by diagnostic UI and to check
 * whether the server's ring is frozen before we even bother signing.
 */
export async function getFaucetInfo(): Promise<FaucetInfo> {
  const res = await fetch(faucetUrl('/faucet/info'));
  if (!res.ok) {
    throw new Error(`Faucet /info error ${res.status}: ${res.statusText}`);
  }
  const body = (await res.json()) as Partial<FaucetInfo>;
  if (
    typeof body?.faucetAddress !== 'string' ||
    typeof body?.proposalId !== 'string' ||
    typeof body?.ringReady !== 'boolean' ||
    typeof body?.ringSize !== 'number'
  ) {
    throw new Error('Faucet /info returned a malformed body');
  }
  return body as FaucetInfo;
}

export interface DripError extends Error {
  status: number;
  /** Short tag for the UI to branch on without parsing the message string. */
  kind: 'network' | 'bad-request' | 'conflict' | 'ring-not-ready' | 'budget' | 'server';
}

function mkError(status: number, message: string): DripError {
  const err = new Error(message) as DripError;
  err.status = status;
  if (status === 0) err.kind = 'network';
  else if (status === 400) err.kind = 'bad-request';
  else if (status === 409) err.kind = 'conflict';
  else if (status === 503) err.kind = 'ring-not-ready';
  else if (status === 429) err.kind = 'budget';
  else err.kind = 'server';
  return err;
}

/**
 * Request a drip. The caller has already ring-signed
 * `drip:<proposalId>:<gasAddress>` — this function just marshals the
 * result into HTTP and unwraps the response.
 *
 * On failure, throws a DripError with a `kind` tag so the UI can
 * decide whether to retry, fall back to manual funding, or show a
 * terminal error.
 */
export async function requestDrip(args: {
  proposalId: string;
  gasAddress: string;
  ringBlock: number;
  ringSig: RingSignature;
}): Promise<DripResponse> {
  let res: Response;
  try {
    res = await fetch(faucetUrl('/faucet/drip'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch (e) {
    // Network unreachable / CORS / DNS — all treated as the same
    // "faucet not available right now" outcome.
    throw mkError(0, e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw mkError(res.status, text || res.statusText);
  }
  const body = (await res.json()) as Partial<DripResponse>;
  if (typeof body?.blockHash !== 'string' || typeof body?.gasAddress !== 'string') {
    throw mkError(res.status, 'Faucet returned a malformed drip response');
  }
  return body as DripResponse;
}
