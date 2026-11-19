use std::process::ExitCode;
use temper_triage::net::{AppKey, RealGitHub, RealWarte};
use temper_triage::{run, Config, Handler};

const USAGE: &str = "\
temper-triage: first replies for warte's issue queue, posted as the temper GitHub App

Usage:
  temper-triage run --config <file> [--dry-run] [--format json]
  temper-triage reply <repo> <number> --config <file> [--dry-run] [--format json]
  temper-triage docs [<topic>]

Commands:
  run      Read warte's offer, reply to or skip each ready issue, mark it done
  reply    Handle one issue and print its outcome word (warte's REPLY_CMD)
  docs     Print the embedded documentation

Options:
  --config <file>  The deploy's TOML configuration
  --dry-run        Post nothing and mark nothing; print what would happen
  --format json    Print results as JSON
  -h, --help       Print this help
  -V, --version    Print the version

Credentials are files: $CREDENTIALS_DIRECTORY/warte-token and
$CREDENTIALS_DIRECTORY/app-key, else warte_token_file and app_key_file in the config.
";

const DOCS: &[(&str, &str, &str)] = &[(
    "design",
    "the loop, reply kinds, untrusted input, configuration",
    include_str!("../../docs/triage.md"),
)];

struct Args {
    cmd: String,
    pos: Vec<String>,
    config: Option<String>,
    dry_run: bool,
    json: bool,
}

fn usage_error(msg: &str) -> ExitCode {
    eprintln!("temper-triage: {msg}\n\n{USAGE}");
    ExitCode::from(2)
}

fn parse(argv: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        cmd: String::new(),
        pos: vec![],
        config: None,
        dry_run: false,
        json: false,
    };
    let mut it = argv.into_iter();
    while let Some(s) = it.next() {
        match s.as_str() {
            "--config" => a.config = Some(it.next().ok_or("--config needs a file")?),
            "--dry-run" => a.dry_run = true,
            "--format" => match it.next().as_deref() {
                Some("json") => a.json = true,
                Some("text") => a.json = false,
                _ => return Err("--format takes json or text".into()),
            },
            f if f.starts_with('-') => return Err(format!("unknown option {f}")),
            _ if a.cmd.is_empty() => a.cmd = s,
            _ => a.pos.push(s),
        }
    }
    Ok(a)
}

fn read_secret(name: &str, fallback: Option<&String>) -> Result<String, String> {
    let path = match std::env::var("CREDENTIALS_DIRECTORY") {
        Ok(d) if !d.is_empty() => format!("{d}/{name}"),
        _ => fallback.cloned().ok_or(format!(
            "no {name}: set LoadCredential= or its *_file in the config"
        ))?,
    };
    let s = std::fs::read_to_string(&path).map_err(|e| format!("{name}: {e}"))?;
    if s.trim().is_empty() {
        return Err(format!("{name}: empty"));
    }
    Ok(s)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.iter().any(|a| a == "-h" || a == "--help") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if argv.iter().any(|a| a == "-V" || a == "--version") {
        println!("temper-triage {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let a = match parse(argv) {
        Ok(a) => a,
        Err(e) => return usage_error(&e),
    };
    match a.cmd.as_str() {
        "docs" => docs(&a.pos),
        "run" | "reply" => match go(&a) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("temper-triage: {e}");
                ExitCode::FAILURE
            }
        },
        "" => usage_error("no command"),
        c => usage_error(&format!("unknown command {c}")),
    }
}

fn docs(pos: &[String]) -> ExitCode {
    match pos.first() {
        None => {
            println!("temper-triage docs — topics (temper-triage docs <topic>):\n");
            for (t, d, _) in DOCS {
                println!("  {t:<10} {d}");
            }
            ExitCode::SUCCESS
        }
        Some(t) => match DOCS.iter().find(|(n, _, _)| n == t) {
            Some((_, _, body)) => {
                print!("{body}");
                ExitCode::SUCCESS
            }
            None => usage_error(&format!("unknown docs topic {t}")),
        },
    }
}

fn go(a: &Args) -> Result<ExitCode, String> {
    let path = a.config.as_ref().ok_or("--config is required")?;
    let cfg = Config::parse(&std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?)?;
    let key = AppKey::from_pem(&read_secret("app-key", cfg.app_key_file.as_ref())?)?;
    let mut gh = RealGitHub::new(&cfg.github_api, &cfg.org, cfg.app_id, key);
    let h = Handler {
        cfg: &cfg,
        bot_login: gh.bot_login()?,
        home: std::env::var("HOME").ok(),
        dry_run: a.dry_run,
    };
    if a.cmd == "reply" {
        let [repo, n] = a.pos.as_slice() else {
            return Err("reply takes <repo> <number>".into());
        };
        let n: u64 = n.parse().map_err(|_| "reply: <number> is not a number")?;
        let p = h.handle(&mut gh, repo, n)?;
        if a.json {
            println!("{}", serde_json::to_string(&p).unwrap_or_default());
        } else {
            eprintln!("{}#{} {:?} {}", p.repo, p.number, p.kind, p.reason);
            println!("{}", p.outcome.as_str());
        }
        return Ok(ExitCode::SUCCESS);
    }
    let token = read_secret("warte-token", cfg.warte_token_file.as_ref())?;
    let mut warte = RealWarte::new(&cfg.warte_url, &token, cfg.warte_ca_file.as_deref())?;
    let items = run(&h, &mut gh, &mut warte)?;
    let failed = items
        .iter()
        .any(|i| i.error.is_some() || i.done.starts_with("error"));
    if a.json {
        println!(
            "{}",
            serde_json::json!({ "dry_run": a.dry_run, "items": items })
        );
    } else {
        for i in &items {
            match (&i.plan, &i.error) {
                (Some(p), _) => println!(
                    "{}#{} {} {} posted={} done={} ({})",
                    i.repo,
                    i.number,
                    p.outcome.as_str(),
                    p.kind.map(|k| k.as_str()).unwrap_or("-"),
                    p.posted,
                    i.done,
                    p.reason
                ),
                (None, Some(e)) => println!("{}#{} error: {e}", i.repo, i.number),
                _ => {}
            }
        }
        println!("{} item(s)", items.len());
    }
    Ok(if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}
