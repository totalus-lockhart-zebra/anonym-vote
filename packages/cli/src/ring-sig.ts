/**
 * Typed wrapper over the node-target wasm-pack build of `packages/ring-sig`.
 * Same surface as the UI's `ring-sig.ts`, shared between every CLI command
 * so verify, announce, and vote agree on the exact same crypto path.
 *
 * Requires `npm run wasm:build` at repo root — the pkg/ directory is
 * gitignored and only produced by wasm-pack.
 */

import type { RingSigVerify, RingSignature } from '@anon-vote/shared';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wasm = require('../../ring-sig/wasm/pkg/ring_sig_wasm.js') as {
  keygen: () => { sk: string; pk: string };
  keyImage: (sk: string) => string;
  sign_js: (sk: string, ring: string[], messageHex: string) => RingSignature;
  verify_js: (sig: unknown, ring: string[], messageHex: string) => boolean;
};

export interface RingSigKeypair {
  sk: string;
  pk: string;
}

export function keygen(): RingSigKeypair {
  return wasm.keygen();
}

export function keyImage(sk: string): string {
  return wasm.keyImage(sk);
}

export function sign(
  sk: string,
  ring: readonly string[],
  messageHex: string,
): RingSignature {
  return wasm.sign_js(sk, [...ring], messageHex);
}

export const verify: RingSigVerify = (sig, ring, messageHex) => {
  try {
    return wasm.verify_js(sig, [...ring], messageHex);
  } catch {
    return false;
  }
};
