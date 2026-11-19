//! The real GitHub and warte clients: HTTPS through ureq, the App JWT
//! signed RS256 with ring. Secrets are read from files and sent only as
//! Authorization headers to the configured hosts.

use crate::reply::Outcome;
use crate::route::{Method, Route};
use crate::{GitHub, Warte};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const UA: &str = concat!("temper-triage/", env!("CARGO_PKG_VERSION"));

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .redirects(0)
        .user_agent(UA)
        .build()
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
        let claims = URL_SAFE_NO_PAD
            .encode(json!({"iat": t - 60, "exp": t + 540, "iss": app_id.to_string()}).to_string());
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
    token: Option<String>,
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
        if let Some(t) = &self.token {
            return Ok(t.clone());
        }
        let inst = self.call(&Route::OrgInstallation, None)?;
        let id = inst["id"].as_u64().ok_or("installation: no id")?;
        let tok = self.call(&Route::InstallationToken(id), None)?;
        let t = tok["token"]
            .as_str()
            .ok_or("installation token: none returned")?
            .to_string();
        self.token = Some(t.clone());
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
        let req = self
            .http
            .request(m, &format!("{}{path}", self.api))
            .set("Authorization", &auth)
            .set("Accept", "application/vnd.github+json")
            .set("X-GitHub-Api-Version", "2022-11-28");
        let res = match body {
            Some(b) => req.send_json(b.clone()),
            None if method == Method::Post => req.send_json(json!({})),
            None => req.call(),
        };
        // Only the method and path are reported: never the token or a body.
        match res {
            Ok(r) => r
                .into_json::<Value>()
                .map_err(|e| format!("{m} {path}: {e}")),
            Err(ureq::Error::Status(code, _)) => Err(format!("{m} {path}: HTTP {code}")),
            Err(e) => Err(format!("{m} {path}: {}", e.kind())),
        }
    }
}

pub struct RealWarte {
    base: String,
    auth: String,
    http: ureq::Agent,
}

impl RealWarte {
    pub fn new(base: &str, token: &str) -> RealWarte {
        RealWarte {
            base: base.trim_end_matches('/').into(),
            auth: format!("Bearer {}", token.trim()),
            http: agent(),
        }
    }
}

impl Warte for RealWarte {
    fn offer(&mut self) -> Result<Vec<(String, u64)>, String> {
        let v: Value = self
            .http
            .get(&format!("{}/api/triage", self.base))
            .set("Authorization", &self.auth)
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(c, _) => format!("GET /api/triage: HTTP {c}"),
                e => format!("GET /api/triage: {}", e.kind()),
            })?
            .into_json()
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
            .set("Authorization", &self.auth)
            .send_json(json!({"repo": repo, "number": number, "outcome": outcome.as_str()}));
        match r {
            Ok(_) => Ok(true),
            Err(ureq::Error::Status(422, _)) => Ok(false),
            Err(ureq::Error::Status(c, _)) => Err(format!("POST /api/triage/done: HTTP {c}")),
            Err(e) => Err(format!("POST /api/triage/done: {}", e.kind())),
        }
    }
}
