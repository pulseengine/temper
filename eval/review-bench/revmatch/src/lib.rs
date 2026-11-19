//! revmatch: score review findings against a reference (temper#92 PREREG).
//!
//! Location: (file, new-side line). A finding's line is where its
//! quoted_line occurs on the new side of that file's diff, normalised as
//! temper's normaliseForQuote; the occurrence nearest the stated line wins;
//! a quote that does not occur keeps the stated line.
//! Primary match: same file, |dl| <= TOL, same class. Secondary: any class.
//! One-to-one, greedy by smallest |dl|.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const TOL: i64 = 3;

pub const CLASSES: &[&str] = &[
    "logic",
    "error-handling",
    "security",
    "concurrency",
    "resource",
    "api-contract",
    "test-gap",
    "vacuous-check",
    "config-ci",
    "docs-mismatch",
];

/// One new-side line of a diff.
#[derive(Debug, Clone, PartialEq)]
pub struct NewLine {
    pub line: i64,
    pub text: String,
    pub added: bool,
}

/// New-side lines per file (the b/ path), from a unified diff.
pub fn parse_diff(diff: &str) -> BTreeMap<String, Vec<NewLine>> {
    let mut out: BTreeMap<String, Vec<NewLine>> = BTreeMap::new();
    let mut file: Option<String> = None;
    let mut next: i64 = 0;
    let mut in_hunk = false;
    for raw in diff.split('\n') {
        let l = raw.strip_suffix('\r').unwrap_or(raw);
        if l.starts_with("diff --git ") {
            file = l.rsplit_once(" b/").map(|(_, b)| b.to_string());
            in_hunk = false;
            continue;
        }
        if !in_hunk && l.starts_with("+++ ") {
            if l == "+++ /dev/null" {
                file = None;
            } else if let Some(p) = l.strip_prefix("+++ b/") {
                file = Some(p.to_string());
            }
            continue;
        }
        if let Some(rest) = l.strip_prefix("@@ ") {
            // @@ -a,b +c,d @@
            let plus = rest.split(' ').find(|t| t.starts_with('+'));
            next = plus
                .and_then(|t| t[1..].split(',').next())
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            in_hunk = file.is_some();
            continue;
        }
        if !in_hunk {
            continue;
        }
        let Some(f) = file.clone() else { continue };
        match l.chars().next() {
            Some('+') => {
                out.entry(f).or_default().push(NewLine {
                    line: next,
                    text: l[1..].to_string(),
                    added: true,
                });
                next += 1;
            }
            Some(' ') => {
                out.entry(f).or_default().push(NewLine {
                    line: next,
                    text: l[1..].to_string(),
                    added: false,
                });
                next += 1;
            }
            Some('-') | Some('\\') => {}
            None => {
                // an empty context line whose leading space was stripped
                out.entry(f).or_default().push(NewLine {
                    line: next,
                    text: String::new(),
                    added: false,
                });
                next += 1;
            }
            _ => in_hunk = false,
        }
    }
    out
}

/// temper's normaliseForQuote, for one line.
pub fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The first non-empty normalised line of a quote.
fn quote_key(q: &str) -> String {
    q.split('\n')
        .map(norm)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Finding {
    pub file: Option<String>,
    pub line: Option<i64>,
    #[serde(default)]
    pub quoted_line: Option<String>,
    #[serde(default)]
    pub class: Option<String>,
    #[serde(default)]
    pub anchored: Option<bool>,
    #[serde(default)]
    pub claim: Option<String>,
    #[serde(default)]
    pub evidence: Option<String>,
}

/// Resolve a finding's line through its quote (PREREG "Matching").
pub fn resolve(f: &Finding, diff: &BTreeMap<String, Vec<NewLine>>) -> Option<(String, i64)> {
    let file = f.file.clone()?;
    let stated = f.line;
    let key = f.quoted_line.as_deref().map(quote_key).unwrap_or_default();
    if !key.is_empty() {
        if let Some(lines) = diff.get(&file) {
            let hits: Vec<i64> = lines
                .iter()
                .filter(|l| norm(&l.text).contains(&key))
                .map(|l| l.line)
                .collect();
            if !hits.is_empty() {
                let best = match stated {
                    Some(s) => *hits.iter().min_by_key(|h| (*h - s).abs()).unwrap(),
                    None => hits[0],
                };
                return Some((file, best));
            }
        }
    }
    stated.map(|s| (file, s))
}

/// Pairs (candidate index, reference index), greedy by smallest |dl|.
pub fn match_findings(
    cands: &[(String, i64, String)],
    refs: &[(String, i64, String)],
    same_class: bool,
) -> Vec<(usize, usize)> {
    let mut pairs: Vec<(i64, usize, usize)> = Vec::new();
    for (i, c) in cands.iter().enumerate() {
        for (j, r) in refs.iter().enumerate() {
            let dl = (c.1 - r.1).abs();
            if c.0 == r.0 && dl <= TOL && (!same_class || c.2 == r.2) {
                pairs.push((dl, i, j));
            }
        }
    }
    pairs.sort();
    let (mut ci, mut rj) = (vec![false; cands.len()], vec![false; refs.len()]);
    let mut out = Vec::new();
    for (_, i, j) in pairs {
        if !ci[i] && !rj[j] {
            ci[i] = true;
            rj[j] = true;
            out.push((i, j));
        }
    }
    out
}

/// Validation of a reference or known file against its diff: every anchored
/// finding's quote must be on an added line of that file at its stated line.
pub fn validate(findings: &[Finding], diff: &BTreeMap<String, Vec<NewLine>>) -> Vec<String> {
    let mut errs = Vec::new();
    for (i, f) in findings.iter().enumerate() {
        if f.anchored == Some(false) {
            continue;
        }
        let (Some(file), Some(line), Some(q)) = (&f.file, f.line, &f.quoted_line) else {
            errs.push(format!("#{i}: file, line and quoted_line are required"));
            continue;
        };
        if let Some(c) = &f.class {
            if !CLASSES.contains(&c.as_str()) {
                errs.push(format!("#{i}: class {c:?} is not in the list"));
            }
        }
        let Some(lines) = diff.get(file) else {
            errs.push(format!("#{i}: {file} is not in the diff"));
            continue;
        };
        let key = quote_key(q);
        match lines.iter().find(|l| l.line == line) {
            Some(l) if l.added && norm(&l.text).contains(&key) => {}
            Some(l) if !l.added => errs.push(format!(
                "#{i}: {file}:{line} is a context line, not an added one"
            )),
            _ => {
                let at: Vec<i64> = lines
                    .iter()
                    .filter(|l| l.added && norm(&l.text).contains(&key))
                    .map(|l| l.line)
                    .collect();
                errs.push(format!(
                    "#{i}: {file}:{line} does not carry the quote; it is on added line(s) {at:?}"
                ));
            }
        }
    }
    errs
}
