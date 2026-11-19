//! Equivalence of the Rust outgoing check with pulseengine-claude
//! hooks/private_hosts.py `find()`. fixtures/private_hosts.json holds the
//! Python module's own output for each case.

use serde_json::Value;
use temper_triage::hosts::{check_outgoing, find};
use temper_triage::reply::{render, Kind};

// rivet: verifies REQ-035
#[test]
fn port_matches_the_python_module_on_every_case() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/private_hosts.json")).expect("fixture parses");
    // Fail closed on an empty side: nothing compared is not a pass.
    let with_hits = cases
        .iter()
        .filter(|c| !c["hits"].as_array().unwrap().is_empty())
        .count();
    assert!(cases.len() >= 50, "only {} cases", cases.len());
    assert!(
        with_hits >= 20 && with_hits < cases.len(),
        "{with_hits} of {} cases have hits",
        cases.len()
    );
    let mut diffs = vec![];
    for c in &cases {
        let text = c["text"].as_str().unwrap();
        let home = c["home"].as_str().unwrap();
        let got: Vec<Value> = find(text, Some(home))
            .into_iter()
            .map(|(k, v)| serde_json::json!([k, v]))
            .collect();
        if got != *c["hits"].as_array().unwrap() {
            diffs.push(format!(
                "{text:?} home={home:?}: python {} rust {:?}",
                c["hits"], got
            ));
        }
    }
    assert!(
        diffs.is_empty(),
        "{} divergence(s):\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}

// rivet: verifies REQ-035
#[test]
fn every_template_passes_and_a_planted_host_does_not() {
    let docs = "https://pulseengine.eu/";
    for k in [Kind::Acknowledge, Kind::AskForRepro, Kind::PointToDocs] {
        assert_eq!(
            check_outgoing(&render(k, Some(docs)), &[], Some("/home/svc")),
            Ok(()),
            "{k:?}"
        );
    }
    let bad = render(Kind::PointToDocs, Some("https://docs.internal.lan/x"));
    assert!(check_outgoing(&bad, &[], None).is_err());
    let deny = vec!["runner-07".to_string()];
    let err = check_outgoing("logs are on RUNNER-07 today", &deny, None).unwrap_err();
    assert!(err.starts_with("deny "), "{err}");
    assert!(!err.contains("runner-07"), "the hit is masked: {err}");
}
