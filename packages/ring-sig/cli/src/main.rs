//! ring-cli — debugging frontend for the vendored BLSAG ring signature crate.
//!
//! This binary exists for two reasons:
//!   1. Manual round-trips during development without spinning up the WASM
//!      build pipeline.
//!   2. An independent reference verifier: anyone can `cargo run -p ring-cli --
//!      verify ring.json msg.txt sig.json` to re-check a vote off-chain
//!      without trusting the browser WASM bundle.
//!
//! Wire format: every key, ring member, key image, challenge, and response is
//! a lowercase hex string with no `0x` prefix. Rings are JSON `{"ring": [hex,
//! hex, ...]}`. Signatures are JSON with the same shape as `BlsagSignature`
//! but with all `[u8; 32]` fields hex-encoded. This format is what the UI and
//! the on-chain remarks will eventually marshal — keeping it stable here
//! gives us one source of truth.
//!
//! No private keys are ever written to stdout in a non-explicit subcommand;
//! `keygen` is the only command that emits a secret, and it does so to a file
//! the caller specifies (or stdout if `--stdout`).

use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use stp_crypto::{generate_key_image, sign, verify, BlsagSignature};

#[derive(Parser)]
#[command(name = "ring-cli", about = "BLSAG ring signature debugging CLI", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Generate a fresh (sk, pk) pair. Writes to two files (or stdout if
    /// `--stdout`).
    Keygen {
        /// Path to write the secret key (32 bytes hex). Default: stdout.
        #[arg(long)]
        sk_out: Option<PathBuf>,
        /// Path to write the public key (32 bytes hex). Default: stdout.
        #[arg(long)]
        pk_out: Option<PathBuf>,
    },
    /// Derive the deterministic key image from a secret key.
    KeyImage {
        /// Path to a file containing the secret key as hex.
        sk: PathBuf,
    },
    /// Sign a message under a ring.
    Sign {
        /// Path to a file containing the secret key as hex.
        #[arg(long)]
        sk: PathBuf,
        /// Path to ring.json (`{"ring": [hex, ...]}`).
        #[arg(long)]
        ring: PathBuf,
        /// Path to a file whose contents are the message bytes (raw, not hex).
        #[arg(long)]
        msg: PathBuf,
        /// Path to write the signature JSON. Default: stdout.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Verify a signature against a ring and message.
    Verify {
        /// Path to ring.json.
        #[arg(long)]
        ring: PathBuf,
        /// Path to the message file.
        #[arg(long)]
        msg: PathBuf,
        /// Path to the signature JSON.
        #[arg(long)]
        sig: PathBuf,
    },
}

/// JSON shape of a ring file. Order matters — verification requires the same
/// order used at signing time.
#[derive(Serialize, Deserialize)]
struct RingFile {
    ring: Vec<String>,
}

/// JSON shape of a signature file. Mirror of `BlsagSignature` with hex
/// encoding so the file is human-readable / diffable.
#[derive(Serialize, Deserialize)]
struct SignatureFile {
    challenge: String,
    responses: Vec<String>,
    key_image: String,
}

impl SignatureFile {
    fn from_blsag(sig: &BlsagSignature) -> Self {
        Self {
            challenge: hex::encode(sig.challenge),
            responses: sig.responses.iter().map(hex::encode).collect(),
            key_image: hex::encode(sig.key_image),
        }
    }

    fn into_blsag(self) -> Result<BlsagSignature> {
        Ok(BlsagSignature {
            challenge: hex32(&self.challenge, "challenge")?,
            responses: self
                .responses
                .iter()
                .enumerate()
                .map(|(i, s)| hex32(s, &format!("responses[{i}]")))
                .collect::<Result<_>>()?,
            key_image: hex32(&self.key_image, "key_image")?,
        })
    }
}

fn hex32(s: &str, what: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(s.trim()).with_context(|| format!("decoding {what}"))?;
    if bytes.len() != 32 {
        bail!("{what} must be 32 bytes, got {}", bytes.len());
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn read_hex32(path: &PathBuf, what: &str) -> Result<[u8; 32]> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("reading {what} from {}", path.display()))?;
    hex32(&raw, what)
}

fn read_ring(path: &PathBuf) -> Result<Vec<[u8; 32]>> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("reading ring at {}", path.display()))?;
    let parsed: RingFile = serde_json::from_str(&raw).context("parsing ring.json")?;
    parsed
        .ring
        .iter()
        .enumerate()
        .map(|(i, s)| hex32(s, &format!("ring[{i}]")))
        .collect()
}

fn write_or_stdout(path: Option<&PathBuf>, content: &str) -> Result<()> {
    match path {
        Some(p) => fs::write(p, content)
            .with_context(|| format!("writing to {}", p.display())),
        None => {
            println!("{content}");
            Ok(())
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Keygen { sk_out, pk_out } => keygen(sk_out, pk_out),
        Cmd::KeyImage { sk } => key_image(sk),
        Cmd::Sign { sk, ring, msg, out } => do_sign(sk, ring, msg, out),
        Cmd::Verify { ring, msg, sig } => do_verify(ring, msg, sig),
    }
}

/// Generate a fresh BLSAG-compatible scalar/point pair.
///
/// We sample a uniform Ristretto255 scalar with `rand::OsRng`, multiply by the
/// basepoint, and emit `(sk_bytes, pk_bytes)`. This is the same construction
/// used by the upstream tests, and the keys are interchangeable with anything
/// produced by `stp-crypto::sign`.
fn keygen(sk_out: Option<PathBuf>, pk_out: Option<PathBuf>) -> Result<()> {
    use curve25519_dalek::{constants::RISTRETTO_BASEPOINT_POINT, scalar::Scalar};
    let mut rng = OsRng;
    let k = Scalar::random(&mut rng);
    let sk = k.to_bytes();
    let pk = (k * RISTRETTO_BASEPOINT_POINT).compress().to_bytes();
    write_or_stdout(sk_out.as_ref(), &hex::encode(sk))?;
    write_or_stdout(pk_out.as_ref(), &hex::encode(pk))?;
    Ok(())
}

fn key_image(sk_path: PathBuf) -> Result<()> {
    let sk = read_hex32(&sk_path, "sk")?;
    let img = generate_key_image(&sk).map_err(|e| anyhow!("generate_key_image: {e:?}"))?;
    println!("{}", hex::encode(img));
    Ok(())
}

fn do_sign(
    sk_path: PathBuf,
    ring_path: PathBuf,
    msg_path: PathBuf,
    out: Option<PathBuf>,
) -> Result<()> {
    let sk = read_hex32(&sk_path, "sk")?;
    let ring = read_ring(&ring_path)?;
    let msg = fs::read(&msg_path)
        .with_context(|| format!("reading message at {}", msg_path.display()))?;
    let mut rng = OsRng;
    let sig = sign(&sk, &ring, &msg, &mut rng).map_err(|e| anyhow!("sign: {e:?}"))?;
    let body = serde_json::to_string_pretty(&SignatureFile::from_blsag(&sig))?;
    write_or_stdout(out.as_ref(), &body)
}

fn do_verify(ring_path: PathBuf, msg_path: PathBuf, sig_path: PathBuf) -> Result<()> {
    let ring = read_ring(&ring_path)?;
    let msg = fs::read(&msg_path)
        .with_context(|| format!("reading message at {}", msg_path.display()))?;
    let raw =
        fs::read_to_string(&sig_path).with_context(|| format!("reading signature at {}", sig_path.display()))?;
    let parsed: SignatureFile = serde_json::from_str(&raw).context("parsing sig.json")?;
    let sig = parsed.into_blsag()?;
    match verify(&sig, &ring, &msg) {
        Ok(true) => {
            println!("OK");
            Ok(())
        }
        Ok(false) => {
            eprintln!("INVALID");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("ERROR: {e:?}");
            std::process::exit(2);
        }
    }
}
