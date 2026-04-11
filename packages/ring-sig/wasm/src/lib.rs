//! WASM bindings for the BLSAG ring-signature primitives.
//!
//! These functions are the only surface the UI talks to. The shape mirrors
//! the CLI wire format (hex strings everywhere) so debugging is symmetric:
//! a value produced in the browser can be pasted into `ring-cli verify`
//! verbatim, and vice versa.
//!
//! The hex-string boundary is intentional. Passing typed arrays through
//! wasm-bindgen works, but every consumer (UI, tests, debug logs) ends up
//! converting to hex anyway because the on-chain remarks store hex. So we
//! keep the conversion at the WASM boundary instead of pushing it into JS.
//!
//! Errors come back as `JsError`, which becomes a thrown JS `Error` with
//! a readable message. We never expose the raw `BlsagError` enum across the
//! ABI — JS callers shouldn't have to pattern-match on Rust enum variants.

use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use stp_crypto::{generate_key_image, sign, verify, BlsagSignature};
use wasm_bindgen::prelude::*;

/// JS-visible signature shape. Same field names as the CLI's `SignatureFile`
/// so dumps from one tool drop straight into the other.
#[derive(Serialize, Deserialize)]
pub struct WasmSignature {
    pub challenge: String,
    pub responses: Vec<String>,
    pub key_image: String,
}

/// Result of `keygen()`. Both fields are 32-byte hex.
#[derive(Serialize)]
pub struct WasmKeypair {
    pub sk: String,
    pub pk: String,
}

/// Generate a fresh BLSAG keypair (Ristretto255 scalar / point).
///
/// The returned secret key MUST be kept private — it can be used both to
/// produce a ring signature (revealing nothing about the signer beyond ring
/// membership) and to derive a deterministic key image (which is the
/// nullifier we use for double-vote prevention).
#[wasm_bindgen]
pub fn keygen() -> Result<JsValue, JsError> {
    use curve25519_dalek::{constants::RISTRETTO_BASEPOINT_POINT, scalar::Scalar};
    let mut rng = OsRng;
    let k = Scalar::random(&mut rng);
    let sk = k.to_bytes();
    let pk = (k * RISTRETTO_BASEPOINT_POINT).compress().to_bytes();
    let kp = WasmKeypair {
        sk: hex::encode(sk),
        pk: hex::encode(pk),
    };
    serde_wasm_bindgen::to_value(&kp).map_err(|e| JsError::new(&e.to_string()))
}

/// Compute the deterministic key image from a secret key.
///
/// `keyImage = k * Hp(K_pi)` — same value every time, function only of the
/// secret key. This is what the tally uses to drop duplicate votes from the
/// same signer.
#[wasm_bindgen(js_name = keyImage)]
pub fn key_image(sk_hex: &str) -> Result<String, JsError> {
    let sk = decode_hex32(sk_hex, "sk")?;
    let img = generate_key_image(&sk).map_err(blsag_err)?;
    Ok(hex::encode(img))
}

/// Sign `message` under the given `ring`.
///
/// `ring` is an array of hex-encoded compressed Ristretto255 points (the
/// public keys announced on-chain). `message` is a hex-encoded byte string —
/// the UI is expected to do its own message-construction (`vote:<id>:<choice>`,
/// etc.) and hex-encode it before calling.
///
/// Returns `WasmSignature` (challenge / responses / key_image, all hex).
/// Throws if `sk` is not in `ring` or if any input is malformed.
#[wasm_bindgen]
pub fn sign_js(sk_hex: &str, ring: Vec<String>, message_hex: &str) -> Result<JsValue, JsError> {
    let sk = decode_hex32(sk_hex, "sk")?;
    let ring_bytes = ring
        .iter()
        .enumerate()
        .map(|(i, s)| decode_hex32(s, &format!("ring[{i}]")))
        .collect::<Result<Vec<_>, _>>()?;
    let msg = hex::decode(message_hex.trim()).map_err(|e| JsError::new(&format!("message: {e}")))?;
    let mut rng = OsRng;
    let sig = sign(&sk, &ring_bytes, &msg, &mut rng).map_err(blsag_err)?;
    let out = WasmSignature {
        challenge: hex::encode(sig.challenge),
        responses: sig.responses.iter().map(hex::encode).collect(),
        key_image: hex::encode(sig.key_image),
    };
    serde_wasm_bindgen::to_value(&out).map_err(|e| JsError::new(&e.to_string()))
}

/// Verify a `WasmSignature` against `ring` and `message`.
///
/// Returns `true` for valid, `false` for mathematically-invalid (wrong msg,
/// tampered fields, ring substitution). Throws on structural errors
/// (malformed hex, wrong field length, ring size mismatch) — those are
/// caller bugs, not "the signature is bad".
#[wasm_bindgen]
pub fn verify_js(
    sig_value: JsValue,
    ring: Vec<String>,
    message_hex: &str,
) -> Result<bool, JsError> {
    let parsed: WasmSignature =
        serde_wasm_bindgen::from_value(sig_value).map_err(|e| JsError::new(&e.to_string()))?;
    let sig = BlsagSignature {
        challenge: decode_hex32(&parsed.challenge, "challenge")?,
        responses: parsed
            .responses
            .iter()
            .enumerate()
            .map(|(i, s)| decode_hex32(s, &format!("responses[{i}]")))
            .collect::<Result<_, _>>()?,
        key_image: decode_hex32(&parsed.key_image, "key_image")?,
    };
    let ring_bytes = ring
        .iter()
        .enumerate()
        .map(|(i, s)| decode_hex32(s, &format!("ring[{i}]")))
        .collect::<Result<Vec<_>, _>>()?;
    let msg = hex::decode(message_hex.trim()).map_err(|e| JsError::new(&format!("message: {e}")))?;
    verify(&sig, &ring_bytes, &msg).map_err(blsag_err)
}

// ----- helpers -----

fn decode_hex32(s: &str, what: &str) -> Result<[u8; 32], JsError> {
    let bytes = hex::decode(s.trim()).map_err(|e| JsError::new(&format!("{what}: {e}")))?;
    if bytes.len() != 32 {
        return Err(JsError::new(&format!(
            "{what}: must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn blsag_err(e: stp_crypto::BlsagError) -> JsError {
    JsError::new(&format!("blsag: {e:?}"))
}
