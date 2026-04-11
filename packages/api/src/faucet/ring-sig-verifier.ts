/**
 * Thin wrapper around the nodejs-target wasm-pack output of
 * `packages/ring-sig`. Used by the faucet to verify drip requests.
 *
 * Why a separate module: the wasm-pack output is CJS, uses
 * `require('util')`, and has a `.d.ts` that types everything as
 * `any`. Keeping the import behind a one-function surface means the
 * NestJS service doesn't have to deal with any of that — it just
 * calls `verifyRingSig(sig, ring, msgHex) → boolean`.
 *
 * The import path reaches across the workspace into the ring-sig
 * package. That's fine for a monorepo: the path is stable because
 * both packages live in the same repo, and the file is gitignored so
 * `wasm-pack build` is a build prerequisite for the api. Running
 * `npm run build` in packages/ring-sig-wasm regenerates pkg/ (nodejs
 * target) from the Rust source.
 */

import type { RingSignature } from './drip-request.dto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wasm = require('../../../ring-sig/wasm/pkg/ring_sig_wasm.js') as {
  verify_js: (
    sig: unknown,
    ring: string[],
    messageHex: string,
  ) => boolean;
};

export function verifyRingSig(
  sig: RingSignature,
  ring: readonly string[],
  messageHex: string,
): boolean {
  try {
    return wasm.verify_js(sig, [...ring], messageHex);
  } catch (err) {
    // Structural errors (malformed hex, wrong length, invalid ring
    // points) throw out of the WASM boundary. For drip verification
    // this is a "don't trust this request" signal — we treat it the
    // same as a mathematically-invalid signature.
    return false;
  }
}
