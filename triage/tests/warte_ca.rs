//! warte_ca_file fails closed: a missing, empty or certificate-free file is
//! an error, and a real CA certificate loads. The CA is generated per run.

use std::process::Command;
use temper_triage::net::{tls_trusting, RealWarte};

#[test]
fn ca_file_loads_a_certificate_and_fails_closed_otherwise() {
    let dir = std::env::temp_dir().join(format!("temper-triage-ca-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ca = dir.join("ca.pem");
    let key = dir.join("ca.key");
    let ok = Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=test-ca",
        ])
        .arg("-keyout")
        .arg(&key)
        .arg("-out")
        .arg(&ca)
        .output()
        .expect("openssl runs");
    assert!(ok.status.success());
    assert!(tls_trusting(ca.to_str().unwrap()).is_ok());

    let missing = dir.join("missing.pem");
    assert!(tls_trusting(missing.to_str().unwrap()).is_err());
    assert!(RealWarte::new(
        "https://warte.example",
        "t",
        Some(missing.to_str().unwrap())
    )
    .is_err());

    let empty = dir.join("empty.pem");
    std::fs::write(&empty, "").unwrap();
    assert!(tls_trusting(empty.to_str().unwrap()).is_err());
    // a private key is not a certificate
    assert!(tls_trusting(key.to_str().unwrap()).is_err());
    std::fs::remove_dir_all(&dir).ok();
}
