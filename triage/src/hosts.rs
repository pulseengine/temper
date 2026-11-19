//! Host-shaped values that must not reach a public reply.
//!
//! A port of pulseengine-claude `hooks/private_hosts.py` `find()`: the same
//! four patterns plus the service user's home directory, the same order and
//! the same de-duplication. `tests/private_hosts.rs` holds the equivalence
//! cases, whose expected hits were produced by the Python module.

use fancy_regex::Regex;
use std::sync::OnceLock;

fn patterns() -> &'static [(&'static str, Regex)] {
    static P: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    P.get_or_init(|| {
        let src: [(&str, &str); 4] = [
            (
                "mdns/lan",
                r"(?i)(?<![\w.*-])(?:[a-z0-9][a-z0-9-]*\.)+(?:local|lan|home\.arpa|ts\.net)(?![\w-])(?!\.[a-z0-9])",
            ),
            (
                "ipv4",
                r"(?<![\w.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}(?![\w.]*\d)",
            ),
            (
                "ula",
                r"(?i)(?<![\w:])f[cd][0-9a-f]{2}:(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}(?![\w:])",
            ),
            ("volumes", r#"/Volumes/[A-Za-z0-9][^\s'"`)\]}>,;]*"#),
        ];
        src.iter()
            .map(|(k, p)| (*k, Regex::new(p).expect("static pattern")))
            .collect()
    })
}

fn home_pattern(home: &str) -> Option<Regex> {
    let home = home.trim_end_matches('/');
    // "/" or "/root"-short homes would match far too much.
    if home.matches('/').count() < 2 {
        return None;
    }
    Regex::new(&format!(r"{}(?![\w.-])", fancy_regex::escape(home))).ok()
}

/// Every host-shaped value in `text`, in pattern order, unique.
pub fn find(text: &str, home: Option<&str>) -> Vec<(&'static str, String)> {
    let mut out: Vec<(&'static str, String)> = Vec::new();
    if text.is_empty() {
        return out;
    }
    let hp = home.and_then(home_pattern);
    let mut all: Vec<(&'static str, &Regex)> = patterns().iter().map(|(k, r)| (*k, r)).collect();
    if let Some(h) = hp.as_ref() {
        all.push(("home", h));
    }
    for (kind, rx) in all {
        for m in rx.find_iter(text).flatten() {
            let v = m.as_str().trim_end_matches('.').to_string();
            if kind == "ula" && v.matches(':').count() < 2 {
                continue;
            }
            if !out.iter().any(|(_, s)| *s == v) {
                out.push((kind, v));
            }
        }
    }
    out
}

/// A value shown in a log without disclosing it.
pub fn mask(value: &str) -> String {
    let v: Vec<char> = value.trim().chars().collect();
    if v.len() > 6 {
        let head: String = v[..2].iter().collect();
        let tail: String = v[v.len() - 3..].iter().collect();
        format!("{head}***{tail}")
    } else {
        "***".into()
    }
}

/// The outgoing check: `Err` names each hit, masked, when `text` carries a
/// host-shaped value or a deny-list entry (case-insensitive substring).
pub fn check_outgoing(text: &str, deny: &[String], home: Option<&str>) -> Result<(), String> {
    let mut hits: Vec<String> = find(text, home)
        .into_iter()
        .map(|(k, v)| format!("{k} {}", mask(&v)))
        .collect();
    let lower = text.to_lowercase();
    for d in deny.iter().filter(|d| !d.trim().is_empty()) {
        if lower.contains(&d.trim().to_lowercase()) {
            hits.push(format!("deny {}", mask(d)));
        }
    }
    if hits.is_empty() {
        Ok(())
    } else {
        Err(hits.join(", "))
    }
}
