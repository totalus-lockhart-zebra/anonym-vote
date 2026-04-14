/**
 * Local persistence for per-voter secrets the CLI owns. Mirrors the
 * UI's localStorage layout so keys generated in one place can be
 * reused in the other if the files are copied over.
 *
 * Files live under `--key-dir` (default `$HOME/.anon-vote`) and are
 * keyed by `(proposalId, realAddress)`:
 *
 *   <key-dir>/<proposalId>/<address>.voting-key.json   { sk, pk }
 *   <key-dir>/<proposalId>/<address>.gas-wallet.json   { mnemonic }
 *
 * Written with 0600 perms because the sk + mnemonic are full-power
 * credentials; anyone with read access can cast a vote in the voter's
 * slot (once) or drain the gas wallet.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function defaultKeyDir(): string {
  return join(homedir(), '.anon-vote');
}

function paths(keyDir: string, proposalId: string, address: string) {
  const dir = join(keyDir, proposalId);
  return {
    dir,
    vk: join(dir, `${address}.voting-key.json`),
    gas: join(dir, `${address}.gas-wallet.json`),
  };
}

export interface StoredVotingKey {
  sk: string;
  pk: string;
  createdAt: string;
}

export interface StoredGasWallet {
  mnemonic: string;
  createdAt: string;
}

export function readVotingKey(
  keyDir: string,
  proposalId: string,
  address: string,
): StoredVotingKey | null {
  const p = paths(keyDir, proposalId, address).vk;
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as StoredVotingKey;
}

export function writeVotingKey(
  keyDir: string,
  proposalId: string,
  address: string,
  vk: { sk: string; pk: string },
): string {
  const { dir, vk: p } = paths(keyDir, proposalId, address);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body: StoredVotingKey = { ...vk, createdAt: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(body, null, 2));
  chmodSync(p, 0o600);
  return p;
}

export function readGasWallet(
  keyDir: string,
  proposalId: string,
  address: string,
): StoredGasWallet | null {
  const p = paths(keyDir, proposalId, address).gas;
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as StoredGasWallet;
}

export function writeGasWallet(
  keyDir: string,
  proposalId: string,
  address: string,
  mnemonic: string,
): string {
  const { dir, gas: p } = paths(keyDir, proposalId, address);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body: StoredGasWallet = { mnemonic, createdAt: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(body, null, 2));
  chmodSync(p, 0o600);
  return p;
}
