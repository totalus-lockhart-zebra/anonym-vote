//! End-to-end CLI round-trip test.
//!
//! The upstream `stp-crypto` crate already exhaustively tests the
//! cryptographic surface. What this test pins down is the *wire format* the
//! CLI exposes — the JSON shapes of `ring.json` / `sig.json`, the hex
//! encoding of secret/public keys, and the exit-code contract for `verify`.
//! These are the only places the CLI adds anything on top of the library, so
//! these are the only places the CLI needs its own coverage.
//!
//! If you change the JSON shapes or hex conventions, expect this test to
//! fail loudly. The UI / WASM bindings will marshal into the same shapes;
//! breaking the format here means breaking compatibility with everything
//! downstream.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn bin() -> PathBuf {
    // CARGO_BIN_EXE_<name> is auto-set by cargo for integration tests of
    // binary crates — points at the freshly built binary.
    PathBuf::from(env!("CARGO_BIN_EXE_ring-cli"))
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(bin())
        .args(args)
        .output()
        .expect("failed to spawn ring-cli")
}

fn assert_ok(out: &std::process::Output, ctx: &str) {
    assert!(
        out.status.success(),
        "{ctx}: exit={:?} stdout={:?} stderr={:?}",
        out.status.code(),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}

fn assert_fail(out: &std::process::Output, ctx: &str) {
    assert!(
        !out.status.success(),
        "{ctx}: expected non-zero exit, got success: stdout={:?}",
        String::from_utf8_lossy(&out.stdout),
    );
}

#[test]
fn keygen_sign_verify_round_trip() {
    let tmp = tempdir();

    // 3 fresh keypairs. Alice will be the signer; Bob and Eve are decoys.
    for who in ["alice", "bob", "eve"] {
        let out = run(&[
            "keygen",
            "--sk-out",
            tmp.join(format!("{who}.sk")).to_str().unwrap(),
            "--pk-out",
            tmp.join(format!("{who}.pk")).to_str().unwrap(),
        ]);
        assert_ok(&out, &format!("keygen {who}"));
    }

    let alice_pk = read(&tmp.join("alice.pk"));
    let bob_pk = read(&tmp.join("bob.pk"));
    let eve_pk = read(&tmp.join("eve.pk"));

    // Build the ring file. Order matters — verify must use the same order.
    let ring_path = tmp.join("ring.json");
    fs::write(
        &ring_path,
        format!(r#"{{"ring":["{alice_pk}","{bob_pk}","{eve_pk}"]}}"#),
    )
    .unwrap();

    let msg_path = tmp.join("msg.bin");
    fs::write(&msg_path, b"vote:proposal-1:yes").unwrap();
    let sig_path = tmp.join("sig.json");

    // Sign with Alice.
    let out = run(&[
        "sign",
        "--sk",
        tmp.join("alice.sk").to_str().unwrap(),
        "--ring",
        ring_path.to_str().unwrap(),
        "--msg",
        msg_path.to_str().unwrap(),
        "--out",
        sig_path.to_str().unwrap(),
    ]);
    assert_ok(&out, "sign");

    // The signature file must parse and have the right shape — three hex
    // fields, with `responses` matching ring length.
    let sig_text = fs::read_to_string(&sig_path).unwrap();
    let sig_json: serde_json::Value = serde_json::from_str(&sig_text).unwrap();
    assert!(sig_json["challenge"].is_string());
    assert!(sig_json["key_image"].is_string());
    assert_eq!(
        sig_json["responses"].as_array().unwrap().len(),
        3,
        "responses count must match ring size"
    );

    // Verify the original signature against the original ring/message.
    let out = run(&[
        "verify",
        "--ring",
        ring_path.to_str().unwrap(),
        "--msg",
        msg_path.to_str().unwrap(),
        "--sig",
        sig_path.to_str().unwrap(),
    ]);
    assert_ok(&out, "verify happy path");

    // Tampered message — exit code must be non-zero so callers can `&&`.
    let wrong_msg = tmp.join("wrong.bin");
    fs::write(&wrong_msg, b"vote:proposal-1:no").unwrap();
    let out = run(&[
        "verify",
        "--ring",
        ring_path.to_str().unwrap(),
        "--msg",
        wrong_msg.to_str().unwrap(),
        "--sig",
        sig_path.to_str().unwrap(),
    ]);
    assert_fail(&out, "verify tampered msg");

    // Reordered ring — same members, different order, must reject.
    let swap_path = tmp.join("swap.json");
    fs::write(
        &swap_path,
        format!(r#"{{"ring":["{bob_pk}","{alice_pk}","{eve_pk}"]}}"#),
    )
    .unwrap();
    let out = run(&[
        "verify",
        "--ring",
        swap_path.to_str().unwrap(),
        "--msg",
        msg_path.to_str().unwrap(),
        "--sig",
        sig_path.to_str().unwrap(),
    ]);
    assert_fail(&out, "verify reordered ring");
}

#[test]
fn key_image_is_deterministic() {
    // Critical property for double-vote prevention: the same secret key must
    // always produce the same key image. The library tests cover this; we
    // re-verify it through the CLI surface to make sure no encoding step
    // (hex round-trip, file I/O) accidentally introduces nondeterminism.
    let tmp = tempdir();
    let sk_path = tmp.join("sk.hex");
    let pk_path = tmp.join("pk.hex");
    assert_ok(
        &run(&[
            "keygen",
            "--sk-out",
            sk_path.to_str().unwrap(),
            "--pk-out",
            pk_path.to_str().unwrap(),
        ]),
        "keygen",
    );

    let img1 = run(&["key-image", sk_path.to_str().unwrap()]);
    assert_ok(&img1, "key-image first call");
    let img2 = run(&["key-image", sk_path.to_str().unwrap()]);
    assert_ok(&img2, "key-image second call");
    assert_eq!(img1.stdout, img2.stdout);
    // 32 bytes hex + newline = 65 chars
    assert_eq!(img1.stdout.len(), 65);
}

// ----- tiny tempdir helper -----
//
// We don't pull the `tempfile` crate just for this — one test, two test
// functions, std::env::temp_dir + a unique suffix is enough. Each test
// gets its own directory; cleanup happens via Drop on `Tmp`.

struct Tmp(PathBuf);

impl Tmp {
    fn join<P: AsRef<std::path::Path>>(&self, p: P) -> PathBuf {
        self.0.join(p)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn tempdir() -> Tmp {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let pid = std::process::id();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("ring-cli-test-{pid}-{n}"));
    fs::create_dir_all(&dir).unwrap();
    Tmp(dir)
}

fn read(p: &PathBuf) -> String {
    fs::read_to_string(p).unwrap().trim().to_string()
}
