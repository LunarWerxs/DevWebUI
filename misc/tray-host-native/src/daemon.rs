//! Starting, probing and stopping the app's daemon.
//!
//! Every rule here is carried over from Tray-Host.ps1 rather than re-derived, including the poll
//! counts and sleeps, because several of them exist to survive a specific failure that was seen in
//! production. Where a constant looks arbitrary it is quoted with its origin.

use crate::config::Config;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

mod death;
mod http;
mod log;
mod probe;
mod spawn;
mod stop;
mod witness;

#[cfg(test)]
mod tests;

pub(crate) use death::{forget_last_death, CHILD_PID};
pub(crate) use http::{post, request_shutdown};
pub(crate) use log::tray_log;
pub(crate) use probe::{live_probe, live_url, port_accepts, revive_ports, wait_for_url, Health};
pub(crate) use spawn::spawn;
pub(crate) use stop::{port_pids, stop, taskkill, wait_port_free};
pub(crate) use witness::witness;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Safe mode for every spawn from now on (server-lib crash-sentinel.mjs): set by "Restart in Safe
/// Mode", cleared by "Restart Normally". A process-wide flag rather than a spawn() parameter so the
/// cold start, the worker and the watchdog, which all call spawn(), cannot disagree about it. The
/// daemon reads it as an env var because the start command is an opaque per-app string a flag
/// cannot be spliced into safely; it is pinned to "0" when off so an inherited value cannot keep
/// the daemon quiet by accident.
pub static SAFE_MODE: AtomicBool = AtomicBool::new(false);
const RUN_PREFIX: &str = "run_";
/// Slack for comparing boot times, as in crash-sentinel.mjs: clock corrections shift them a little.
const BOOT_TOLERANCE_MS: f64 = 5.0 * 60.0 * 1000.0;

/// The daemon's run_* crash-sentinel files, or nothing when the app configures no directory.
fn run_sentinels(cfg: &Config) -> Vec<PathBuf> {
    let Some(dir) = cfg.crash_sentinel_dir.as_ref() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(RUN_PREFIX))
        .map(|e| e.path())
        .collect()
}

/// Did an earlier run end uncleanly? True for any run file whose owner is gone, unreadable (the
/// crash landed mid-write), or written before the last boot (its pid, if alive, is recycled). Read
/// BEFORE the cold start, because the daemon reports and deletes them.
pub fn unclean_run_left(cfg: &Config) -> bool {
    let booted = crate::win::boot_time_ms();
    run_sentinels(cfg).iter().any(|path| {
        let run = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| crate::json::parse(&s));
        let pid = run
            .as_ref()
            .and_then(|v| v.num_at("pid"))
            .map(|n| n as u32)
            .unwrap_or(0);
        let earlier_boot = match (run.as_ref().and_then(|v| v.num_at("bootedAt")), booted) {
            (Some(then), Some(now)) => (then - now).abs() > BOOT_TOLERANCE_MS,
            _ => false,
        };
        pid == 0 || earlier_boot || !crate::win::pid_alive(pid)
    })
}

/// Delete the run files after the tray stopped the daemon ON PURPOSE, so the next launch does not
/// report a deliberate force-kill as a crash.
pub fn clear_run_sentinels(cfg: &Config) {
    for path in run_sentinels(cfg) {
        let _ = std::fs::remove_file(path);
    }
}

/// Pre-spawn "is one already running?" probe. A live daemon on loopback answers in ~2 ms; this
/// budget is only ever reached by a port that is silently dropping, and every millisecond of it
/// sits directly in front of the daemon spawn.
pub const PROBE_FAST: Duration = Duration::from_millis(15);
/// The probe used once we are already waiting, where correctness beats another 10 ms.
pub const PROBE_POLL: Duration = Duration::from_millis(400);
