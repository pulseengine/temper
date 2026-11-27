use readme_blocks::{check, Code, State, BLOCKS, INTERFACE_VERSION};
use std::process::ExitCode;

const USAGE: &str = "\
Checks and syncs the shared PulseEngine README blocks between marker pairs.

Usage:
  readme-blocks check --variables <file> --readme <file> --templates <dir> [--format text|json]
  readme-blocks interface-version
  readme-blocks --version | --help

Commands:
  check              Compare each marked block with its rendered template.
  interface-version  Print the interface version this module speaks.

Options:
  --format json      Print the report as JSON (schema: interface 1).

Exit codes: 0 a report was printed, 1 the check could not run, 2 usage error.";

fn usage_error(msg: &str) -> ExitCode {
    eprintln!("readme-blocks: {msg}\n\n{USAGE}");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("readme-blocks {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("--help") | Some("-h") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("interface-version") if args.len() == 1 => {
            println!("{INTERFACE_VERSION}");
            ExitCode::SUCCESS
        }
        Some("check") => run_check(&args[1..]),
        Some(other) => usage_error(&format!("unknown command or flag '{other}'")),
        None => usage_error("no command given"),
    }
}

fn run_check(args: &[String]) -> ExitCode {
    let (mut vars, mut readme, mut templates, mut json) = (None, None, None, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let slot = match a.as_str() {
            "--variables" => &mut vars,
            "--readme" => &mut readme,
            "--templates" => &mut templates,
            "--format" => {
                match it.next().map(String::as_str) {
                    Some("json") => json = true,
                    Some("text") => json = false,
                    _ => return usage_error("--format takes text or json"),
                }
                continue;
            }
            other => return usage_error(&format!("unknown flag '{other}'")),
        };
        match it.next() {
            Some(v) => *slot = Some(v.clone()),
            None => return usage_error(&format!("{a} needs a value")),
        }
    }
    let (Some(vars), Some(readme), Some(templates)) = (vars, readme, templates) else {
        return usage_error("check needs --variables, --readme and --templates");
    };
    let read = |p: &str| std::fs::read_to_string(p).map_err(|e| format!("{p}: {e}"));
    let result = read(&vars).and_then(|v| {
        let r = read(&readme)?;
        let tpl = |name: &str| {
            // BLOCKS is the closed set the marker parser admits, so a
            // block name never reaches the filesystem as a free path.
            if !BLOCKS.contains(&name) {
                return Err(format!("no block named {name}"));
            }
            read(&format!("{templates}/{name}.md"))
        };
        check(&r, &v, &tpl)
    });
    let report = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("readme-blocks: {e}");
            return ExitCode::from(1);
        }
    };
    if json {
        match serde_json::to_string(&report) {
            Ok(s) => println!("{s}"),
            Err(e) => {
                eprintln!("readme-blocks: {e}");
                return ExitCode::from(1);
            }
        }
    } else {
        let code = match report.code {
            Code::Ok => "ok",
            Code::NotApplicable => "not_applicable",
            Code::DivergentUndeclared => "divergent_undeclared",
        };
        println!("{code}");
        if let Some(r) = &report.reason {
            println!("  {r}");
        }
        for b in &report.blocks {
            let s = match b.state {
                State::Ok => "ok",
                State::Drift => "drift",
            };
            println!("  {} {s}", b.name);
        }
    }
    ExitCode::SUCCESS
}
