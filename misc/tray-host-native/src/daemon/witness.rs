//! Witnessing the serving daemon whoever started it: its exit code, logged when it ends.

use super::http::split_url;
use super::log::{log_line, log_path};
use super::probe::{health_ok, read_pointer};
use super::PROBE_POLL;
use crate::config::Config;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

/// The daemon pid a witness thread is parked on; 0 for none.
static WITNESSED_PID: AtomicU32 = AtomicU32::new(0);

/// WITNESS THE DAEMON ITSELF, WHOEVER STARTED IT (owner ask, 2026-10-05).
///
/// `watch_child` sees only a wrapper this tray spawned. Most of the time the serving daemon is
/// not that: a self-update hands over to a successor created through WMI, and a daemon opened by
/// hand was never ours. AgentHydra's daemon ended three times in 36 hours with no last line, no
/// crash record and no Windows error event, each one such a successor, so the one fact that would
/// have told a native crash from an outside kill, its exit code, was held by nobody.
///
/// Called on every tick that finds the daemon answering. A pid already being watched costs one
/// pointer read; a new one is opened once and waited on in a parked thread, like `watch_child`.
pub fn witness(cfg: &Config) {
    let Some(pointer) = read_pointer(cfg) else {
        return;
    };
    let pid = pointer.num_at("pid").map(|n| n as u32).unwrap_or(0);
    if pid == 0 || WITNESSED_PID.load(Ordering::SeqCst) == pid {
        return;
    }
    // A pointer can outlive its daemon, and a pid gets reused: only a pid whose OWN url answers as
    // this service is the daemon's.
    let answers = pointer
        .str_at("url")
        .and_then(split_url)
        .is_some_and(|(host, port)| health_ok(&host, port, &cfg.service_name, PROBE_POLL));
    if !answers {
        return;
    }
    // Stored even when the open fails, so a pid that cannot be opened is not retried every tick.
    WITNESSED_PID.store(pid, Ordering::SeqCst);
    if let Some(handle) = crate::win::open_for_exit(pid) {
        watch_pid(pid, handle, log_path(cfg));
    }
}

pub(super) fn watch_pid(pid: u32, handle: usize, log: PathBuf) {
    let started = Instant::now();
    std::thread::spawn(move || {
        let code = crate::win::wait_for_exit(handle);
        let _ = WITNESSED_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
        let watched = started.elapsed().as_secs_f64();
        log_line(
            &log,
            &format!(
                "daemon pid {pid} ended ({}, watched {watched:.0}s)",
                describe_exit(code)
            ),
        );
    });
}

/// An exit code as Windows shows it (NTSTATUS values in hex), with what the common ones mean for
/// a process nobody was holding. The meaning is a reading aid, so it says "or" where a code has
/// two sources.
pub(super) fn describe_exit(code: Option<u32>) -> String {
    let Some(code) = code else {
        return "exit code unknown".to_string();
    };
    let meaning = match code {
        0 => "a clean exit",
        1 => "its own exit(1), or ended from outside: taskkill /F and End task both leave 1",
        3 => "abort(), how a runtime's crash handler ends the process",
        0x4001_0004 => "ended by Windows at logoff or shutdown",
        0xC000_0005 => "access violation",
        0xC000_00FD => "stack overflow",
        0xC000_013A => "its console was closed, or Ctrl+C",
        0xC000_0409 => "fail-fast, a corrupted stack or heap",
        _ => "",
    };
    let shown = if code >= 0x4000_0000 {
        format!("0x{code:08X}")
    } else {
        code.to_string()
    };
    if meaning.is_empty() {
        format!("exit code {shown}")
    } else {
        format!("exit code {shown}: {meaning}")
    }
}
