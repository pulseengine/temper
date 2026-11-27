//! Shared PulseEngine README blocks: the strict variables file, the marker
//! pairs a repo places in its README, template rendering and the drift check.
//! The contract is docs/readme-blocks.md.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The one interface version this module speaks. temper accepts exactly one.
pub const INTERFACE_VERSION: u32 = 1;

/// The block names a README may mark, in contract order.
pub const BLOCKS: [&str; 5] = ["header", "badges", "part-of", "licence", "footer"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Experimental,
    Active,
    Maintained,
    Archived,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Experimental => "experimental",
            Status::Active => "active",
            Status::Maintained => "maintained",
            Status::Archived => "archived",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Badge {
    pub alt: String,
    pub image: String,
    pub href: String,
}

/// `.github/pulseengine.yaml`, format 1.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Variables {
    pub format: u32,
    pub name: String,
    pub one_liner: String,
    pub status: Status,
    pub licence: String,
    #[serde(default)]
    pub badges: Vec<Badge>,
    #[serde(default)]
    pub footer_tail: String,
}

fn safe_line(field: &str, v: &str) -> Result<(), String> {
    if v.contains('\n') || v.contains('\r') {
        return Err(format!("{field} spans more than one line"));
    }
    if v.contains("<!--") || v.contains("-->") {
        return Err(format!("{field} contains an HTML comment marker"));
    }
    Ok(())
}

fn url(field: &str, v: &str) -> Result<(), String> {
    let bad = |c: char| c.is_whitespace() || "()[]<>\"'`".contains(c);
    if !v.starts_with("https://") || v.len() <= "https://".len() || v.chars().any(bad) {
        return Err(format!(
            "{field} must be an https URL without spaces, brackets or quotes"
        ));
    }
    Ok(())
}

/// Parses and validates a variables file. Unknown, duplicate and missing keys
/// are refused by the parser; the value rules are checked here.
pub fn parse_variables(text: &str) -> Result<Variables, String> {
    let v: Variables = rivet_yaml::from_str(text).map_err(|e| e.to_string())?;
    if v.format != 1 {
        return Err(format!("format {} is not supported (expected 1)", v.format));
    }
    if v.name.is_empty()
        || !v
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err("name must be a repo name: letters, digits, '.', '_' or '-'".into());
    }
    if v.one_liner.trim().is_empty() {
        return Err("one_liner is empty".into());
    }
    safe_line("one_liner", &v.one_liner)?;
    if v.licence.is_empty()
        || !v
            .licence
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".+-() ".contains(c))
    {
        return Err("licence must be an SPDX expression".into());
    }
    safe_line("footer_tail", &v.footer_tail)?;
    for (i, b) in v.badges.iter().enumerate() {
        safe_line(&format!("badges[{i}].alt"), &b.alt)?;
        if b.alt.contains('[') || b.alt.contains(']') {
            return Err(format!("badges[{i}].alt contains a square bracket"));
        }
        url(&format!("badges[{i}].image"), &b.image)?;
        url(&format!("badges[{i}].href"), &b.href)?;
    }
    Ok(v)
}

fn html_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

/// A shields.io static-badge path segment: '-' and '_' doubled, a space as
/// '_', anything else outside the unreserved set percent-encoded.
fn shield_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'-' => o.push_str("--"),
            b'_' => o.push_str("__"),
            b' ' => o.push('_'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'~' => o.push(b as char),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

fn variable(v: &Variables, name: &str) -> Option<String> {
    Some(match name {
        "name" => v.name.clone(),
        "one_liner" => v.one_liner.clone(),
        "status" => v.status.as_str().to_string(),
        "licence" => v.licence.clone(),
        "footer_tail" => v.footer_tail.clone(),
        "badges" => v
            .badges
            .iter()
            .map(|b| format!(" [![{}]({})]({})", b.alt, b.image, b.href))
            .collect(),
        _ => return None,
    })
}

/// Renders a template. `{{var}}` inserts as written, `{{var|html}}`
/// HTML-escaped, `{{var|shield}}` as a shields.io path segment. An unknown
/// variable or filter, or an unclosed `{{`, is an error.
pub fn render(template: &str, v: &Variables) -> Result<String, String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .ok_or_else(|| "unclosed '{{' in template".to_string())?;
        let expr = &after[..end];
        let (name, filter) = match expr.split_once('|') {
            Some((n, f)) => (n, Some(f)),
            None => (expr, None),
        };
        let value =
            variable(v, name).ok_or_else(|| format!("unknown variable '{name}' in template"))?;
        match filter {
            None => out.push_str(&value),
            Some("html") => out.push_str(&html_escape(&value)),
            Some("shield") => out.push_str(&shield_escape(&value)),
            Some(f) => return Err(format!("unknown filter '{f}' in template")),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

/// One marker pair: the block name and the line indexes of its two markers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pair {
    pub name: String,
    pub open: usize,
    pub close: usize,
}

fn fence(line: &str) -> Option<(char, usize)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let t = &line[indent..];
    let c = t.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let n = t.chars().take_while(|&x| x == c).count();
    (n >= 3).then_some((c, n))
}

/// Finds the marker pairs in an LF-normalised README. Markers inside fenced
/// code blocks are ignored. Any malformed, unknown, duplicate, nested,
/// mismatched or unclosed marker makes the README unsyncable.
pub fn parse_markers(text: &str) -> Result<Vec<Pair>, String> {
    let mut pairs = Vec::new();
    let mut seen = BTreeSet::new();
    let mut open: Option<(String, usize)> = None;
    let mut in_fence: Option<(char, usize)> = None;
    for (i, line) in text.split('\n').enumerate() {
        let n = i + 1;
        if let Some((c, len)) = in_fence {
            if let Some((c2, len2)) = fence(line) {
                let tail = line.trim_start_matches(' ').trim_start_matches(c2);
                if c2 == c && len2 >= len && tail.trim().is_empty() {
                    in_fence = None;
                }
            }
            continue;
        }
        if let Some(f) = fence(line) {
            in_fence = Some(f);
            continue;
        }
        let t = line.trim();
        let closing = if t.starts_with("<!-- pulseengine:") {
            false
        } else if t.starts_with("<!-- /pulseengine:") {
            true
        } else {
            continue;
        };
        let prefix = if closing {
            "<!-- /pulseengine:"
        } else {
            "<!-- pulseengine:"
        };
        let name = line
            .strip_prefix(prefix)
            .and_then(|r| r.strip_suffix(" -->"))
            .ok_or_else(|| format!("line {n}: malformed marker"))?;
        if !BLOCKS.contains(&name) {
            return Err(format!("line {n}: unknown block '{name}'"));
        }
        match (&open, closing) {
            (None, false) => {
                if !seen.insert(name.to_string()) {
                    return Err(format!("line {n}: block '{name}' is marked twice"));
                }
                open = Some((name.to_string(), i));
            }
            (Some((o, _)), false) => {
                return Err(format!("line {n}: block '{name}' opens inside '{o}'"));
            }
            (None, true) => {
                return Err(format!("line {n}: block '{name}' closes before it opens"));
            }
            (Some((o, start)), true) => {
                if o != name {
                    return Err(format!("line {n}: '{name}' closes while '{o}' is open"));
                }
                pairs.push(Pair {
                    name: name.to_string(),
                    open: *start,
                    close: i,
                });
                open = None;
            }
        }
    }
    if let Some((o, start)) = open {
        return Err(format!("line {}: block '{o}' is never closed", start + 1));
    }
    Ok(pairs)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    Ok,
    NotApplicable,
    DivergentUndeclared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Ok,
    Drift,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlockState {
    pub name: String,
    pub state: State,
}

/// The check result. `readme` is the synced README, present only when a
/// block drifted and the README is syncable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub interface: u32,
    pub code: Code,
    pub reason: Option<String>,
    pub blocks: Vec<BlockState>,
    pub readme: Option<String>,
}

impl Report {
    fn new(code: Code, reason: Option<String>) -> Self {
        Report {
            interface: INTERFACE_VERSION,
            code,
            reason,
            blocks: Vec::new(),
            readme: None,
        }
    }
}

/// Checks a README against the rendered blocks. `template` returns a block's
/// template text. An `Err` is temper's own fault (a missing or broken
/// template), never the repo's; repo problems are a `Report`.
pub fn check(
    readme: &str,
    variables: &str,
    template: &dyn Fn(&str) -> Result<String, String>,
) -> Result<Report, String> {
    let crlf = readme.contains("\r\n");
    let text = readme.replace("\r\n", "\n");
    let pairs = match parse_markers(&text) {
        Ok(p) => p,
        Err(e) => {
            return Ok(Report::new(
                Code::DivergentUndeclared,
                Some(format!("README: {e}")),
            ))
        }
    };
    if pairs.is_empty() {
        return Ok(Report::new(
            Code::NotApplicable,
            Some("README has no pulseengine markers".into()),
        ));
    }
    let vars = match parse_variables(variables) {
        Ok(v) => v,
        Err(e) => {
            return Ok(Report::new(
                Code::DivergentUndeclared,
                Some(format!(".github/pulseengine.yaml: {e}")),
            ))
        }
    };
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    let mut report = Report::new(Code::Ok, None);
    let mut drift = false;
    let mut edits = Vec::new();
    for p in &pairs {
        let tpl = template(&p.name)?;
        let rendered = render(&tpl, &vars).map_err(|e| format!("template {}: {e}", p.name))?;
        let want: Vec<String> = rendered
            .strip_suffix('\n')
            .unwrap_or(&rendered)
            .split('\n')
            .map(str::to_string)
            .collect();
        let have = &lines[p.open + 1..p.close];
        let state = if have == want.as_slice() {
            State::Ok
        } else {
            drift = true;
            edits.push((p.open, p.close, want));
            State::Drift
        };
        report.blocks.push(BlockState {
            name: p.name.clone(),
            state,
        });
    }
    if drift {
        report.code = Code::DivergentUndeclared;
        report.reason = Some("a shared block differs from its template".into());
        for (open, close, want) in edits.into_iter().rev() {
            lines.splice(open + 1..close, want);
        }
        let synced = lines.join("\n");
        report.readme = Some(if crlf {
            synced.replace('\n', "\r\n")
        } else {
            synced
        });
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VARS: &str = "format: 1\nname: zwinger\none_liner: \"Confines an agent.\"\nstatus: active\nlicence: MIT\n";

    fn tpl(name: &str) -> Result<String, String> {
        Ok(match name {
            "footer" => "Part of PulseEngine{{footer_tail|html}}\n".into(),
            "licence" => "{{licence}}. Issues and pull requests are welcome.\n".into(),
            "header" => "# {{name}}\n\n{{one_liner}}\n".into(),
            other => return Err(format!("no template {other}")),
        })
    }

    #[test]
    fn variables_accept_the_minimal_file() {
        let v = parse_variables(VARS).unwrap();
        assert_eq!(v.name, "zwinger");
        assert_eq!(v.status, Status::Active);
        assert!(v.badges.is_empty());
        assert_eq!(v.footer_tail, "");
    }

    #[test]
    fn variables_refuse_unknown_duplicate_missing_and_bad_values() {
        for (bad, why) in [
            (format!("{VARS}docs: []\n"), "unknown key"),
            (format!("{VARS}name: other\n"), "duplicate key"),
            (VARS.replace("licence: MIT\n", ""), "missing licence"),
            (VARS.replace("format: 1", "format: 2"), "format 2"),
            (VARS.replace("active", "dormant"), "unknown status"),
            (VARS.replace("zwinger", "zw inger"), "name with space"),
            (
                VARS.replace("\"Confines an agent.\"", "\"\""),
                "empty one_liner",
            ),
            (
                VARS.replace("Confines an agent.", "a <!-- b"),
                "comment in one_liner",
            ),
            (
                VARS.replace("licence: MIT", "licence: \"MIT<\""),
                "licence char",
            ),
            (format!("{VARS}footer_tail: \"x -->\"\n"), "comment in tail"),
            (
                format!("{VARS}badges: [{{alt: a, image: \"http://x\", href: \"https://y\"}}]\n"),
                "http image",
            ),
            (
                format!(
                    "{VARS}badges: [{{alt: a, image: \"https://x\", href: \"https://y z\"}}]\n"
                ),
                "space in href",
            ),
            (
                format!(
                    "{VARS}badges: [{{alt: \"a]\", image: \"https://x\", href: \"https://y\"}}]\n"
                ),
                "bracket in alt",
            ),
            (
                format!(
                    "{VARS}badges: [{{alt: a, image: \"https://x\", href: \"https://y\", x: 1}}]\n"
                ),
                "unknown badge key",
            ),
            (
                format!("{VARS}badges: [{{alt: a, image: \"https://\", href: \"https://y\"}}]\n"),
                "bare scheme",
            ),
        ] {
            assert!(parse_variables(&bad).is_err(), "accepted: {why}");
        }
    }

    #[test]
    fn variables_refuse_multi_line_values_and_accept_a_plain_badge() {
        for nl in ["\\n", "\\r"] {
            let bad = VARS.replace("Confines an agent.", &format!("a{nl}b"));
            assert!(parse_variables(&bad).is_err(), "accepted {nl}");
        }
        let ok = format!(
            "{VARS}badges: [{{alt: ci, image: \"https://i.example/b.svg\", href: \"https://h\"}}]\n"
        );
        assert_eq!(parse_variables(&ok).unwrap().badges.len(), 1);
    }

    #[test]
    fn fences_follow_commonmark_indent_length_and_char() {
        let m = "<!-- pulseengine:footer -->\n<!-- /pulseengine:footer -->\n";
        // Up to three spaces open a fence; the markers inside are ignored.
        assert!(parse_markers(&format!("   ```\n{m}```\n"))
            .unwrap()
            .is_empty());
        // Four spaces do not open a fence; the markers count.
        assert_eq!(parse_markers(&format!("    ```\n{m}")).unwrap().len(), 1);
        // A fence closes only on the same char, at least as long, bare.
        for close in ["``", "~~~", "``` x"] {
            let t = format!("```\n{close}\n{m}```\n");
            assert!(parse_markers(&t).unwrap().is_empty(), "closed by {close}");
        }
        assert_eq!(parse_markers(&format!("```\n````\n{m}")).unwrap().len(), 1);
    }

    #[test]
    fn marker_errors_name_the_line() {
        let e = parse_markers("a\nb\n<!-- pulseengine:nope -->\n").unwrap_err();
        assert!(e.starts_with("line 3: "), "{e}");
    }

    #[test]
    fn render_substitutes_escapes_and_refuses_unknowns() {
        let mut v = parse_variables(VARS).unwrap();
        v.footer_tail = ", <proofs> & \"more\"'".into();
        assert_eq!(
            render("x{{footer_tail|html}}", &v).unwrap(),
            "x, &lt;proofs&gt; &amp; &quot;more&quot;&#39;"
        );
        v.licence = "Apache-2.0 OR MIT_X (y)".into();
        assert_eq!(
            render("{{licence|shield}}", &v).unwrap(),
            "Apache--2.0_OR_MIT__X_%28y%29"
        );
        assert_eq!(render("{{status}}", &v).unwrap(), "active");
        v.badges = vec![Badge {
            alt: "ci".into(),
            image: "https://i".into(),
            href: "https://h".into(),
        }];
        assert_eq!(
            render("a{{badges}}", &v).unwrap(),
            "a [![ci](https://i)](https://h)"
        );
        assert!(render("{{nope}}", &v).is_err());
        assert!(render("{{name|upper}}", &v).is_err());
        assert!(render("{{name", &v).is_err());
        assert_eq!(render("no vars", &v).unwrap(), "no vars");
    }

    #[test]
    fn markers_parse_pairs_and_skip_fences() {
        let t = "a\n<!-- pulseengine:footer -->\nx\n<!-- /pulseengine:footer -->\n```\n<!-- pulseengine:header -->\n```\n~~~~\n<!-- bogus pulseengine -->\n<!-- /pulseengine:licence -->\n~~~~\n";
        let p = parse_markers(t).unwrap();
        assert_eq!(
            p,
            vec![Pair {
                name: "footer".into(),
                open: 1,
                close: 3
            }]
        );
    }

    #[test]
    fn markers_refuse_every_broken_shape() {
        for (bad, why) in [
            ("<!-- pulseengine:nope -->\n<!-- /pulseengine:nope -->", "unknown"),
            ("<!-- pulseengine:footer -->\n<!-- /pulseengine:footer -->\n<!-- pulseengine:footer -->\n<!-- /pulseengine:footer -->", "duplicate"),
            ("<!-- pulseengine:footer -->\n<!-- pulseengine:header -->\n<!-- /pulseengine:header -->\n<!-- /pulseengine:footer -->", "nested"),
            ("<!-- /pulseengine:footer -->\n<!-- pulseengine:footer -->", "close first"),
            ("<!-- pulseengine:footer -->\nx", "unclosed"),
            ("<!-- pulseengine:footer -->\n<!-- /pulseengine:header -->", "mismatch"),
            ("<!-- pulseengine:footer-->\n", "no space"),
            ("  <!-- pulseengine:footer -->\n<!-- /pulseengine:footer -->", "indented"),
            ("<!-- pulseengine: -->\n", "empty name"),
            ("<!-- pulseengine:footer --> x\n", "trailing text"),
        ] {
            assert!(parse_markers(bad).is_err(), "accepted: {why}");
        }
    }

    #[test]
    fn check_reports_ok_when_blocks_match() {
        let readme = "intro\n<!-- pulseengine:licence -->\nMIT. Issues and pull requests are welcome.\n<!-- /pulseengine:licence -->\n";
        let r = check(readme, VARS, &tpl).unwrap();
        assert_eq!(r.code, Code::Ok);
        assert_eq!(r.readme, None);
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(r.blocks[0].state, State::Ok);
    }

    #[test]
    fn check_syncs_drifted_blocks_and_leaves_the_rest() {
        let readme = "<!-- pulseengine:header -->\n# old\n<!-- /pulseengine:header -->\nmine\n<!-- pulseengine:footer -->\n<!-- /pulseengine:footer -->\nend";
        let r = check(readme, VARS, &tpl).unwrap();
        assert_eq!(r.code, Code::DivergentUndeclared);
        assert_eq!(
            r.readme.as_deref(),
            Some("<!-- pulseengine:header -->\n# zwinger\n\nConfines an agent.\n<!-- /pulseengine:header -->\nmine\n<!-- pulseengine:footer -->\nPart of PulseEngine\n<!-- /pulseengine:footer -->\nend")
        );
        assert!(r.blocks.iter().all(|b| b.state == State::Drift));
        // The synced README checks clean.
        let again = check(r.readme.as_deref().unwrap(), VARS, &tpl).unwrap();
        assert_eq!(again.code, Code::Ok);
    }

    #[test]
    fn check_keeps_crlf_line_endings() {
        let readme = "a\r\n<!-- pulseengine:footer -->\r\nold\r\n<!-- /pulseengine:footer -->\r\n";
        let r = check(readme, VARS, &tpl).unwrap();
        assert_eq!(
            r.readme.as_deref(),
            Some("a\r\n<!-- pulseengine:footer -->\r\nPart of PulseEngine\r\n<!-- /pulseengine:footer -->\r\n")
        );
        let ok = check(r.readme.as_deref().unwrap(), VARS, &tpl).unwrap();
        assert_eq!(ok.code, Code::Ok);
    }

    #[test]
    fn check_codes_for_out_of_scope_and_unsyncable() {
        let none = check("just text\n", "not: [yaml", &tpl).unwrap();
        assert_eq!(none.code, Code::NotApplicable);
        let broken = check("<!-- pulseengine:footer -->\n", VARS, &tpl).unwrap();
        assert_eq!(broken.code, Code::DivergentUndeclared);
        assert!(broken.reason.unwrap().starts_with("README: "));
        assert_eq!(broken.readme, None);
        let badvars = check(
            "<!-- pulseengine:footer -->\n<!-- /pulseengine:footer -->\n",
            "format: 1\n",
            &tpl,
        )
        .unwrap();
        assert_eq!(badvars.code, Code::DivergentUndeclared);
        assert!(badvars
            .reason
            .unwrap()
            .starts_with(".github/pulseengine.yaml: "));
        assert_eq!(badvars.readme, None);
    }

    #[test]
    fn check_fails_on_temper_template_faults() {
        let readme = "<!-- pulseengine:badges -->\n<!-- /pulseengine:badges -->\n";
        assert!(check(readme, VARS, &tpl).is_err());
        let bad = |_: &str| Ok::<_, String>("{{nope}}".to_string());
        assert!(check(readme, VARS, &bad).is_err());
    }
}
