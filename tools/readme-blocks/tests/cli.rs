//! Runs the built binary against temper's real templates/readme.

use std::path::{Path, PathBuf};
use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_readme-blocks"))
}

fn templates() -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../templates/readme");
    p.to_str().unwrap().to_string()
}

fn scratch(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    for (f, body) in files {
        std::fs::write(d.join(f), body).unwrap();
    }
    d
}

const VARS: &str =
    "format: 1\nname: zwinger\none_liner: \"Confines an agent.\"\nstatus: active\nlicence: MIT\n";

fn run_check(d: &Path) -> (i32, String) {
    let o = bin()
        .args(["check", "--format", "json", "--variables"])
        .arg(d.join("vars.yaml"))
        .arg("--readme")
        .arg(d.join("README.md"))
        .args(["--templates", &templates()])
        .output()
        .unwrap();
    (
        o.status.code().unwrap(),
        String::from_utf8(o.stdout).unwrap(),
    )
}

#[test]
fn cli_conventions() {
    let v = bin().arg("--version").output().unwrap();
    assert!(v.status.success());
    assert_eq!(
        String::from_utf8(v.stdout).unwrap().trim(),
        format!("readme-blocks {}", env!("CARGO_PKG_VERSION"))
    );
    assert!(bin().arg("--help").status().unwrap().success());
    assert_eq!(
        bin().arg("--no-such-flag").status().unwrap().code(),
        Some(2)
    );
    assert_eq!(bin().status().unwrap().code(), Some(2));
    assert_eq!(
        bin()
            .args(["check", "--format", "xml"])
            .status()
            .unwrap()
            .code(),
        Some(2)
    );
    let iv = bin().arg("interface-version").output().unwrap();
    assert_eq!(String::from_utf8(iv.stdout).unwrap().trim(), "1");
}

#[test]
fn zwinger_licence_line_matches_the_template() {
    // zwinger's hand-written line today; adopting the block must be a no-op.
    let d = scratch(
        "zwinger",
        &[
            ("vars.yaml", VARS),
            (
                "README.md",
                "## Licence\n\n<!-- pulseengine:licence -->\nMIT. Issues and pull requests are welcome.\n<!-- /pulseengine:licence -->\n",
            ),
        ],
    );
    let (rc, out) = run_check(&d);
    assert_eq!(rc, 0);
    let j: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(j["interface"], 1);
    assert_eq!(j["code"], "ok");
    assert!(j["readme"].is_null());
}

#[test]
fn empty_pairs_get_every_real_template() {
    let mut readme = String::new();
    for b in ["header", "badges", "part-of", "licence", "footer"] {
        readme.push_str(&format!(
            "<!-- pulseengine:{b} -->\n<!-- /pulseengine:{b} -->\n"
        ));
    }
    let d = scratch(
        "all",
        &[
            (
                "vars.yaml",
                &format!("{VARS}footer_tail: \", with proofs & more\"\n"),
            ),
            ("README.md", &readme),
        ],
    );
    let (rc, out) = run_check(&d);
    assert_eq!(rc, 0);
    let j: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(j["code"], "divergent_undeclared");
    let synced = j["readme"].as_str().unwrap();
    assert!(synced.contains("# zwinger\n\nConfines an agent.\n"));
    assert!(synced.contains("https://img.shields.io/badge/status-active-informational"));
    assert!(
        synced.contains("zwinger is part of [PulseEngine](https://pulseengine.eu/how-it-works/)")
    );
    assert!(synced.contains("safety-critical systems, with proofs &amp; more</sub>"));
    // Feeding the synced README back reports ok.
    std::fs::write(d.join("README.md"), synced).unwrap();
    let (rc2, out2) = run_check(&d);
    assert_eq!(rc2, 0);
    let j2: serde_json::Value = serde_json::from_str(&out2).unwrap();
    assert_eq!(j2["code"], "ok");
}

#[test]
fn unreadable_input_exits_1() {
    let d = scratch("missing", &[("vars.yaml", VARS)]);
    let (rc, out) = run_check(&d);
    assert_eq!(rc, 1);
    assert!(out.is_empty());
}
