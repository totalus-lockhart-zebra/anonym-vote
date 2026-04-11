/**
 * Typed shim around the wasm-pack `bundler`-target output of
 * `packages/ring-sig`.
 *
 * The wasm-bindgen-generated `.d.ts` types most fields as `any`
 * because the Rust signature returns `JsValue`. We pin the JS shape
 * here to a single stable interface so the rest of the UI never has
 * to know about wasm-bindgen quirks. If the upstream Rust ABI
 * changes, this is the one file that needs to learn the new shape.
 *
 * The `RingSignature` type itself is re-exported from
 * `@anon-vote/shared` so the UI, the faucet, and the wire format
 * all agree on the same shape.
 */

import {
  keygen as wasmKeygen,
  keyImage as wasmKeyImage,
  sign_js as wasmSign,
  verify_js as wasmVerify,
} from 'ring-sig-wasm';
import type { RingSignature } from '@anon-vote/shared';

export type { RingSignature } from '@anon-vote/shared';

export interface RingSigKeypair {
  /** 32-byte Ristretto255 secret scalar, hex. KEEP PRIVATE. */
  sk: string;
  /** 32-byte compressed Ristretto255 public point, hex. Goes into the announce remark. */
  pk: string;
}

/**
 * Generate a fresh BLSAG keypair.
 *
 * The returned `sk` MUST be persisted *only* in the voter's own browser. If
 * it leaks, an attacker who controls the corresponding `pk` (which is on
 * chain) gets exactly one chance to vote in this voter's place. The key
 * image dedup means they can't double-vote on top of a legitimate vote, but
 * a leaked sk used *first* steals the slot.
 */
export function keygen(): RingSigKeypair {
  return wasmKeygen() as RingSigKeypair;
}

/**
 * Compute the deterministic key image (nullifier) for `sk`.
 *
 * Same value every time, function only of the secret. The tally drops any
 * second remark with a key image already seen.
 */
export function keyImage(skHex: string): string {
  return wasmKeyImage(skHex);
}

/**
 * Produce a BLSAG ring signature.
 *
 * `messageHex` is the hex-encoded message bytes. The caller is responsible
 * for choosing the message so signatures can't be replayed across
 * contexts — see `voteMessageHex` / `dripMessageHex` in
 * `@anon-vote/shared` for the format we use.
 */
export function sign(
  skHex: string,
  ring: string[],
  messageHex: string,
): RingSignature {
  return wasmSign(skHex, ring, messageHex) as RingSignature;
}

/**
 * Verify a BLSAG signature against a ring and message.
 *
 * Returns `false` for mathematically-invalid signatures (tampered, wrong
 * ring, wrong message). Throws on structural errors like malformed hex —
 * those are caller bugs, not "the signature is bad".
 */
export function verify(
  sig: RingSignature,
  ring: string[],
  messageHex: string,
): boolean {
  return wasmVerify(sig, ring, messageHex);
}

// The wasm-pack `--target bundler` output auto-instantiates on first
// import (via `wasm.__wbindgen_start()`), so consumers don't need an
// async `ready()` step — calling `keygen()` etc. just works after the
// module has been imported. Vite handles the `.wasm` file as a binary
// asset and inlines/bundles it as needed.
