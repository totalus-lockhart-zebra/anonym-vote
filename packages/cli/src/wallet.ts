/**
 * Load a Polkadot keypair for the CLI. Three input shapes are supported:
 *
 *   1. Raw mnemonic via --mnemonic "..." (or the MNEMONIC env var).
 *   2. Polkadot-JS keystore export (encrypted JSON) via --json-file path,
 *      with the password taken from --password or JSON_PASSWORD env var.
 *   3. Plain SDK key-export JSON (the shape written by py-substrate /
 *      subkey inspect / etc.): a top-level `secretPhrase` field is
 *      used as the mnemonic, no password needed.
 *
 * Shape is detected from the JSON body, not a separate flag.
 *
 * The loader returns a `KeyringPair` ready to sign extrinsics. It
 * always calls `cryptoWaitReady()` first so sr25519 works even on
 * cold-cached node runs.
 */

import { readFileSync } from 'node:fs';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';

export interface WalletSource {
  mnemonic?: string;
  jsonFile?: string;
  password?: string;
}

export async function loadWallet(src: WalletSource): Promise<KeyringPair> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });

  const mnemonic = src.mnemonic ?? process.env.MNEMONIC;
  if (mnemonic) {
    return keyring.addFromUri(mnemonic.trim());
  }

  if (src.jsonFile) {
    const raw = readFileSync(src.jsonFile, 'utf8');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `Can't parse ${src.jsonFile} as JSON: ${e instanceof Error ? e.message : e}`,
      );
    }

    // Plain SDK export: has a top-level `secretPhrase` field (12/24
    // word mnemonic). No password, no decryption — just use the phrase.
    if (
      typeof json === 'object' &&
      json !== null &&
      typeof (json as { secretPhrase?: unknown }).secretPhrase === 'string'
    ) {
      const phrase = (json as { secretPhrase: string }).secretPhrase.trim();
      return keyring.addFromUri(phrase);
    }

    // Polkadot-JS keystore: encrypted, needs a password.
    const pair = keyring.addFromJson(
      json as Parameters<Keyring['addFromJson']>[0],
    );
    const password = src.password ?? process.env.JSON_PASSWORD;
    if (password === undefined) {
      throw new Error(
        'Keystore JSON is encrypted. Pass --password or set JSON_PASSWORD.',
      );
    }
    try {
      pair.decodePkcs8(password);
    } catch (e) {
      throw new Error(
        `Wrong password for keystore: ${e instanceof Error ? e.message : e}`,
      );
    }
    return pair;
  }

  throw new Error('No wallet source provided. Pass --mnemonic or --json-file.');
}
