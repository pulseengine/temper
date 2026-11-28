//! The real GitHub and warte clients: HTTPS through ureq, the App JWT
//! signed RS256 with ring. Secrets are read from files and sent only as
//! Authorization headers to the configured hosts.

use crate::reply::Outcome;
use crate::route::{Method, Route};
use crate::{GitHub, Warte};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const UA: &str = concat!("temper-triage/", env!("CARGO_PKG_VERSION"));

fn agent_with(tls: Option<ureq::tls::TlsConfig>) -> ureq::Agent {
    let mut b = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .max_redirects(0)
        .user_agent(UA);
    if let Some(t) = tls {
        b = b.tls_config(t);
    }
    b.build().into()
}

fn agent() -> ureq::Agent {
    agent_with(None)
}

/// A TLS config that trusts exactly the certificates in the PEM file at
/// `path`. Fails closed: an unreadable file or one without a certificate is
/// an error, never a fallback to the public roots or to no verification.
/// Every certificate is parsed here first, because ureq skips the ones it
/// cannot parse without an error.
pub fn tls_trusting(path: &str) -> Result<ureq::tls::TlsConfig, String> {
    use rustls_pki_types::pem::PemObject;
    use rustls_pki_types::CertificateDer;
    let pem = std::fs::read(path).map_err(|e| format!("warte_ca_file {path}: {e}"))?;
    let mut roots = rustls::RootCertStore::empty();
    let mut certs = Vec::new();
    for c in CertificateDer::pem_slice_iter(&pem) {
        let c = c.map_err(|e| format!("warte_ca_file {path}: {e}"))?;
        certs.push(ureq::tls::Certificate::from_der(c.as_ref()).to_owned());
        roots
            .add(c)
            .map_err(|e| format!("warte_ca_file {path}: {e}"))?;
    }
    if roots.is_empty() {
        return Err(format!("warte_ca_file {path}: no certificate in it"));
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Ok(ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::Rustls)
        .root_certs(ureq::tls::RootCerts::Specific(Arc::new(certs)))
        .unversioned_rustls_crypto_provider(provider)
        .build())
}

/// A transport error as a fixed category, never ureq's own message, which
/// may carry the URL or a server-supplied string.
fn err_kind(e: &ureq::Error) -> &'static str {
    match e {
        ureq::Error::Timeout(_) => "timeout",
        ureq::Error::HostNotFound => "host not found",
        ureq::Error::ConnectionFailed => "connection failed",
        // rustls reports a refused certificate as an io::Error wrapping it.
        ureq::Error::Io(io) if io.get_ref().is_some_and(|i| i.is::<rustls::Error>()) => "tls error",
        ureq::Error::Io(_) => "io error",
        ureq::Error::Tls(_) => "tls error",
        ureq::Error::Rustls(_) => "tls error",
        ureq::Error::TooManyRedirects => "too many redirects",
        ureq::Error::Json(_) => "invalid json",
        _ => "transport error",
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The DER inside a PEM file, and whether it was PKCS#1 ("RSA PRIVATE KEY").
fn pem_der(pem: &str) -> Result<(Vec<u8>, bool), String> {
    let pkcs1 = pem.contains("-----BEGIN RSA PRIVATE KEY-----");
    let b64: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .flat_map(|l| l.trim().chars())
        .collect();
    let der = STANDARD
        .decode(b64)
        .map_err(|_| "app key: not a PEM file".to_string())?;
    Ok((der, pkcs1))
}

pub struct AppKey(ring::signature::RsaKeyPair);

impl AppKey {
    pub fn from_pem(pem: &str) -> Result<AppKey, String> {
        let (der, pkcs1) = pem_der(pem)?;
        let kp = if pkcs1 {
            ring::signature::RsaKeyPair::from_der(&der)
        } else {
            ring::signature::RsaKeyPair::from_pkcs8(&der)
        };
        kp.map(AppKey).map_err(|e| format!("app key: {e}"))
    }

    /// An App JWT valid for 9 minutes (iat backdated 60 s for clock skew).
    pub fn jwt(&self, app_id: u64) -> Result<String, String> {
        let t = now();
        let head = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(
            json!({"iat": t.saturating_sub(60), "exp": t + 540, "iss": app_id.to_string()})
                .to_string(),
        );
        let msg = format!("{head}.{claims}");
        let mut sig = vec![0u8; self.0.public().modulus_len()];
        self.0
            .sign(
                &ring::signature::RSA_PKCS1_SHA256,
                &ring::rand::SystemRandom::new(),
                msg.as_bytes(),
                &mut sig,
            )
            .map_err(|_| "app key: signing failed".to_string())?;
        Ok(format!("{msg}.{}", URL_SAFE_NO_PAD.encode(sig)))
    }
}

pub struct RealGitHub {
    api: String,
    org: String,
    app_id: u64,
    key: AppKey,
    /// The installation token and when it was minted (tokens last an hour).
    token: Option<(String, u64)>,
    http: ureq::Agent,
}

impl RealGitHub {
    pub fn new(api: &str, org: &str, app_id: u64, key: AppKey) -> RealGitHub {
        RealGitHub {
            api: api.trim_end_matches('/').into(),
            org: org.into(),
            app_id,
            key,
            token: None,
            http: agent(),
        }
    }

    fn installation_token(&mut self) -> Result<String, String> {
        if let Some((t, at)) = &self.token {
            if now().saturating_sub(*at) < 50 * 60 {
                return Ok(t.clone());
            }
        }
        let inst = self.call(&Route::OrgInstallation, None)?;
        let id = inst["id"].as_u64().ok_or("installation: no id")?;
        // Scoped to what a reply needs, not the installation's full grant.
        let scope = json!({"permissions": {"issues": "write", "metadata": "read"}});
        let tok = self.call(&Route::InstallationToken(id), Some(&scope))?;
        let t = tok["token"]
            .as_str()
            .ok_or("installation token: none returned")?
            .to_string();
        self.token = Some((t.clone(), now()));
        Ok(t)
    }

    /// `<slug>[bot]`, the login the App's comments carry.
    pub fn bot_login(&mut self) -> Result<String, String> {
        let app = self.call(&Route::App, None)?;
        let slug = app["slug"].as_str().ok_or("app: no slug")?;
        Ok(format!("{slug}[bot]"))
    }
}

impl GitHub for RealGitHub {
    fn call(&mut self, route: &Route, body: Option<&Value>) -> Result<Value, String> {
        let auth = if route.app_auth() {
            format!("Bearer {}", self.key.jwt(self.app_id)?)
        } else {
            format!("token {}", self.installation_token()?)
        };
        let (method, path) = route.request(&self.org);
        let m = match method {
            Method::Get => "GET",
            Method::Post => "POST",
        };
        let url = format!("{}{path}", self.api);
        let res = match method {
            Method::Get => self
                .http
                .get(&url)
                .header("Authorization", &auth)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .call(),
            Method::Post => self
                .http
                .post(&url)
                .header("Authorization", &auth)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .send_json(body.cloned().unwrap_or_else(|| json!({}))),
        };
        // Only the method and path are reported: never the token or a body.
        match res {
            // max_redirects(0) hands a 3xx back as Ok: only 2xx is success.
            Ok(r) if !r.status().is_success() => {
                Err(format!("{m} {path}: HTTP {}", r.status().as_u16()))
            }
            Ok(mut r) => r
                .body_mut()
                .read_json::<Value>()
                .map_err(|e| format!("{m} {path}: {e}")),
            Err(ureq::Error::StatusCode(code)) => Err(format!("{m} {path}: HTTP {code}")),
            Err(e) => Err(format!("{m} {path}: {}", err_kind(&e))),
        }
    }
}

pub struct RealWarte {
    base: String,
    auth: String,
    http: ureq::Agent,
}

impl RealWarte {
    /// `ca_file`: trust only this CA for warte (see `tls_trusting`).
    pub fn new(base: &str, token: &str, ca_file: Option<&str>) -> Result<RealWarte, String> {
        let http = match ca_file {
            Some(p) => agent_with(Some(tls_trusting(p)?)),
            None => agent(),
        };
        Ok(RealWarte {
            base: base.trim_end_matches('/').into(),
            auth: format!("Bearer {}", token.trim()),
            http,
        })
    }
}

impl Warte for RealWarte {
    fn offer(&mut self) -> Result<Vec<(String, u64)>, String> {
        let mut v = self
            .http
            .get(&format!("{}/api/triage", self.base))
            .header("Authorization", &self.auth)
            .call()
            .map_err(|e| match e {
                ureq::Error::StatusCode(c) => format!("GET /api/triage: HTTP {c}"),
                e => format!("GET /api/triage: {}", err_kind(&e)),
            })?;
        if !v.status().is_success() {
            return Err(format!("GET /api/triage: HTTP {}", v.status().as_u16()));
        }
        let v: Value = v
            .body_mut()
            .read_json()
            .map_err(|e| format!("GET /api/triage: {e}"))?;
        let ready = v["ready"]
            .as_array()
            .ok_or("GET /api/triage: no ready list")?;
        Ok(ready
            .iter()
            .filter_map(|i| Some((i["repo"].as_str()?.to_string(), i["number"].as_u64()?)))
            .collect())
    }

    fn done(&mut self, repo: &str, number: u64, outcome: Outcome) -> Result<bool, String> {
        let r = self
            .http
            .post(&format!("{}/api/triage/done", self.base))
            .header("Authorization", &self.auth)
            .send_json(json!({"repo": repo, "number": number, "outcome": outcome.as_str()}));
        match r {
            Ok(r) if r.status().is_success() => Ok(true),
            Ok(r) => Err(format!(
                "POST /api/triage/done: HTTP {}",
                r.status().as_u16()
            )),
            Err(ureq::Error::StatusCode(422)) => Ok(false),
            Err(ureq::Error::StatusCode(c)) => Err(format!("POST /api/triage/done: HTTP {c}")),
            Err(e) => Err(format!("POST /api/triage/done: {}", err_kind(&e))),
        }
    }
}
