//! The native tray host. Each app ships this build under its own `<App>-Tray.exe` name.
//!
//! A port of misc/Tray-Host.ps1, which did its job well but cost ~520 ms of Windows script-host
//! overhead before the daemon process was even created: ~154 ms for wscript.exe plus the .vbs that
//! existed only to suppress a console flash, then ~370 ms for powershell.exe to boot the CLR,
//! Add-Type WinForms and System.Drawing, and parse 1,215 lines. None of that is the app. This
//! binary starts the daemon at ~27 ms instead, and deletes the .vbs outright because
//! CREATE_NO_WINDOW suppresses the console directly.
//!
//! Behaviour is ported, not redesigned. Every interval, retry count and threshold below is the
//! PowerShell host's, because several of them exist to survive a specific production failure (see
//! the comments at each one). The one deliberate change is ORDER: the daemon is spawned before the
//! icon and menu are built, so its boot overlaps our setup instead of queueing behind it.

#![windows_subsystem = "windows"]

mod browser;
mod config;
mod daemon;
mod json;
mod sha256;
mod tray;
mod win;

use config::Config;
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tray::cli::{config_path, parse_args};
use tray::startup::{
    bootstrap_and_spawn_daemon, claim_single_instance, new_token, run_tray,
    warned_about_stray_daemon,
};
use tray::watchdog::Watchdog;
use win::{message_box, HANDLE, MB_ICONERROR, NOTIFYICONDATAW};

// --- menu ids ---------------------------------------------------------------------------------
const ID_OPEN: usize = 1;
const ID_REBUILD: usize = 2;
const ID_RESTART: usize = 3;
const ID_QUIT: usize = 4;
/// Optional per-app extra item (see Config::action_path).
const ID_ACTION: usize = 5;
/// Offered only after an unclean exit (see Config::crash_sentinel_dir).
const ID_SAFE_MODE: usize = 6;

// --- timers -----------------------------------------------------------------------------------
const TIMER_HEALTH: usize = 1;
const TIMER_SENTINEL: usize = 2;
/// Health-probe cadence. PowerShell: `$healthTimer.Interval = 5000`.
const HEALTH_INTERVAL_MS: u32 = 5_000;
/// Sentinel-file cadence. PowerShell: `$watchTimer.Interval = 500`.
const SENTINEL_INTERVAL_MS: u32 = 500;

// --- worker outcomes (passed back through WM_APP_WORKER_DONE's wParam) --------------------------
const WORK_OK_READY: usize = 0;
const WORK_OK_NOT_READY: usize = 1;
const WORK_BUILD_FAILED: usize = 2;
const WORK_CANCELED: usize = 3;
const WORK_ACTION_OK: usize = 4;
const WORK_ACTION_FAILED: usize = 5;
const WORK_ACTION_NO_DAEMON: usize = 6;

struct App {
    cfg: Config,
    token: String,
    url: Mutex<Option<String>>,
    started_by_us: AtomicBool,
    intentional_stop: AtomicBool,
    busy: AtomicBool,
    quitting: AtomicBool,
    watchdog: Mutex<Watchdog>,
    /// Set by Quit so an in-flight worker stops instead of resurrecting what we are closing.
    cancel: AtomicBool,
    build_pid: AtomicU32,
    /// True when the last worker was a rebuild (so a successful finish re-opens the UI).
    was_rebuild: AtomicBool,
    /// An unclean exit was seen (a leftover run file at cold start, or a death the watchdog
    /// caught), so the menu offers "Restart in Safe Mode" from now on. Never set unless the app
    /// configures crash_sentinel_dir (its statement that it honours safe mode).
    unclean_exit_seen: AtomicBool,
}

static APP: OnceLock<App> = OnceLock::new();
fn app() -> &'static App {
    APP.get().expect("app initialised")
}

/// UI-thread-only handles. The window procedure and every timer tick run on this thread, and
/// nothing else may touch these, which is why they live in a thread-local rather than a global.
struct Ui {
    nid: NOTIFYICONDATAW,
    mutex: HANDLE,
    /// What the watchdog's last probe read; the tooltip is built from it.
    health: Option<daemon::Health>,
    /// The tooltip text last written into `nid`, so an unchanged one costs no shell call.
    tip: String,
}
thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
}

fn set_url(url: Option<String>) {
    *app().url.lock().unwrap() = url;
}
fn get_url() -> Option<String> {
    app().url.lock().unwrap().clone()
}

fn main() {
    let t0 = Instant::now();
    let path = config_path();
    let cfg = match Config::load(&path) {
        Ok(c) => c,
        Err(e) => {
            message_box("Tray host", &e, MB_ICONERROR);
            return;
        }
    };
    let bench = std::env::var("LUNARWERX_TRAY_BENCH").is_ok();
    let background = parse_args(std::env::args().skip(1)).background;
    let token = if cfg.shutdown_token_env_var.is_some() {
        new_token()
    } else {
        String::new()
    };

    // One tray host per app, claimed BEFORE anything is created. The loser opens the running UI and
    // exits without ever showing a second icon.
    let Some(mutex) = claim_single_instance(&cfg, background) else {
        return;
    };

    // Is a daemon already alive without our tray?
    let existing = daemon::live_url(&cfg, daemon::PROBE_FAST);
    if warned_about_stray_daemon(&cfg, existing.as_deref()) {
        return;
    }

    let started_by_us = existing.is_none();
    // Before the spawn below: the daemon we are about to start reports and deletes these.
    let unclean_exit_seen = daemon::unclean_run_left(&cfg);
    if started_by_us && !bootstrap_and_spawn_daemon(&cfg, &token) {
        return;
    }

    let display_name = cfg.display_name.clone();
    let icon_file = cfg.icon_file.clone();
    let startup_wait = Duration::from_secs(cfg.startup_wait_secs);
    APP.set(App {
        cfg,
        token,
        url: Mutex::new(existing.clone()),
        started_by_us: AtomicBool::new(started_by_us),
        intentional_stop: AtomicBool::new(false),
        busy: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
        watchdog: Mutex::new(Watchdog::default()),
        cancel: AtomicBool::new(false),
        build_pid: AtomicU32::new(0),
        was_rebuild: AtomicBool::new(false),
        unclean_exit_seen: AtomicBool::new(unclean_exit_seen),
    })
    .ok();

    if bench {
        let ready = daemon::wait_for_url(&app().cfg, startup_wait);
        println!(
            "native-tray: daemon spawned at +{}ms, serving at +{}ms ({:?})",
            25,
            t0.elapsed().as_millis(),
            ready
        );
        return;
    }

    unsafe { run_tray(&display_name, &icon_file, mutex, background, startup_wait) };
}

#[cfg(test)]
mod watchdog_tests {
    use super::*;
    use crate::tray::health::reap_port_owners;
    use crate::tray::watchdog::{
        StandDown, Verdict, BUSY_PATIENCE, CRASH_LOOP_MAX, CRASH_LOOP_WINDOW, REVIVE_AFTER_MISSES,
    };

    /// AgentHydra, 2026-10-21: a revive spawned beside a frozen daemon. A pid that survives every
    /// kill must keep the revive from spawning; one that dies lets it.
    #[test]
    fn a_revive_waits_while_the_old_daemon_still_holds_the_port() {
        let mut killed = Vec::new();
        let left = reap_port_owners(|| vec![4242], |p| killed.push(p), || {});
        assert_eq!(left, vec![4242]);
        assert!(killed.len() >= 2, "it keeps trying to kill it");

        let alive = std::cell::Cell::new(true);
        let left = reap_port_owners(
            || if alive.get() { vec![7] } else { vec![] },
            |_| alive.set(false),
            || {},
        );
        assert!(left.is_empty());
    }

    const TICK: Duration = Duration::from_millis(HEALTH_INTERVAL_MS as u64);

    /// Silent ticks until the watchdog does something other than wait (a hiccup or a revive's
    /// grace), which is what one daemon death looks like from here.
    fn die(w: &mut Watchdog, now: &mut Instant) -> Verdict {
        loop {
            *now += TICK;
            let v = w.tick(*now, false, false, false, false);
            if v != Verdict::Hiccup && v != Verdict::StandDown(StandDown::Grace) {
                return v;
            }
        }
    }

    #[test]
    fn a_crash_loop_pause_is_reported_once_and_lifts_once_the_daemon_stays_up() {
        let mut w = Watchdog::default();
        let mut now = Instant::now();
        // AgentHydra, 2026-09-25: daemons that never answered, revived back to back until the guard
        // paused auto-restart.
        for _ in 0..CRASH_LOOP_MAX {
            assert_eq!(die(&mut w, &mut now), Verdict::Revive);
        }
        assert_eq!(die(&mut w, &mut now), Verdict::CrashLoop);
        assert!(w.report(Verdict::CrashLoop).is_some());
        // Paused and dead: the tray log hears it once, not every 5 s.
        for _ in 0..10 {
            now += TICK;
            let v = w.tick(now, false, false, false, false);
            assert_eq!(v, Verdict::StandDown(StandDown::Paused));
            assert_eq!(w.report(v), None);
        }
        // The next daemon comes up and stays up for the whole window (that one served 15 hours).
        let mut lifted = false;
        for _ in 0..=CRASH_LOOP_WINDOW.as_secs() / TICK.as_secs() {
            now += TICK;
            lifted |= w.tick(now, true, false, false, false) == Verdict::Rearmed;
        }
        assert!(
            lifted,
            "a daemon healthy for the whole crash-loop window must lift the pause"
        );
        // Then it is killed, and that death is a new one: it gets revived.
        assert_eq!(die(&mut w, &mut now), Verdict::Revive);
    }

    #[test]
    fn a_daemon_whose_port_still_takes_connections_is_busy_until_its_patience_runs_out() {
        let mut w = Watchdog::default();
        let mut now = Instant::now();
        w.tick(now, true, false, false, false);
        // A 38 s freeze with the port open. Three misses used to revive it.
        let mut silent = Duration::ZERO;
        while silent < Duration::from_secs(38) {
            now += TICK;
            silent += TICK;
            let v = w.tick(now, false, true, false, false);
            assert!(
                matches!(v, Verdict::Hiccup | Verdict::StandDown(StandDown::Slow)),
                "{v:?} after {silent:?}"
            );
        }
        // Its stand-down is reported once, and the answer that ends it says so.
        assert!(w.report(Verdict::StandDown(StandDown::Slow)).is_some());
        assert_eq!(w.report(Verdict::StandDown(StandDown::Slow)), None);
        now += TICK;
        let back = w.tick(now, true, false, false, false);
        assert_eq!(back, Verdict::Alive);
        assert!(w.report(back).is_some());

        // Still silent past the patience with the port open: wedged, and revived like a death.
        let mut verdict = Verdict::Hiccup;
        let mut silent = Duration::ZERO;
        while verdict != Verdict::Revive {
            now += TICK;
            silent += TICK;
            verdict = w.tick(now, false, true, false, false);
            assert!(silent <= BUSY_PATIENCE + TICK, "never revived");
        }
        assert!(silent >= BUSY_PATIENCE);

        // A closed port is a death on the third miss, as before.
        let mut misses = 0;
        let mut w = Watchdog::default();
        loop {
            now += TICK;
            misses += 1;
            if w.tick(now, false, false, false, false) == Verdict::Revive {
                break;
            }
        }
        assert_eq!(misses, REVIVE_AFTER_MISSES);
    }
}

#[cfg(test)]
mod args_tests {
    use crate::tray::cli::{parse_args, Args};

    fn args(list: &[&str]) -> Args {
        parse_args(list.iter().map(|s| s.to_string()))
    }

    #[test]
    fn background_is_a_flag_wherever_it_sits_and_never_the_config_file() {
        for list in [
            &["App-Tray.json", "--background"][..],
            &["--background", "App-Tray.json"][..],
        ] {
            let a = args(list);
            assert_eq!(a.config.as_deref(), Some("App-Tray.json"), "{list:?}");
            assert!(a.background, "{list:?}");
        }
        let plain = args(&["App-Tray.json"]);
        assert!(!plain.background);
        assert!(args(&["--background"]).config.is_none());
    }
}
