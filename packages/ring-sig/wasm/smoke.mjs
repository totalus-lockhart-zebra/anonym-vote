// Smoke test for the WASM bindings.
//
// Mirrors the CLI integration test but exercises the JS surface end to end:
// keygen → ring assembly → sign → verify (happy path) → verify (tampered)
// → key-image determinism → cross-tool compatibility check.
//
// Run with: node smoke.mjs   (after `wasm-pack build wasm --target nodejs`).
// Exits non-zero on any failure so this can be wired into CI directly.

import {
  keygen,
  keyImage,
  sign_js as sign,
  verify_js as verify,
} from './pkg/ring_sig_wasm.js';

const HEX = (s) => Buffer.from(s, 'utf-8').toString('hex');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('  ok —', msg);
}

console.log('keygen × 3');
const alice = keygen();
const bob = keygen();
const eve = keygen();
assert(typeof alice.sk === 'string' && alice.sk.length === 64, 'sk is 64-char hex');
assert(typeof alice.pk === 'string' && alice.pk.length === 64, 'pk is 64-char hex');

const ring = [alice.pk, bob.pk, eve.pk];
const msg = HEX('vote:proposal-1:yes');

console.log('sign');
const sig = sign(alice.sk, ring, msg);
assert(typeof sig.challenge === 'string', 'sig has challenge');
assert(Array.isArray(sig.responses) && sig.responses.length === 3, 'responses count = ring size');
assert(typeof sig.key_image === 'string', 'sig has key_image');

console.log('verify (happy path)');
assert(verify(sig, ring, msg) === true, 'original sig verifies');

console.log('verify (tampered message)');
const wrongMsg = HEX('vote:proposal-1:no');
assert(verify(sig, ring, wrongMsg) === false, 'tampered message rejected');

console.log('verify (reordered ring)');
const swapped = [bob.pk, alice.pk, eve.pk];
assert(verify(sig, swapped, msg) === false, 'reordered ring rejected');

console.log('key-image determinism');
const ki1 = keyImage(alice.sk);
const ki2 = keyImage(alice.sk);
assert(ki1 === ki2, 'key image stable across calls');
assert(ki1 === sig.key_image, 'key image matches signature');

console.log('key-image differs across signers');
const ki_bob = keyImage(bob.sk);
assert(ki_bob !== ki1, 'different signer → different key image');

console.log('different message, same signer → same key image (linkability)');
const sig2 = sign(alice.sk, ring, HEX('vote:proposal-1:abstain'));
assert(sig2.key_image === sig.key_image, 'two messages from alice are linkable');

console.log('outsider cannot sign for the ring');
const outsider = keygen();
let threw = false;
try {
  sign(outsider.sk, ring, msg);
} catch (e) {
  threw = true;
}
assert(threw, 'sign with sk not in ring throws');

console.log('\nALL OK');
