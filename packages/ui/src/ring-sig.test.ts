/**
 * Thin test that exercises the UI-side `ring-sig.ts` shim through the
 * bundler-target wasm-pack output. The shared end-to-end tests go
 * through the nodejs-target pkg directly; this one proves the code path
 * the browser actually uses also works.
 *
 * If this test fails with a "cannot import .wasm" error, Vite needs
 * `vite-plugin-wasm` (or the `?init` import pattern) — at which point
 * this file is where you'll see it first.
 */

import { describe, it, expect } from 'vitest';
import { keygen, keyImage, sign, verify } from './ring-sig';
import { voteMessageHex } from '@anon-vote/shared';

describe('ring-sig.ts (bundler wasm path)', () => {
  it('keygen → sign → verify round-trip', () => {
    const alice = keygen();
    const bob = keygen();
    const eve = keygen();
    const ring = [alice.pk, bob.pk, eve.pk].sort();

    const msg = voteMessageHex('prop-1', 'yes', 1);
    const sig = sign(alice.sk, ring, msg);
    expect(verify(sig, ring, msg)).toBe(true);

    // Tamper: wrong message should fail.
    const wrongMsg = voteMessageHex('prop-1', 'no', 1);
    expect(verify(sig, ring, wrongMsg)).toBe(false);
  });

  it('key image is deterministic and matches the signature', () => {
    const alice = keygen();
    const bob = keygen();
    const ring = [alice.pk, bob.pk].sort();

    const img1 = keyImage(alice.sk);
    const img2 = keyImage(alice.sk);
    expect(img1).toBe(img2);

    const sig = sign(alice.sk, ring, voteMessageHex('prop-1', 'abstain', 1));
    expect(sig.key_image).toBe(img1);
  });
});
