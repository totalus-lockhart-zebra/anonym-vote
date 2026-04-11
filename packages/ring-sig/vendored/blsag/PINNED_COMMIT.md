# Vendored: opentensor/subtensor BLSAG primitive

This crate is a verbatim copy of `primitives/crypto/src/lib.rs` from the
`opentensor/subtensor` repository, pinned to commit:

    52123921e60cada845dcd2b34eee537aff596bc9

Upstream URL:
<https://github.com/opentensor/subtensor/blob/52123921e60cada845dcd2b34eee537aff596bc9/primitives/crypto/src/lib.rs>

Upstream license: The Unlicense (public domain). See
<https://github.com/opentensor/subtensor/blob/52123921e60cada845dcd2b34eee537aff596bc9/LICENSE>.

## Why vendored

At the time of writing, this crate is not merged into Substrate / `sp-io`
and is not published to crates.io. We need a stable, auditable copy that
does not move under us between builds. When the upstream is published or
becomes part of Substrate proper, this directory should be deleted and
the dependency replaced with the published crate.

## Local modifications

Two surgical changes to make the crate buildable outside the Substrate
workspace:

1. **Removed `parity-scale-codec` and `scale-info` dependencies and the
   corresponding `derive(codec::Encode, codec::Decode,
   codec::DecodeWithMemTracking, scale_info::TypeInfo)` derives on
   `BlsagSignature` and `BlsagError`.** These are Substrate-runtime-only
   traits used for SCALE encoding inside FRAME pallets. Our use is purely
   off-chain (CLI + browser WASM verifier), so SCALE codec is not needed —
   we serialize via JSON / hex on the boundary.

2. **`Cargo.toml` rewritten** to drop the workspace lints reference and
   the codec/scale-info deps, and to set `edition = "2021"` directly.

No changes to algorithm logic, hash domains, or test vectors.

## How to upgrade

1. Pick a new upstream commit.
2. `curl -sL` the new `lib.rs` and `Cargo.toml`.
3. Re-apply the two modifications above (the codec derives are easy to
   spot — search for `codec::` and `scale_info`).
4. Update the commit hash at the top of this file.
5. `cargo test -p stp-crypto` — all upstream tests must still pass.
