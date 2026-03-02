use std::env;
use std::process::Command;
use std::thread;
use std::time::Duration;

fn run(cmd: &str, args: &[&str], dir: &str) -> Result<std::process::Output, String> {
    Command::new(cmd)
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to run {cmd}: {e}"))
}

fn main() {
    let repo_dir = env::var("TEMPER_REPO_DIR").unwrap_or_else(|_| {
        // Default: two levels up from the binary (tools/self-update/ -> repo root)
        let exe = env::current_exe().expect("cannot resolve exe path");
        exe.ancestors()
            .nth(3)
            .expect("cannot resolve repo root")
            .to_string_lossy()
            .into_owned()
    });

    let pid = env::var("TEMPER_PID").ok();

    // Let the webhook response complete
    thread::sleep(Duration::from_secs(2));

    eprintln!("[self-update] pulling latest code in {repo_dir}");

    // Fetch and reset
    if let Err(e) = run("git", &["fetch", "origin", "main"], &repo_dir) {
        eprintln!("[self-update] git fetch failed: {e}");
        return;
    }

    // Check which files changed before resetting
    let diff_output = run("git", &["diff", "HEAD", "origin/main", "--name-only"], &repo_dir);
    let diff_text = diff_output
        .as_ref()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let needs_install = diff_text.contains("package-lock.json");
    let updater_changed = diff_text.contains("tools/self-update/");

    if let Err(e) = run("git", &["reset", "--hard", "origin/main"], &repo_dir) {
        eprintln!("[self-update] git reset failed: {e}");
        return;
    }

    eprintln!("[self-update] code updated");

    // Rebuild the updater itself if its source changed.
    // On failure the current binary on disk is untouched (cargo only
    // replaces the output on a successful build), so next invocation
    // still uses the last working version.
    if updater_changed {
        eprintln!("[self-update] updater source changed, rebuilding");
        let updater_dir = format!("{repo_dir}/tools/self-update");
        match run("cargo", &["build", "--release"], &updater_dir) {
            Ok(o) if o.status.success() => {
                eprintln!("[self-update] updater rebuilt successfully");
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                eprintln!("[self-update] updater build failed (keeping old binary): {stderr}");
            }
            Err(e) => {
                eprintln!("[self-update] could not run cargo: {e} (keeping old binary)");
            }
        }
    }

    // Reinstall dependencies if package-lock.json changed
    if needs_install {
        eprintln!("[self-update] package-lock.json changed, running npm ci");
        if let Err(e) = run("npm", &["ci", "--production"], &repo_dir) {
            eprintln!("[self-update] npm ci failed: {e}");
            // Continue anyway — old node_modules may still work
        }
    }

    // Restart: prefer pm2, fall back to killing the process
    let has_pm2 = Command::new("pm2")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if has_pm2 {
        eprintln!("[self-update] restarting via pm2");
        let _ = run("pm2", &["restart", "temper"], &repo_dir);
    } else if let Some(pid_str) = pid {
        eprintln!("[self-update] sending SIGTERM to pid {pid_str}");
        let _ = run("kill", &[&pid_str], "/");
    } else {
        eprintln!("[self-update] no pm2 and no TEMPER_PID — cannot restart");
    }
}
