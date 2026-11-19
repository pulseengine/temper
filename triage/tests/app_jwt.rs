//! The App JWT: both PEM forms GitHub has issued load, and the signature
//! verifies under the key's public half. Keys are generated per run with
//! openssl (none is committed); a missing openssl fails the test.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::signature::{KeyPair, RsaKeyPair, UnparsedPublicKey, RSA_PKCS1_2048_8192_SHA256};
use std::process::Command;
use temper_triage::net::AppKey;

fn key(args: &[&str]) -> String {
    let out = Command::new("openssl")
        .args(args)
        .output()
        .expect("openssl runs");
    assert!(out.status.success(), "openssl {args:?}");
    String::from_utf8(out.stdout).unwrap()
}

fn der_of(pem: &str) -> Vec<u8> {
    use base64::engine::general_purpose::STANDARD;
    let b: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    STANDARD.decode(b).unwrap()
}

#[test]
fn jwt_signs_with_pkcs1_and_pkcs8_keys() {
    let pkcs1 = key(&["genrsa", "-traditional", "2048"]);
    let pkcs8 = key(&[
        "genpkey",
        "-algorithm",
        "RSA",
        "-pkeyopt",
        "rsa_keygen_bits:2048",
    ]);
    assert!(pkcs1.starts_with("-----BEGIN RSA PRIVATE KEY-----"));
    assert!(pkcs8.starts_with("-----BEGIN PRIVATE KEY-----"));
    for (pem, is1) in [(&pkcs1, true), (&pkcs8, false)] {
        let jwt = AppKey::from_pem(pem)
            .expect("key loads")
            .jwt(4242)
            .expect("signs");
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "4242");
        let ttl = claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap();
        assert!(ttl <= 600, "GitHub refuses App JWTs over 10 minutes: {ttl}");
        let kp = if is1 {
            RsaKeyPair::from_der(&der_of(pem))
        } else {
            RsaKeyPair::from_pkcs8(&der_of(pem))
        }
        .unwrap();
        let public = UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, kp.public_key().as_ref());
        let msg = format!("{}.{}", parts[0], parts[1]);
        let sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        public
            .verify(msg.as_bytes(), &sig)
            .expect("signature verifies");
        let mut bad = sig.clone();
        bad[0] ^= 1;
        assert!(
            public.verify(msg.as_bytes(), &bad).is_err(),
            "control: a flipped bit fails"
        );
    }
    assert!(AppKey::from_pem(
        "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n"
    )
    .is_err());
}
