use revmatch::{match_findings, parse_diff, resolve, validate, Finding};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "\
revmatch: score AI-review findings against a reference (file, line +-3, class)

Usage:
  revmatch validate <diff.patch> <findings.json>
  revmatch score --prs <dir> (--run <dir> | --reference) [--format json]

validate   Check that each anchored finding quotes an added line at its stated line
score      Recall, known-defect recall, false findings, format failures, latency
";

fn read_json(p: &Path) -> Result<Value, String> {
    let s = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
    serde_json::from_str(&s).map_err(|e| format!("{}: {e}", p.display()))
}

fn findings(v: &Value, key: &str) -> Result<Vec<Finding>, String> {
    serde_json::from_value(v.get(key).cloned().unwrap_or(json!([])))
        .map_err(|e| format!("{key}: {e}"))
}

fn main() -> ExitCode {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.iter().any(|x| x == "-h" || x == "--help") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if a.iter().any(|x| x == "-V" || x == "--version") {
        println!("revmatch {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let r = match a.first().map(String::as_str) {
        Some("validate") if a.len() == 3 => cmd_validate(&a[1], &a[2]),
        Some("score") => cmd_score(&a[1..]),
        _ => {
            eprint!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match r {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("revmatch: {e}");
            ExitCode::FAILURE
        }
    }
}

fn cmd_validate(diff: &str, file: &str) -> Result<bool, String> {
    let d = parse_diff(&std::fs::read_to_string(diff).map_err(|e| format!("{diff}: {e}"))?);
    let v = read_json(Path::new(file))?;
    let key = if v.get("defects").is_some() {
        "defects"
    } else {
        "findings"
    };
    let fs = findings(&v, key)?;
    let errs = validate(&fs, &d);
    for e in &errs {
        println!("{file} {e}");
    }
    println!("{file}: {} finding(s), {} error(s)", fs.len(), errs.len());
    Ok(errs.is_empty())
}

fn pct(n: usize, d: usize) -> Value {
    if d == 0 {
        Value::Null
    } else {
        json!((n as f64 / d as f64 * 1000.0).round() / 1000.0)
    }
}

fn quantile(v: &mut [f64], q: f64) -> Value {
    if v.is_empty() {
        return Value::Null;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let idx = ((v.len() as f64 - 1.0) * q).round() as usize;
    json!(v[idx])
}

type Loc = (String, i64, String);

fn locs(
    fs: &[Finding],
    d: &std::collections::BTreeMap<String, Vec<revmatch::NewLine>>,
) -> Vec<Loc> {
    fs.iter()
        .filter(|f| f.anchored != Some(false))
        .filter_map(|f| {
            resolve(f, d)
                .map(|(file, l)| (file, l, f.class.clone().unwrap_or_else(|| "none".into())))
        })
        .collect()
}

/// The claims of the findings `locs` keeps, in the same order.
fn claims(
    fs: &[Finding],
    d: &std::collections::BTreeMap<String, Vec<revmatch::NewLine>>,
) -> Vec<String> {
    fs.iter()
        .filter(|f| f.anchored != Some(false))
        .filter(|f| resolve(f, d).is_some())
        .map(|f| {
            f.claim
                .clone()
                .or_else(|| f.evidence.clone())
                .unwrap_or_default()
        })
        .collect()
}

fn cmd_score(a: &[String]) -> Result<bool, String> {
    let mut prs: Option<PathBuf> = None;
    let mut run: Option<PathBuf> = None;
    let (mut reference, mut as_json, mut explain) = (false, false, false);
    let mut it = a.iter();
    while let Some(x) = it.next() {
        match x.as_str() {
            "--prs" => prs = it.next().map(PathBuf::from),
            "--run" => run = it.next().map(PathBuf::from),
            "--reference" => reference = true,
            "--explain" => explain = true,
            "--format" => as_json = it.next().map(String::as_str) == Some("json"),
            o => return Err(format!("unknown argument {o}")),
        }
    }
    let prs = prs.ok_or("--prs is required")?;
    if run.is_none() && !reference {
        return Err("give --run <dir> or --reference".into());
    }
    let mut folders: Vec<PathBuf> = std::fs::read_dir(&prs)
        .map_err(|e| format!("{}: {e}", prs.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("diff.patch").is_file())
        .collect();
    folders.sort();
    if folders.is_empty() {
        return Err("no PR folders with diff.patch: nothing compared is not a pass".into());
    }

    let (mut ref_total, mut mp, mut ms, mut known_total, mut kp, mut ks) = (0, 0, 0, 0, 0, 0);
    let (mut cand_total, mut false_total, mut fmt_fail, mut missing, mut dropped) =
        (0, 0, 0, 0, 0u64);
    let mut lat: Vec<f64> = Vec::new();
    let mut per_pr = Vec::new();
    for f in &folders {
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        let d =
            parse_diff(&std::fs::read_to_string(f.join("diff.patch")).map_err(|e| e.to_string())?);
        let refs = locs(
            &findings(&read_json(&f.join("reference.json"))?, "findings")?,
            &d,
        );
        let known = match read_json(&f.join("known.json")) {
            Ok(v) => locs(&findings(&v, "defects")?, &d),
            Err(_) => vec![],
        };
        let ref_fs = findings(&read_json(&f.join("reference.json"))?, "findings")?;
        let known_fs = match read_json(&f.join("known.json")) {
            Ok(v) => findings(&v, "defects")?,
            Err(_) => vec![],
        };
        let mut cand_claims: Vec<String> = claims(&ref_fs, &d);
        let (cands, ok) = if reference {
            (refs.clone(), true)
        } else {
            let p = run.as_ref().unwrap().join(format!("{name}.json"));
            match read_json(&p) {
                Err(_) => {
                    missing += 1;
                    (vec![], false)
                }
                Ok(v) => {
                    if let Some(ms) = v.get("latency_ms").and_then(Value::as_f64) {
                        lat.push(ms / 1000.0);
                    }
                    dropped += v.get("dropped").and_then(Value::as_u64).unwrap_or(0);
                    let ok = v.get("ok").and_then(Value::as_bool) == Some(true);
                    if !ok {
                        fmt_fail += 1;
                    }
                    let kept = findings(&v, "kept")?;
                    cand_claims = claims(&kept, &d);
                    (locs(&kept, &d), ok)
                }
            }
        };
        let p = match_findings(&cands, &refs, true);
        let s = match_findings(&cands, &refs, false);
        let kpm = match_findings(&cands, &known, true).len();
        let ksm = match_findings(&cands, &known, false).len();
        let fals = cands.len() - s.len();
        if explain {
            let show = |what: &str, pairs: Vec<(usize, usize)>, other: &[Loc], oc: &[String]| {
                for (i, j) in pairs {
                    println!(
                        "{name} {what} {}:{}~{} [{} vs {}]",
                        cands[i].0, cands[i].1, other[j].1, cands[i].2, other[j].2
                    );
                    println!(
                        "   cand: {}",
                        cand_claims.get(i).map(String::as_str).unwrap_or("")
                    );
                    println!("   ref:  {}", oc.get(j).map(String::as_str).unwrap_or(""));
                }
            };
            show("reference", s.clone(), &refs, &claims(&ref_fs, &d));
            show(
                "known",
                match_findings(&cands, &known, false),
                &known,
                &claims(&known_fs, &d),
            );
        }
        ref_total += refs.len();
        mp += p.len();
        ms += s.len();
        known_total += known.len();
        kp += kpm;
        ks += ksm;
        cand_total += cands.len();
        false_total += fals;
        per_pr.push(
            json!({"pr": name, "ok": ok, "reference": refs.len(), "candidates": cands.len(),
            "primary": p.len(), "secondary": s.len(), "false": fals, "known": known.len(),
            "known_primary": kpm, "known_secondary": ksm}),
        );
    }
    if ref_total == 0 {
        return Err("the reference has no anchored findings: recall has no denominator".into());
    }
    let n = folders.len();
    let out = json!({
        "prs": n, "missing_runs": missing,
        "reference_findings": ref_total, "candidate_findings": cand_total,
        "recall_primary": pct(mp, ref_total), "recall_secondary": pct(ms, ref_total),
        "matched_primary": mp, "matched_secondary": ms,
        "known_anchored": known_total, "known_recall_primary": pct(kp, known_total),
        "known_recall_secondary": pct(ks, known_total),
        "false_findings": false_total, "false_per_pr": (false_total as f64 / n as f64 * 100.0).round() / 100.0,
        "format_failures": fmt_fail, "dropped_by_filter": dropped,
        "latency_s_median": quantile(&mut lat.clone(), 0.5), "latency_s_p90": quantile(&mut lat, 0.9),
        "per_pr": per_pr,
    });
    if as_json {
        println!("{out}");
    } else {
        println!(
            "recall primary {mp}/{ref_total} secondary {ms}/{ref_total} | known {kp}/{known_total} (any class {ks}) | false {false_total} in {n} PRs | format failures {fmt_fail}/{n} | missing {missing} | median {} s p90 {} s",
            out["latency_s_median"], out["latency_s_p90"]
        );
    }
    Ok(missing == 0)
}
