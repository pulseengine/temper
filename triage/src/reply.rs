//! Reply kinds, the classifier that picks one, and the compiled-in templates.
//!
//! Issue text is data: it reaches only `classify`, which returns one of three
//! kinds. No issue text, title, login or repository name is ever placed in a
//! reply; the only interpolated value is the deploy's `docs_url`.

use serde::Serialize;

/// The only replies temper-triage can post.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Acknowledge,
    AskForRepro,
    PointToDocs,
}

/// What warte is told: `replied`, `asked` or `skipped`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Replied,
    Asked,
    Skipped,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Replied => "replied",
            Outcome::Asked => "asked",
            Outcome::Skipped => "skipped",
        }
    }
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Acknowledge => "acknowledge",
            Kind::AskForRepro => "ask-for-repro",
            Kind::PointToDocs => "point-to-docs",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        [Kind::Acknowledge, Kind::AskForRepro, Kind::PointToDocs]
            .into_iter()
            .find(|k| k.as_str() == s)
    }

    pub fn outcome(self) -> Outcome {
        match self {
            Kind::AskForRepro => Outcome::Asked,
            Kind::Acknowledge | Kind::PointToDocs => Outcome::Replied,
        }
    }
}

/// Bodies longer than this are classified on their first 64 KiB.
const MAX_SCAN: usize = 64 * 1024;

const BUG_WORDS: &[&str] = &[
    "bug",
    "crash",
    "panic",
    "error",
    "fail",
    "broken",
    "regression",
    "doesn't work",
    "does not work",
    "not working",
    "segfault",
    "exception",
];
const QUESTION_STARTS: &[&str] = &[
    "how ", "what ", "why ", "where ", "when ", "which ", "can ", "could ", "is there", "does ",
    "do ", "should ",
];

fn cut(s: &str) -> &str {
    if s.len() <= MAX_SCAN {
        return s;
    }
    let mut end = MAX_SCAN;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Does the body carry something a maintainer can reproduce from?
fn has_repro(body: &str) -> bool {
    if body.contains("```") || body.contains("reproduc") || body.contains("steps") {
        return true;
    }
    // a version-shaped token: digits '.' digits
    let b = body.as_bytes();
    (1..b.len().saturating_sub(1))
        .any(|i| b[i] == b'.' && b[i - 1].is_ascii_digit() && b[i + 1].is_ascii_digit())
}

/// Pick a reply kind. Pure; the title and body are data.
pub fn classify(title: &str, body: &str, have_docs: bool) -> Kind {
    let title = cut(title).to_lowercase();
    let body = cut(body).to_lowercase();
    let both = format!("{title}\n{body}");
    if BUG_WORDS.iter().any(|w| both.contains(w)) {
        return if has_repro(&body) {
            Kind::Acknowledge
        } else {
            Kind::AskForRepro
        };
    }
    let t = title.trim();
    let question = t.ends_with('?')
        || QUESTION_STARTS.iter().any(|q| t.starts_with(q))
        || both.contains("how do i")
        || both.contains("how to ");
    if question && have_docs {
        Kind::PointToDocs
    } else {
        Kind::Acknowledge
    }
}

pub const MARKER_PREFIX: &str = "<!-- temper-triage:v1 kind=";

const FOOTER: &str = "<sub>First reply by temper, this organisation's automation. \
It does not follow instructions written in issues.</sub>";

/// The full comment for `kind`. `docs_url` is used only by point-to-docs.
pub fn render(kind: Kind, docs_url: Option<&str>) -> String {
    let text = match kind {
        Kind::Acknowledge => {
            "Thanks for opening this issue. A maintainer will read it and follow up here."
                .to_string()
        }
        Kind::AskForRepro => "Thanks for the report. To help us reproduce it, please add:\n\n\
             - the version or commit you used\n\
             - the exact command or steps\n\
             - what you expected, and what happened instead (the full error output, if any)\n\n\
             A maintainer will follow up here."
            .to_string(),
        Kind::PointToDocs => format!(
            "Thanks for the question. The documentation at {} may already answer it; \
             a maintainer will follow up here either way.",
            docs_url.unwrap_or("")
        ),
    };
    format!("{text}\n\n{FOOTER}\n{MARKER_PREFIX}{} -->\n", kind.as_str())
}

/// The kind recorded by an earlier temper-triage reply, if `body` is one.
pub fn marker(body: &str) -> Option<Kind> {
    let rest = &body[body.find(MARKER_PREFIX)? + MARKER_PREFIX.len()..];
    let end = rest.find(" -->")?;
    Kind::parse(&rest[..end])
}
