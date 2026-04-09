/**
 * Crypto layer — tlock edition
 *
 * Vote choice is encrypted with time-lock encryption (drand quicknet).
 * Nobody — including the voter — can decrypt before the deadline round fires.
 * After the deadline any browser can decrypt by fetching the drand beacon.
 */

import {
  timelockEncrypt,
  timelockDecrypt,
  mainnetClient,
  roundAt,
  roundTime,
  Buffer,
} from 'tlock-js';

export const DRAND_CHAIN = {
  genesis_time: 1692803367,
  period: 3,
};

let _client = null;
export function getDrandClient() {
  if (!_client) _client = mainnetClient();
  return _client;
}

/** Return the drand round number that fires at or just after deadlineMs. */
export function deadlineToRound(deadlineMs) {
  return roundAt(deadlineMs, DRAND_CHAIN);
}

/** Return the timestamp (ms) when a given round fires. */
export function roundToMs(round) {
  return roundTime(DRAND_CHAIN, round);
}

/**
 * Encrypt vote choice for the deadline round.
 * Returns { ciphertext: string, round: number }
 */
export async function encryptChoice(choice, deadlineMs) {
  const round = deadlineToRound(deadlineMs);
  const client = getDrandClient();
  const ct = await timelockEncrypt(round, Buffer.from(choice, 'utf8'), client);
  return { ciphertext: ct, round };
}

/**
 * Decrypt a ciphertext — only works after the deadline round has fired.
 * Fetches the drand beacon automatically.
 * @returns {Promise<"yes"|"no"|"abstain">}
 */
export async function decryptChoice(ciphertext) {
  const client = getDrandClient();
  const buf = await timelockDecrypt(ciphertext, client);
  return buf.toString('utf8');
}

/** nullifier = sha256("nullifier:" + proposalId + ":" + address + ":" + sig) */
export async function makeNullifier(proposalId, address, signature) {
  const raw = new TextEncoder().encode(
    'nullifier:' + proposalId + ':' + address + ':' + signature,
  );
  const hashBuf = await crypto.subtle.digest('SHA-256', raw);
  return (
    '0x' +
    Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Message signed by wallet — does NOT contain the vote choice. */
export function nullifierMessage(proposalId) {
  return `anon-vote:nullifier:${proposalId}`;
}

/** Build the vote JSON saved to GitHub. No plaintext choice anywhere. */
export function buildVoteArtifact({
  proposalId,
  address,
  nullifier,
  ciphertext,
  round,
  signature,
}) {
  return {
    version: 2,
    scheme: 'tlock-drand-quicknet',
    proposalId,
    address,
    nullifier,
    ciphertext,
    drandRound: round,
    signature,
    timestamp: new Date().toISOString(),
  };
}

/** Tally decrypted results. Each item: { nullifier, choice | null } */
export function tallyDecrypted(decrypted) {
  const seen = new Set();
  const t = { yes: 0, no: 0, abstain: 0, failed: 0, total: 0 };
  for (const item of decrypted) {
    if (!item.nullifier || seen.has(item.nullifier)) continue;
    seen.add(item.nullifier);
    t.total++;
    if (item.choice === 'yes') t.yes++;
    else if (item.choice === 'no') t.no++;
    else if (item.choice === 'abstain') t.abstain++;
    else t.failed++;
  }
  return t;
}
