/**
 * Faucet / coordinator client.
 *
 * POSTs to the backend faucet, which funds the stealth address and returns
 * a coordinator-signed credential. The coordinator's public key (needed for
 * on-chain verification of other voters' remarks) is fetched once from
 * `GET /faucet/coord` and cached.
 */

import { FAUCET_URL } from './config';

export interface Credential {
  proposalId: string;
  stealthAddress: string;
  nullifier: string;
  credSig: string;
}

export interface Proposal {
  id: string;
  title: string;
  description: string;
  deadline: string;
  quorum: number;
  startBlock: number;
}

function faucetUrl(path: string): string {
  if (!FAUCET_URL) {
    throw new Error(
      'FAUCET_URL is not configured. Set VITE_FAUCET_URL in packages/ui/.env',
    );
  }
  return `${FAUCET_URL.replace(/\/$/, '')}${path}`;
}

let coordPubkeyPromise: Promise<string> | null = null;

export function getCoordPubkey(): Promise<string> {
  if (!coordPubkeyPromise) {
    coordPubkeyPromise = (async () => {
      const res = await fetch(faucetUrl('/faucet/coord'));
      if (!res.ok) {
        throw new Error(`Faucet /coord error ${res.status}: ${res.statusText}`);
      }
      const body = (await res.json()) as { address?: string };
      if (!body?.address) {
        throw new Error('Faucet /coord returned no address');
      }
      return body.address;
    })().catch((err) => {
      // Reset so the next call retries instead of remembering the failure.
      coordPubkeyPromise = null;
      throw err;
    });
  }
  return coordPubkeyPromise;
}

let proposalPromise: Promise<Proposal> | null = null;

export function getProposal(): Promise<Proposal> {
  if (!proposalPromise) {
    proposalPromise = (async () => {
      const res = await fetch(faucetUrl('/faucet/proposal'));
      if (!res.ok) {
        throw new Error(
          `Faucet /proposal error ${res.status}: ${res.statusText}`,
        );
      }
      const body = (await res.json()) as Partial<Proposal>;
      if (
        !body?.id ||
        !body?.title ||
        !body?.deadline ||
        typeof body?.quorum !== 'number' ||
        typeof body?.startBlock !== 'number'
      ) {
        throw new Error('Faucet /proposal returned a malformed proposal');
      }
      return body as Proposal;
    })().catch((err) => {
      proposalPromise = null;
      throw err;
    });
  }
  return proposalPromise;
}

let votersPromise: Promise<string[]> | null = null;

export function getVoters(): Promise<string[]> {
  if (!votersPromise) {
    votersPromise = (async () => {
      const res = await fetch(faucetUrl('/faucet/voters'));
      if (!res.ok) {
        throw new Error(
          `Faucet /voters error ${res.status}: ${res.statusText}`,
        );
      }
      const body = (await res.json()) as { voters?: string[] };
      if (!Array.isArray(body?.voters)) {
        throw new Error('Faucet /voters returned no voter list');
      }
      return body.voters;
    })().catch((err) => {
      votersPromise = null;
      throw err;
    });
  }
  return votersPromise;
}

/**
 * Request a credential (and funding) for a stealth address.
 *
 * `realSignature` must be a hex string produced by the real wallet over
 * `fundRequestMessage(proposalId, stealthAddress)`. The faucet verifies
 * that it came from an allowed voter before issuing the credential.
 */
export async function requestCredential(args: {
  proposalId: string;
  stealthAddress: string;
  realAddress: string;
  realSignature: string;
}): Promise<Credential> {
  const res = await fetch(faucetUrl('/faucet/fund'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Faucet /fund error ${res.status}: ${text || res.statusText}`,
    );
  }
  const body = (await res.json()) as Credential;
  if (!body?.credSig || !body?.nullifier || !body?.stealthAddress) {
    throw new Error('Faucet returned a malformed credential.');
  }
  return body;
}
