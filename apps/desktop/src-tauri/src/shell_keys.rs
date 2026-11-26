//! AI keys for an app opened from Finder or the Dock.
//!
//! macOS starts such apps without the variables a user exports in their shell profile, so a key set in
//! `~/.zshrc` or `~/.bash_profile` reached the app only when it was started from a terminal. At start-up,
//! when none of the providers' key variables is set, this asks the user's login shell for those variables
//! (and only those) and sets the ones it finds in this process. Values are never logged.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The variables `ai.rs` reads keys from (`Preset::env_keys`).
pub const KEY_NAMES: &[&str] = &["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];

/// A script printing `NAME=value` for each key name, separated by NUL bytes; works in sh, bash and zsh.
fn script() -> String {
    let parts: Vec<String> = KEY_NAMES.iter().map(|n| format!("\"{n}=${n}\"")).collect();
    format!("printf '%s\\0' {}", parts.join(" "))
}

/// Reads `NAME=value` pairs, keeping only known names with a value.
fn parse(out: &[u8]) -> Vec<(String, String)> {
    out.split(|b| *b == 0)
        .filter_map(|item| {
            let s = std::str::from_utf8(item).ok()?;
            let (name, value) = s.split_once('=')?;
            let value = value.trim();
            (KEY_NAMES.contains(&name) && !value.is_empty()).then(|| (name.to_string(), value.to_string()))
        })
        .collect()
}

/// Sets missing key variables from the login shell. Does nothing when any key variable is already set
/// (started from a terminal) or the shell does not answer within 3 seconds.
pub fn load_from_login_shell() {
    if KEY_NAMES.iter().any(|n| std::env::var_os(n).is_some()) {
        return;
    }
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    if !["/bin/bash", "/bin/zsh", "/bin/sh"].contains(&shell.as_str()) && !std::path::Path::new(&shell).is_file() {
        return;
    }
    let Ok(mut child) = Command::new(&shell).arg("-l").arg("-c").arg(script()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else {
        return;
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < Duration::from_secs(3) => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
    let mut out = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.take(64 * 1024).read_to_end(&mut out);
    }
    for (name, value) in parse(&out) {
        // Runs first thing in `run()`, before any other thread exists.
        std::env::set_var(name, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_names_every_key_and_nothing_else() {
        let s = script();
        for n in KEY_NAMES {
            assert!(s.contains(&format!("\"{n}=${n}\"")));
        }
        assert!(s.starts_with("printf '%s\\0' "));
    }

    #[test]
    fn parse_keeps_known_names_with_values_only() {
        let out = b"GEMINI_API_KEY=abc123\0OPENAI_API_KEY=\0PATH=/bin\0ANTHROPIC_API_KEY= x=y \0junk\0";
        assert_eq!(parse(out), vec![("GEMINI_API_KEY".into(), "abc123".into()), ("ANTHROPIC_API_KEY".into(), "x=y".into())]);
    }

    #[test]
    fn the_shell_script_prints_what_the_shell_has() {
        let out = Command::new("/bin/sh").arg("-c").arg(script()).env("GEMINI_API_KEY", "test-value-123").env_remove("OPENAI_API_KEY").output().unwrap();
        assert!(parse(&out.stdout).contains(&("GEMINI_API_KEY".into(), "test-value-123".into())));
    }
}
