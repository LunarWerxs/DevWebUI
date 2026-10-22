//! Launching the daemon, and the stderr log each launch writes to.

use super::death::{take_last_death, watch_child, CHILD_PID};
use super::log::{log_line, log_path};
use super::{CREATE_NO_WINDOW, SAFE_MODE};
use crate::config::Config;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;

/// Safe mode as an env var for the daemon; see `SAFE_MODE`.
const SAFE_MODE_ENV: &str = "LUNARWERX_SAFE_MODE";
/// The stderr log rolls to `.1` past this size, at a spawn only: a running daemon holds it open.
const STDERR_LOG_MAX: u64 = 4 * 1024 * 1024;

/// Launch the daemon.
///
/// Via `cmd.exe /c` so a start command carrying shell syntax keeps working, matching Start-Daemon.
/// Two details are load-bearing:
///
/// * The command is wrapped in ONE MORE quote pair. When the text after `/c` begins with a quote,
///   cmd strips the first and last quote of the whole line, so a quoted interpreter path loses the
///   quotes protecting it and cmd runs nothing - while still starting successfully, so the caller
///   sees success and waits forever for a daemon that never existed.
/// * Stdio is never inherited. A tray started from a terminal otherwise hands the daemon that
///   terminal's pipes; nothing drains them, the buffer fills, and the daemon blocks on a console
///   write BEFORE it binds its port. Observed: a live process with no listening socket and no
///   runtime pointer. stdin and stdout are NULL (the daemon tees its own output to
///   logs/daemon.log); stderr is a FILE, which never fills and needs no reader (`open_stderr_log`).
///
/// `why` names the caller in the tray log (tray start, tray Restart, watchdog revive), so a spawn
/// line says who asked for it.
pub fn spawn(cfg: &Config, token: &str, why: &str) -> Option<u32> {
    let command = cfg.resolved_start_command(token);
    let (stderr, said) = match open_stderr_log(cfg, why) {
        Some((file, path, from)) => (Stdio::from(file), Some((path, from))),
        None => (Stdio::null(), None),
    };
    let mut cmd = Command::new("cmd.exe");
    cmd.raw_arg(format!("/c \"{command}\""))
        .current_dir(&cfg.app_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        .creation_flags(CREATE_NO_WINDOW);
    for (k, v) in cfg.resolved_start_env(token) {
        cmd.env(k, v);
    }
    let safe = SAFE_MODE.load(Ordering::Relaxed);
    cmd.env(SAFE_MODE_ENV, if safe { "1" } else { "0" });
    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            let mode = if safe { " in safe mode" } else { "" };
            // Say which death this birth answers, BEFORE watching for the next one - otherwise the
            // only record of a restart is a pid that silently changed, which is exactly the
            // evidence that was missing on 2026-09-14/15.
            let log = log_path(cfg);
            match take_last_death() {
                Some(prev) => log_line(
                    &log,
                    &format!("respawn pid {pid}{mode} ({why}) - answering {prev}"),
                ),
                None => log_line(&log, &format!("spawn pid {pid}{mode} ({why})")),
            }
            // Before the watcher starts, so even an instant exit clears it again.
            CHILD_PID.store(pid, Ordering::SeqCst);
            watch_child(child, log, said);
            Some(pid)
        }
        Err(_) => None,
    }
}

/// WHERE A TRAY-STARTED DAEMON'S STDERR GOES: `<app home>/logs/daemon-stderr.log`, beside the
/// daemon's own daemon.log (the app home is the folder holding the runtime pointer).
///
/// It used to be NULL, and two things were lost with it. cmd.exe's own complaint when it cannot
/// start the command at all: AgentHydra, 2026-10-05, four revives each `exit code 1, up 0.0s` and
/// not one word of why (see `config::plain_path`). And a runtime's native crash report, which goes
/// to stderr and nowhere else: a daemon that ends that way never reaches its own log.
///
/// Returns the file, its path and the offset this launch starts writing at. None (and NULL, as
/// before) when the config names no folder for the pointer or the file cannot be opened: a witness,
/// never a dependency.
fn open_stderr_log(cfg: &Config, why: &str) -> Option<(std::fs::File, PathBuf, u64)> {
    let home = cfg
        .info_file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())?;
    let dir = home.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("daemon-stderr.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > STDERR_LOG_MAX) {
        let _ = std::fs::rename(&path, dir.join("daemon-stderr.log.1"));
    }
    // The command as CONFIGURED: its {TOKEN} placeholder is still a placeholder here.
    log_line(&path, &format!("-- {why}: {} --", cfg.start_command));
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    let from = file.metadata().map(|m| m.len()).unwrap_or(0);
    Some((file, path, from))
}

/// What one launch wrote to the stderr log, as one short line for the tray log.
pub(super) fn stderr_since(path: &Path, from: u64) -> String {
    use std::io::{Seek, SeekFrom};
    let mut text = Vec::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        if f.seek(SeekFrom::Start(from)).is_ok() {
            let _ = f.take(4096).read_to_end(&mut text);
        }
    }
    let line = String::from_utf8_lossy(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    line.chars().take(300).collect()
}
