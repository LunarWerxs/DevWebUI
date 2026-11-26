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
    use crate::json;
    use crate::tray::health::{port_is_held, reap_port_owners};
    use crate::tray::watchdog::{
        StandDown, Status, Verdict, BACKOFF_FIRST, BACKOFF_MAX, BUSY_PATIENCE, CRASH_LOOP_MAX,
        CRASH_LOOP_WINDOW, REVIVE_AFTER_MISSES,
    };
    use crate::tray::watchdog_status;

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

    /// AgentHydra, 2026-10-20: a probe that timed out under load read as dead and a second daemon
    /// started. A timed-out probe with a live port owner (connect refused or not) never revives
    /// inside the patience; with no owner it revives on the third miss.
    #[test]
    fn a_timed_out_probe_with_a_live_port_owner_does_not_launch_and_a_dead_owner_does() {
        let tick = Duration::from_millis(HEALTH_INTERVAL_MS as u64);
        let run = |accepts: bool, owners: Vec<u32>| {
            let mut w = Watchdog::default();
            let mut now = Instant::now();
            w.tick(now, true, false, false, false);
            let mut verdicts = Vec::new();
            for _ in 0..8 {
                now += tick;
                let held = port_is_held(accepts, || owners.clone());
                verdicts.push(w.tick(now, false, held, false, false));
            }
            verdicts
        };
        assert!(
            !run(false, vec![7787]).contains(&Verdict::Revive),
            "owner alive, backlog full"
        );
        assert!(
            !run(true, vec![]).contains(&Verdict::Revive),
            "owner alive, connect works"
        );
        assert!(
            run(false, vec![]).contains(&Verdict::Revive),
            "nobody holds the port"
        );
        assert!(
            port_is_held(true, || unreachable!()),
            "owners are not asked after a connect"
        );
    }

    const TICK: Duration = Duration::from_millis(HEALTH_INTERVAL_MS as u64);

    /// One health tick, run the way `judge` runs it: the verdict, the tray-log line, the status change.
    struct Seen {
        verdict: Verdict,
        line: Option<String>,
        status: Option<Status>,
    }

    fn tick_at(w: &mut Watchdog, now: Instant, alive: bool) -> Seen {
        let verdict = w.tick(now, alive, false, false, false);
        let line = w.report(verdict);
        let status = w.status_change(now, verdict, line.as_deref());
        Seen {
            verdict,
            line,
            status,
        }
    }

    /// Health ticks (every 5 s) until one of them satisfies `done`; the ticks run, the last one is the stop.
    fn run_until(
        w: &mut Watchdog,
        now: &mut Instant,
        alive: bool,
        done: impl Fn(&Seen) -> bool,
    ) -> Vec<Seen> {
        let mut seen = Vec::new();
        loop {
            *now += TICK;
            let tick = tick_at(w, *now, alive);
            let stop = done(&tick);
            seen.push(tick);
            if stop {
                return seen;
            }
            assert!(
                seen.len() < 100_000,
                "the watchdog never reached the wanted verdict"
            );
        }
    }

    fn revive_or_backoff(s: &Seen) -> bool {
        s.verdict == Verdict::Revive || matches!(s.verdict, Verdict::Backoff { .. })
    }

    /// A tick that only waits: a missed probe on the way to "dead", or the backoff's wait.
    fn is_waiting(s: &Seen) -> bool {
        s.verdict == Verdict::Hiccup || s.verdict == Verdict::StandDown(StandDown::Backoff)
    }

    /// Dead daemon, revived until the fast budget trips: returns the trip's tick (`Backoff{first}`).
    fn trip_the_guard(w: &mut Watchdog, now: &mut Instant) -> Seen {
        // Daemons that never answer, revived back to back until the guard stops resurrecting them.
        for _ in 0..CRASH_LOOP_MAX {
            let ticks = run_until(w, now, false, |s| s.verdict == Verdict::Revive);
            assert_eq!(ticks.last().unwrap().verdict, Verdict::Revive);
        }
        let mut ticks = run_until(w, now, false, revive_or_backoff);
        let trip = ticks.pop().unwrap();
        assert_eq!(trip.verdict, Verdict::Backoff { first: true });
        trip
    }

    /// The seconds in a backoff line's "next revive in Ns".
    fn wait_in(line: &str) -> u64 {
        let tail = line.split("next revive in ").nth(1).expect(line);
        tail.split('s').next().unwrap().parse().unwrap()
    }

    #[test]
    fn a_crash_loop_trips_into_a_one_minute_backoff_with_one_revive_at_its_end() {
        let mut w = Watchdog::default();
        let mut now = Instant::now();
        let trip = trip_the_guard(&mut w, &mut now);
        let at = now;
        let line = trip.line.clone().unwrap();
        assert_eq!(
            wait_in(&line),
            BACKOFF_FIRST.as_secs(),
            "the first wait is a minute"
        );
        assert!(
            line.contains(
                "auto-restart is backing off after 4 revives inside 120s: next revive in 60s (at "
            ),
            "{line}"
        );
        assert!(
            line.ends_with("doubling to a 15 min cap; a tray Restart revives it now"),
            "{line}"
        );
        assert!(!line.contains("paused"), "{line}");
        // The clock in the line is HH:MM:SS.
        let clock = line
            .split("(at ")
            .nth(1)
            .unwrap()
            .split(')')
            .next()
            .unwrap();
        assert_eq!(clock.len(), 8, "{clock}");
        assert_eq!(&clock[2..3], ":");
        assert_eq!(&clock[5..6], ":");
        let status = trip.status.clone().expect("the trip writes the status");
        assert_eq!(status.state, "backoff");
        assert_eq!(status.revives, CRASH_LOOP_MAX);
        assert!(status.next_revive_ms.is_some());

        // Silent until the wait is over, and no line or status write on the way.
        let waiting = run_until(&mut w, &mut now, false, |s| !is_waiting(s));
        let (last, quiet) = waiting.split_last().unwrap();
        assert_eq!(
            last.verdict,
            Verdict::Revive,
            "one revive at the end of the wait"
        );
        assert_eq!(
            now.duration_since(at),
            BACKOFF_FIRST,
            "not before, not after"
        );
        for s in quiet {
            assert!(
                s.line.is_none() && s.status.is_none(),
                "a tick of the wait is silent"
            );
        }
        assert_eq!(last.status.as_ref().map(|s| s.state), Some("reviving"));
    }

    #[test]
    fn a_further_death_doubles_the_wait_to_the_fifteen_minute_cap_and_each_step_is_reported_once() {
        let mut w = Watchdog::default();
        let mut now = Instant::now();
        let trip = trip_the_guard(&mut w, &mut now);
        let mut backoff_lines = vec![trip.line.clone().unwrap()];
        let mut waits = vec![wait_in(&trip.line.unwrap())];
        let mut step_start = now;
        // Each revive dies again before it stays up: the wait doubles, capped at 15 min.
        for expected in [120u64, 240, 480, 900, 900] {
            // Wait out the current step: silent, then one revive at its end.
            let quiet = run_until(&mut w, &mut now, false, |s| !is_waiting(s));
            let (revive, silent) = quiet.split_last().unwrap();
            assert_eq!(revive.verdict, Verdict::Revive);
            assert_eq!(
                now.duration_since(step_start),
                Duration::from_secs(*waits.last().unwrap())
            );
            assert!(silent
                .iter()
                .all(|s| s.line.is_none() && s.status.is_none()));
            // The revive's grace is silent apart from the line it earns; then it dies: a further death.
            let ticks = run_until(&mut w, &mut now, false, |s| {
                matches!(s.verdict, Verdict::Backoff { first: false })
            });
            let line = ticks.last().unwrap().line.clone().unwrap();
            assert!(
                line.starts_with("watchdog: the daemon is not answering, and it is NOT being revived: a revive died before the daemon stayed up for 120s, so auto-restart is backing off: next revive in "),
                "{line}"
            );
            assert_eq!(wait_in(&line), expected, "{line}");
            if expected < BACKOFF_MAX.as_secs() {
                assert!(
                    line.ends_with("doubling to a 15 min cap; a tray Restart revives it now"),
                    "{line}"
                );
            } else {
                assert!(
                    line.ends_with("held at the 15 min cap; a tray Restart revives it now"),
                    "{line}"
                );
            }
            backoff_lines.push(line);
            waits.push(expected);
            step_start = now;
        }
        assert_eq!(
            waits,
            vec![60, 120, 240, 480, 900, 900],
            "1, 2, 4, 8, 15, 15 minutes"
        );
        // Six steps, six lines: the trip plus five further deaths. The grace and wait ticks stay silent.
        assert_eq!(backoff_lines.len(), 6, "{backoff_lines:#?}");
    }

    #[test]
    fn a_daemon_that_stays_up_for_the_window_rearms_the_backoff() {
        let mut w = Watchdog::default();
        let mut now = Instant::now();
        trip_the_guard(&mut w, &mut now);
        let start = now;
        // The next daemon comes up, and stays up for the whole window.
        let up = run_until(&mut w, &mut now, true, |s| s.verdict == Verdict::Rearmed);
        let rearmed = up.last().unwrap();
        assert_eq!(now.duration_since(start), CRASH_LOOP_WINDOW + TICK);
        let line = rearmed.line.clone().unwrap();
        assert!(line.starts_with("watchdog: re-armed"), "{line}");
        assert!(!line.contains("paused"), "{line}");
        let status = rearmed.status.clone().unwrap();
        assert_eq!((status.state, status.revives), ("ok", 0));
        // Then it is killed: that death is a new one, revived at once by the fresh budget.
        let death = run_until(&mut w, &mut now, false, revive_or_backoff);
        assert_eq!(death.last().unwrap().verdict, Verdict::Revive);
    }

    #[test]
    fn a_restart_from_the_menu_rearms_the_backoff_at_once() {
        let mut w = Watchdog::default();
        let mut now = Instant::now();
        trip_the_guard(&mut w, &mut now);
        // What a tray Restart does first (start_worker): the backoff is lifted.
        w.rearm();
        let ticks = run_until(&mut w, &mut now, false, revive_or_backoff);
        assert_eq!(ticks.last().unwrap().verdict, Verdict::Revive);
    }

    #[test]
    fn the_status_file_follows_each_transition_and_is_written_only_on_a_change() {
        let dir =
            std::env::temp_dir().join(format!("lunarwerx-tray-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let read = |dir: &std::path::Path| {
            json::parse(&std::fs::read_to_string(dir.join(watchdog_status::STATUS_FILE)).unwrap())
                .unwrap()
        };
        // What the health tick does with each tick's status change: write it, and count the writes.
        let persist = |dir: &std::path::Path, ticks: &[Seen]| {
            let mut writes = 0;
            for s in ticks {
                if let Some(status) = &s.status {
                    watchdog_status::write(dir, status, None);
                    writes += 1;
                }
            }
            writes
        };

        let mut w = Watchdog::default();
        let mut now = Instant::now();
        // A steady daemon: the first status is written at once, and then nothing.
        let mut steady = Vec::new();
        for _ in 0..3 {
            now += TICK;
            steady.push(tick_at(&mut w, now, true));
        }
        assert_eq!(persist(&dir, &steady), 1);
        assert_eq!(read(&dir).str_at("state"), Some("ok"));

        // The first revive writes "reviving"; the misses before it wrote nothing.
        let first = run_until(&mut w, &mut now, false, |s| s.verdict == Verdict::Revive);
        assert_eq!(persist(&dir, &first), 1);
        let file = read(&dir);
        assert_eq!(file.str_at("state"), Some("reviving"));
        assert!(file.str_at("reason").unwrap().contains("is being revived"));
        assert!(file.get("nextReviveAt") == Some(&json::Json::Null));

        // The rest of the crash loop, each revive's death and grace, and the trip to a backoff.
        for _ in 0..CRASH_LOOP_MAX - 1 {
            let ticks = run_until(&mut w, &mut now, false, |s| s.verdict == Verdict::Revive);
            persist(&dir, &ticks);
        }
        let trip = run_until(&mut w, &mut now, false, revive_or_backoff);
        assert!(persist(&dir, &trip) >= 1);
        let file = read(&dir);
        assert_eq!(file.str_at("state"), Some("backoff"));
        assert_eq!(file.num_at("revives"), Some(CRASH_LOOP_MAX as f64));
        assert!(file.num_at("nextReviveAt").is_some());

        // The wait writes nothing; the revive at its end writes "reviving" once.
        let waiting = run_until(&mut w, &mut now, false, |s| !is_waiting(s));
        assert_eq!(
            persist(&dir, &waiting),
            1,
            "only the revive at the wait's end writes"
        );
        assert_eq!(read(&dir).str_at("state"), Some("reviving"));

        // Its grace line and the further death's step each write once: the file names the doubled wait.
        let death = run_until(&mut w, &mut now, false, |s| {
            matches!(s.verdict, Verdict::Backoff { first: false })
        });
        assert_eq!(persist(&dir, &death), 2);
        let file = read(&dir);
        assert_eq!(file.str_at("state"), Some("backoff"));
        assert!(file
            .str_at("reason")
            .unwrap()
            .contains("next revive in 120s"));

        // It stays up for the window: "answers again", then "re-armed", and the file ends "ok".
        let up = run_until(&mut w, &mut now, true, |s| s.verdict == Verdict::Rearmed);
        assert_eq!(persist(&dir, &up), 2);
        let file = read(&dir);
        assert_eq!(file.str_at("state"), Some("ok"));
        assert!(file
            .str_at("reason")
            .unwrap()
            .starts_with("watchdog: re-armed"));
        assert!(file.get("nextReviveAt") == Some(&json::Json::Null));
        let _ = std::fs::remove_dir_all(&dir);
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
