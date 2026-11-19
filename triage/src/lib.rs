//! temper-triage: first replies for warte's issue queue (docs/triage.md).
//!
//! The pure parts (classifier, templates, outgoing check, routes) and the
//! per-issue handler live here, behind the `GitHub` and `Warte` traits, so
//! the negative controls in `tests/` run against recording fakes.

pub mod hosts;
pub mod net;
pub mod reply;
pub mod route;

use reply::{Kind, Outcome};
use route::{RepoName, Route};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The deploy's configuration. Trusted: written by the operator.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub org: String,
    pub warte_url: String,
    pub app_id: u64,
    /// Repository names served; `"*"` serves every public repository.
    pub repos: Vec<String>,
    #[serde(default)]
    pub docs_url: Option<String>,
    #[serde(default)]
    pub ask_label: Option<String>,
    /// Substrings never to post (runner names, hostnames, confidential topics).
    #[serde(default)]
    pub deny: Vec<String>,
    #[serde(default)]
    pub warte_token_file: Option<String>,
    #[serde(default)]
    pub app_key_file: Option<String>,
    /// PEM CA that signs warte's certificate, when it is not publicly trusted.
    /// Only this CA is then trusted for warte; a missing file is an error.
    #[serde(default)]
    pub warte_ca_file: Option<String>,
    #[serde(default = "default_api")]
    pub github_api: String,
}

fn default_api() -> String {
    "https://api.github.com".into()
}

impl Config {
    pub fn parse(text: &str) -> Result<Config, String> {
        let c: Config = toml::from_str(text).map_err(|e| format!("config: {e}"))?;
        c.check()?;
        Ok(c)
    }

    fn check(&self) -> Result<(), String> {
        if RepoName::parse(&self.org).is_none() {
            return Err("config: org is not a GitHub name".into());
        }
        if self.repos.is_empty() {
            return Err(
                "config: repos is empty; use [\"*\"] to serve every public repository".into(),
            );
        }
        for r in &self.repos {
            if r != "*" && RepoName::parse(r).is_none() {
                return Err(format!(
                    "config: repos entry {r:?} is not a repository name"
                ));
            }
        }
        for (k, u) in [
            ("warte_url", Some(&self.warte_url)),
            ("github_api", Some(&self.github_api)),
            ("docs_url", self.docs_url.as_ref()),
        ] {
            if let Some(u) = u {
                if !u.starts_with("https://")
                    || u.chars().any(|c| c.is_whitespace() || c.is_control())
                {
                    return Err(format!("config: {k} must be an https URL without spaces"));
                }
            }
        }
        if let Some(l) = &self.ask_label {
            let ok = (1..=50).contains(&l.len())
                && l.chars()
                    .all(|c| c.is_ascii_alphanumeric() || " -_:./".contains(c));
            if !ok {
                return Err(
                    "config: ask_label must be 1-50 characters of [A-Za-z0-9 -_:./]".into(),
                );
            }
        }
        Ok(())
    }

    pub fn serves(&self, repo: &str) -> bool {
        self.repos
            .iter()
            .any(|r| r == "*" || r.eq_ignore_ascii_case(repo))
    }
}

/// GitHub as the handler sees it: only `Route`s.
pub trait GitHub {
    fn call(&mut self, route: &Route, body: Option<&Value>) -> Result<Value, String>;
}

/// warte's triage routes.
pub trait Warte {
    /// The ready items' `(repo, number)`; nothing else of the offer is read.
    fn offer(&mut self) -> Result<Vec<(String, u64)>, String>;
    /// `Ok(true)` when marked, `Ok(false)` when warte says it is not queued (422).
    fn done(&mut self, repo: &str, number: u64, outcome: Outcome) -> Result<bool, String>;
}

/// What happened to one item.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Plan {
    pub repo: String,
    pub number: u64,
    pub outcome: Outcome,
    pub kind: Option<Kind>,
    pub posted: bool,
    pub reason: String,
}

const INTERNAL: &[&str] = &["OWNER", "MEMBER", "COLLABORATOR"];
/// Comment pages read before giving up (100 per page).
const MAX_PAGES: u32 = 10;

pub struct Handler<'a> {
    pub cfg: &'a Config,
    /// `<app-slug>[bot]`, from GET /app.
    pub bot_login: String,
    /// The service user's home, for the outgoing check.
    pub home: Option<String>,
    pub dry_run: bool,
}

impl Handler<'_> {
    fn plan(
        &self,
        repo: &str,
        number: u64,
        outcome: Outcome,
        kind: Option<Kind>,
        posted: bool,
        reason: impl Into<String>,
    ) -> Plan {
        Plan {
            repo: repo.into(),
            number,
            outcome,
            kind,
            posted,
            reason: reason.into(),
        }
    }

    fn skip(&self, repo: &str, number: u64, reason: impl Into<String>) -> Plan {
        self.plan(repo, number, Outcome::Skipped, None, false, reason)
    }

    /// One offered issue: decide, and post unless `dry_run`. `Err` means a
    /// GitHub read or the comment write failed; the item stays unmarked.
    pub fn handle(&self, gh: &mut dyn GitHub, repo: &str, number: u64) -> Result<Plan, String> {
        let Some(name) = RepoName::parse(repo) else {
            return Ok(self.skip(repo, number, "not a repository name"));
        };
        if number == 0 {
            return Ok(self.skip(repo, number, "not an issue number"));
        }
        if !self.cfg.serves(repo) {
            return Ok(self.skip(repo, number, "repository not in the allow-list"));
        }
        let r = gh.call(&Route::Repo(name.clone()), None)?;
        if r["private"].as_bool() != Some(false)
            || r["visibility"].as_str().is_some_and(|v| v != "public")
        {
            return Ok(self.skip(repo, number, "repository is not public"));
        }
        if r["archived"].as_bool() != Some(false) {
            return Ok(self.skip(repo, number, "repository is archived"));
        }
        let issue = gh.call(&Route::Issue(name.clone(), number), None)?;
        if !issue["pull_request"].is_null() {
            return Ok(self.skip(repo, number, "a pull request"));
        }
        if issue["state"].as_str() != Some("open") {
            return Ok(self.skip(repo, number, "issue is not open"));
        }
        if issue["locked"].as_bool() != Some(false) {
            return Ok(self.skip(repo, number, "issue is locked"));
        }
        if INTERNAL.contains(&issue["author_association"].as_str().unwrap_or("NONE")) {
            return Ok(self.skip(repo, number, "author is in the org"));
        }

        // Own earlier reply first (REQ-034), then an org member's answer.
        let mut member_answered = false;
        let mut complete = false;
        for page in 1..=MAX_PAGES {
            let cs = gh.call(&Route::Comments(name.clone(), number, page), None)?;
            let cs = cs.as_array().ok_or("comments: not a list")?;
            for c in cs {
                let body = c["body"].as_str().unwrap_or_default();
                if c["user"]["login"].as_str() == Some(self.bot_login.as_str()) {
                    if let Some(k) = reply::marker(body) {
                        return Ok(self.plan(
                            repo,
                            number,
                            k.outcome(),
                            Some(k),
                            false,
                            "temper already replied",
                        ));
                    }
                }
                if INTERNAL.contains(&c["author_association"].as_str().unwrap_or("NONE")) {
                    member_answered = true;
                }
            }
            if cs.len() < 100 {
                complete = true;
                break;
            }
        }
        if !complete {
            return Ok(self.skip(
                repo,
                number,
                "too many comments to rule out an earlier reply",
            ));
        }
        if member_answered {
            return Ok(self.skip(repo, number, "an org member already commented"));
        }

        let title = issue["title"].as_str().unwrap_or_default();
        let body = issue["body"].as_str().unwrap_or_default();
        let docs = self.cfg.docs_url.as_deref();
        let kind = reply::classify(title, body, docs.is_some());
        let text = reply::render(kind, docs);
        if let Err(hits) = hosts::check_outgoing(&text, &self.cfg.deny, self.home.as_deref()) {
            return Ok(self.skip(repo, number, format!("outgoing check: {hits}")));
        }
        if self.dry_run {
            return Ok(self.plan(repo, number, kind.outcome(), Some(kind), false, "dry run"));
        }
        gh.call(
            &Route::PostComment(name.clone(), number),
            Some(&json!({ "body": text })),
        )?;
        let mut reason = String::from("posted");
        if kind == Kind::AskForRepro {
            if let Some(label) = &self.cfg.ask_label {
                if let Err(e) = gh.call(
                    &Route::AddLabels(name, number),
                    Some(&json!({ "labels": [label] })),
                ) {
                    reason = format!("posted; label not added: {e}");
                }
            }
        }
        Ok(self.plan(repo, number, kind.outcome(), Some(kind), true, reason))
    }
}

/// One item's line in the run's report.
#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub repo: String,
    pub number: u64,
    pub plan: Option<Plan>,
    /// `marked`, `not-queued`, `unmarked` (dry run) or the error.
    pub done: String,
    pub error: Option<String>,
}

/// One pass: the offer, each item, the done marks (REQ-032).
pub fn run(h: &Handler, gh: &mut dyn GitHub, warte: &mut dyn Warte) -> Result<Vec<Item>, String> {
    let offer = warte.offer()?;
    let mut out = Vec::new();
    for (repo, number) in offer {
        let mut item = Item {
            plan: None,
            repo: repo.clone(),
            number,
            done: "unmarked".into(),
            error: None,
        };
        match h.handle(gh, &repo, number) {
            Err(e) => item.error = Some(e),
            Ok(p) => {
                if !h.dry_run {
                    item.done = match warte.done(&repo, number, p.outcome) {
                        Ok(true) => "marked".into(),
                        Ok(false) => "not-queued".into(),
                        Err(e) => format!("error: {e}"),
                    };
                }
                item.plan = Some(p);
            }
        }
        out.push(item);
    }
    Ok(out)
}
