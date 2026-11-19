use revmatch::{match_findings, parse_diff, resolve, validate, Finding};

const DIFF: &str = "\
diff --git a/src/a.rs b/src/a.rs
index 1..2 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -10,4 +10,6 @@ fn f() {
     let x = 1;
-    let y = 2;
+    let y = 3;
+    let z = y;

     x + y
@@ -40,2 +42,3 @@
     a();
+    let z = y;
     b();
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
";

fn f(file: &str, line: i64, q: &str, class: &str) -> Finding {
    Finding {
        file: Some(file.into()),
        line: Some(line),
        quoted_line: Some(q.into()),
        class: Some(class.into()),
        anchored: None,
        claim: None,
        evidence: None,
    }
}

#[test]
fn hunk_arithmetic_and_deleted_files() {
    let d = parse_diff(DIFF);
    let a = &d["src/a.rs"];
    let added: Vec<(i64, &str)> = a
        .iter()
        .filter(|l| l.added)
        .map(|l| (l.line, l.text.as_str()))
        .collect();
    assert_eq!(
        added,
        vec![
            (11, "    let y = 3;"),
            (12, "    let z = y;"),
            (43, "    let z = y;")
        ]
    );
    // the empty context line counts
    assert!(a
        .iter()
        .any(|l| l.line == 13 && !l.added && l.text.is_empty()));
    assert!(!d.contains_key("old.txt"));
}

#[test]
fn quote_resolves_to_nearest_occurrence_else_stated_line() {
    let d = parse_diff(DIFF);
    assert_eq!(
        resolve(&f("src/a.rs", 40, "let z = y;", "logic"), &d),
        Some(("src/a.rs".into(), 43))
    );
    assert_eq!(
        resolve(&f("src/a.rs", 5, "let  z =   y;", "logic"), &d),
        Some(("src/a.rs".into(), 12))
    );
    assert_eq!(
        resolve(&f("src/a.rs", 99, "not in the diff", "logic"), &d),
        Some(("src/a.rs".into(), 99))
    );
}

#[test]
fn primary_needs_class_secondary_does_not_and_matching_is_one_to_one() {
    let refs = vec![
        ("a".to_string(), 10, "logic".to_string()),
        ("a".to_string(), 12, "test-gap".to_string()),
    ];
    let cands = vec![
        ("a".to_string(), 11, "logic".to_string()),
        ("a".to_string(), 11, "logic".to_string()),
        ("a".to_string(), 14, "security".to_string()),
        ("b".to_string(), 10, "logic".to_string()),
    ];
    assert_eq!(match_findings(&cands, &refs, true).len(), 1);
    assert_eq!(match_findings(&cands, &refs, false).len(), 2);
    // tolerance is 3 lines, inclusive
    let far = vec![("a".to_string(), 14, "logic".to_string())];
    assert_eq!(match_findings(&far, &refs[..1], true).len(), 0);
    let edge = vec![("a".to_string(), 13, "logic".to_string())];
    assert_eq!(match_findings(&edge, &refs[..1], true).len(), 1);
}

#[test]
fn validate_flags_context_lines_wrong_lines_and_unknown_classes() {
    let d = parse_diff(DIFF);
    assert!(validate(&[f("src/a.rs", 11, "let y = 3;", "logic")], &d).is_empty());
    assert_eq!(
        validate(&[f("src/a.rs", 10, "let x = 1;", "logic")], &d).len(),
        1
    );
    assert_eq!(
        validate(&[f("src/a.rs", 13, "let y = 3;", "logic")], &d).len(),
        1
    );
    assert_eq!(
        validate(&[f("src/a.rs", 11, "let y = 3;", "style")], &d).len(),
        1
    );
    let mut un = f("x", 1, "", "logic");
    un.anchored = Some(false);
    assert!(validate(&[un], &d).is_empty());
}
