/**
 * Faucet client for the CLI — parallel to `packages/ui/src/faucet-drip.ts`.
 * Posts a ring-signed drip request and waits for the response.
 */

import type { RingSignature } from '@anon-vote/shared';

export interface DripResponse {
  blockHash: string;
  gasAddress: string;
}

export interface FaucetInfo {
  faucetAddress: string;
  proposalId: string;
  startBlock: number;
  scannedThrough: number;
  head: number;
  announcedVoterCount: number;
  allowedVoters: string[];
  coordinatorAddress: string;
  remainingBudgetRao: string;
}

function url(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

export async function getFaucetInfo(faucetUrl: string): Promise<FaucetInfo> {
  const res = await fetch(url(faucetUrl, '/faucet/info'));
  if (!res.ok) {
    throw new Error(`faucet /info ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as Partial<FaucetInfo>;
  if (
    typeof body?.proposalId !== 'string' ||
    typeof body?.startBlock !== 'number' ||
    !Array.isArray(body?.allowedVoters) ||
    typeof body?.coordinatorAddress !== 'string'
  ) {
    throw new Error(
      'faucet /info is missing proposalId / startBlock / allowedVoters / ' +
        'coordinatorAddress — is the faucet on a version that exposes them?',
    );
  }
  return body as FaucetInfo;
}

export async function requestDrip(
  faucetUrl: string,
  args: {
    proposalId: string;
    gasAddress: string;
    ringBlock: number;
    ringSig: RingSignature;
  },
): Promise<DripResponse> {
  const res = await fetch(url(faucetUrl, '/faucet/drip'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `faucet /drip ${res.status} ${res.statusText}: ${text || '(no body)'}`,
    );
  }
  const body = (await res.json()) as Partial<DripResponse>;
  if (
    typeof body?.blockHash !== 'string' ||
    typeof body?.gasAddress !== 'string'
  ) {
    throw new Error('faucet /drip returned a malformed body');
  }
  return body as DripResponse;
}
