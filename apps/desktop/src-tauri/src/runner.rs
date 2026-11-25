use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{oneshot, Mutex};

pub const RUN_EVENT: &str = "run-event";
const MAX_LINES: usize = 20_000;
const MAX_LINE_CHARS: usize = 4_000;
/// Game Studio's own lines from a game (GSTUDIO telemetry, the GSTUDIO_SMOKE report) are structured data the
/// studio parses; cut short they are lost, so they may be much longer than other output.
const MAX_STUDIO_LINE_CHARS: usize = 262_144;

/// A line of a run's output as shown and parsed: ordinary output is cut at MAX_LINE_CHARS characters,
/// the game's GSTUDIO lines at MAX_STUDIO_LINE_CHARS.
fn capped_line(line: String) -> String {
    let cap = if line.starts_with("GSTUDIO") { MAX_STUDIO_LINE_CHARS } else { MAX_LINE_CHARS };
    if line.chars().count() <= cap {
        line
    } else {
        line.chars().take(cap).collect()
    }
}

#[derive(Clone, Serialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RunEvent {
    #[serde(rename_all = "camelCase")]
    Step { run_id: String, step: usize, label: String, command: String },
    #[serde(rename_all = "camelCase")]
    Output { run_id: String, stream: String, line: String },
    #[serde(rename_all = "camelCase")]
    Exit { run_id: String, code: Option<i32>, cancelled: bool, failed_step: Option<String>, duration_ms: u64 },
}

#[derive(Clone, Debug)]
pub struct RunStep {
    pub label: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

/// Environment variables that look like credentials are removed before starting a game or editor.
pub fn is_secret_env(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    ["API_KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "PRIVATE_KEY"].iter().any(|w| n.contains(w)) || n.starts_with("AWS_")
}

/// An app bundle runs its main executable. Exported games are bundles whose executable is named
/// after the project title, so the name is read from the bundle when the step starts.
pub fn resolve_program(program: &Path) -> PathBuf {
    if program.extension().map(|e| e == "app").unwrap_or(false) && program.is_dir() {
        if let Some(exe) = crate::engines::bundle_executable(program) {
            return exe;
        }
    }
    program.to_path_buf()
}

#[derive(Default)]
pub struct Runs {
    cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

pub trait EventSink: Send + Sync + 'static {
    fn send(&self, event: RunEvent);
}

impl EventSink for AppHandle {
    fn send(&self, event: RunEvent) {
        let _ = self.emit(RUN_EVENT, event);
    }
}

impl Runs {
    pub async fn start<S: EventSink + Clone>(self: &Arc<Self>, sink: S, steps: Vec<RunStep>) -> String {
        let run_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.cancels.lock().await.insert(run_id.clone(), tx);
        let runs = Arc::clone(self);
        let id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            let (code, cancelled, failed_step) = execute(&sink, &id, steps, rx).await;
            runs.cancels.lock().await.remove(&id);
            sink.send(RunEvent::Exit { run_id: id, code, cancelled, failed_step, duration_ms: started.elapsed().as_millis() as u64 });
        });
        run_id
    }

    pub async fn stop(&self, run_id: &str) -> bool {
        match self.cancels.lock().await.remove(run_id) {
            Some(tx) => tx.send(()).is_ok(),
            None => false,
        }
    }

    pub async fn active(&self) -> Vec<String> {
        self.cancels.lock().await.keys().cloned().collect()
    }
}

async fn execute<S: EventSink + Clone>(sink: &S, run_id: &str, steps: Vec<RunStep>, mut cancel: oneshot::Receiver<()>) -> (Option<i32>, bool, Option<String>) {
    let lines = Arc::new(AtomicUsize::new(0));
    for (i, step) in steps.into_iter().enumerate() {
        let command = format!("{} {}", step.program.display(), step.args.join(" "));
        sink.send(RunEvent::Step { run_id: run_id.into(), step: i, label: step.label.clone(), command });
        let mut cmd = tokio::process::Command::new(resolve_program(&step.program));
        cmd.args(&step.args).current_dir(&step.cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        for (key, _) in std::env::vars_os() {
            if is_secret_env(&key.to_string_lossy()) {
                cmd.env_remove(key);
            }
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                sink.send(RunEvent::Output { run_id: run_id.into(), stream: "stderr".into(), line: format!("Could not start {}: {e}", step.program.display()) });
                return (None, false, Some(step.label));
            }
        };
        let mut readers = Vec::new();
        for (stream, handle) in [("stdout", child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)), ("stderr", child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>))] {
            if let Some(h) = handle {
                let sink = sink.clone();
                let lines = Arc::clone(&lines);
                let id = run_id.to_string();
                readers.push(tauri::async_runtime::spawn(async move {
                    let mut reader = BufReader::new(h).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        let n = lines.fetch_add(1, Ordering::Relaxed);
                        if n < MAX_LINES {
                            sink.send(RunEvent::Output { run_id: id.clone(), stream: stream.into(), line: capped_line(line) });
                        } else if n == MAX_LINES {
                            sink.send(RunEvent::Output { run_id: id.clone(), stream: "stderr".into(), line: "Output limit reached; further lines are not shown.".into() });
                        }
                    }
                }));
            }
        }
        let status = tokio::select! {
            s = child.wait() => s.ok(),
            _ = &mut cancel => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return (None, true, Some(step.label));
            }
        };
        for r in readers {
            let _ = r.await;
        }
        let code = status.and_then(|s| s.code());
        if code != Some(0) {
            return (code, false, Some(step.label));
        }
    }
    (Some(0), false, None)
}

#[cfg(test)]
mod tests {
    #[test]
    fn keeps_a_games_report_whole_but_cuts_long_ordinary_output() {
        // The 3D adventure's self-test report is over 4,000 characters; cut, it would no longer be JSON.
        let report = format!("GSTUDIO_SMOKE {{\"pass\":true,\"checks\":[{}]}}", vec!["{\"name\":\"a check\",\"ok\":true}"; 300].join(","));
        assert!(report.len() > 4_000);
        assert_eq!(super::capped_line(report.clone()), report);
        let telemetry = format!("GSTUDIO {{\"type\":\"ready\",\"modelErrors\":{{}},\"pad\":\"{}\"}}", "x".repeat(5_000));
        assert_eq!(super::capped_line(telemetry.clone()), telemetry);
        let noise = "y".repeat(10_000);
        assert_eq!(super::capped_line(noise).chars().count(), super::MAX_LINE_CHARS);
        let huge = format!("GSTUDIO_SMOKE {}", "z".repeat(super::MAX_STUDIO_LINE_CHARS));
        assert_eq!(super::capped_line(huge).chars().count(), super::MAX_STUDIO_LINE_CHARS);
    }

    use super::*;
    use std::sync::Mutex as StdMutex;

    #[derive(Clone, Default)]
    struct Collect(Arc<StdMutex<Vec<RunEvent>>>);
    impl EventSink for Collect {
        fn send(&self, event: RunEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    fn script(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    async fn wait_exit(sink: &Collect) -> RunEvent {
        for _ in 0..200 {
            if let Some(e) = sink.0.lock().unwrap().iter().find(|e| matches!(e, RunEvent::Exit { .. })).cloned() {
                return e;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("run did not exit");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn streams_output_runs_steps_in_order_and_hides_secrets() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("GAMESTUDIO_TEST_API_KEY", "should-not-leak");
        let a = script(dir.path(), "a.sh", "echo first; echo oops >&2");
        let b = script(dir.path(), "b.sh", "echo key=${GAMESTUDIO_TEST_API_KEY:-hidden}");
        let runs = Arc::new(Runs::default());
        let sink = Collect::default();
        runs.start(sink.clone(), vec![
            RunStep { label: "A".into(), program: a, args: vec![], cwd: dir.path().into() },
            RunStep { label: "B".into(), program: b, args: vec![], cwd: dir.path().into() },
        ]).await;
        let exit = wait_exit(&sink).await;
        assert!(matches!(exit, RunEvent::Exit { code: Some(0), cancelled: false, failed_step: None, .. }));
        let lines: Vec<String> = sink.0.lock().unwrap().iter().filter_map(|e| match e { RunEvent::Output { stream, line, .. } => Some(format!("{stream}:{line}")), _ => None }).collect();
        assert!(lines.contains(&"stdout:first".to_string()));
        assert!(lines.contains(&"stderr:oops".to_string()));
        assert!(lines.contains(&"stdout:key=hidden".to_string()), "{lines:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stops_after_a_failing_step_and_can_be_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let fail = script(dir.path(), "fail.sh", "exit 4");
        let never = script(dir.path(), "never.sh", "echo should-not-run");
        let runs = Arc::new(Runs::default());
        let sink = Collect::default();
        runs.start(sink.clone(), vec![
            RunStep { label: "Import".into(), program: fail, args: vec![], cwd: dir.path().into() },
            RunStep { label: "Play".into(), program: never, args: vec![], cwd: dir.path().into() },
        ]).await;
        assert!(matches!(wait_exit(&sink).await, RunEvent::Exit { code: Some(4), failed_step: Some(ref s), .. } if s == "Import"));

        let slow = script(dir.path(), "slow.sh", "sleep 30");
        let sink2 = Collect::default();
        let id = runs.start(sink2.clone(), vec![RunStep { label: "Slow".into(), program: slow, args: vec![], cwd: dir.path().into() }]).await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(runs.stop(&id).await);
        assert!(matches!(wait_exit(&sink2).await, RunEvent::Exit { cancelled: true, .. }));
        assert!(runs.active().await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runs_the_executable_inside_an_app_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("Exported.app");
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>CFBundleExecutable</key><string>Sun Valley</string></dict></plist>\n").unwrap();
        script(&bundle.join("Contents/MacOS"), "Sun Valley", "echo \"bundle ran with $1\"");
        let runs = Arc::new(Runs::default());
        let sink = Collect::default();
        runs.start(sink.clone(), vec![RunStep { label: "Check".into(), program: bundle.clone(), args: vec!["--studio-smoke".into()], cwd: dir.path().into() }]).await;
        assert!(matches!(wait_exit(&sink).await, RunEvent::Exit { code: Some(0), .. }));
        let lines: Vec<String> = sink.0.lock().unwrap().iter().filter_map(|e| match e { RunEvent::Output { line, .. } => Some(line.clone()), _ => None }).collect();
        assert_eq!(lines, vec!["bundle ran with --studio-smoke".to_string()]);
    }

    #[test]
    fn recognises_credential_variables() {
        for k in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY2", "GITHUB_TOKEN", "AWS_PROFILE", "MY_SECRET"] {
            assert!(is_secret_env(k), "{k}");
        }
        for k in ["HOME", "PATH", "LANG", "GODOT_BIN"] {
            assert!(!is_secret_env(k), "{k}");
        }
    }
}
