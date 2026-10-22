//! The health tick: probe the daemon on a timer, run the watchdog on the answer, and act on its
//! verdict (keep the URL, or report and revive a dead daemon).

use crate::tray::icon::{balloon, set_tip, sync_icon_visibility};
use crate::tray::watchdog::Verdict;
use crate::win::*;
use crate::{app, daemon, set_url, App};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub(crate) fn health_tick() {
    let a = app();
    // The visibility sync runs FIRST and unconditionally, so "hide tray icon" keeps working even
    // when every other guard below stands the watchdog down.
    sync_icon_visibility();

    // Quit is tearing the app down and kills this timer next: there is nothing left to watch.
    if a.intentional_stop.load(Ordering::Relaxed) {
        return;
    }
    // Probe BEFORE any guard, so a guard that stands the watchdog down still knows the daemon is
    // dead and can say so. The guards used to return ahead of the probe, silently.
    let probe = daemon::live_probe(&a.cfg, daemon::PROBE_POLL);
    let health = probe.as_ref().map(|(_, health)| health.clone());
    let url = probe.map(|(url, _)| url);
    let listening = url.is_none() && daemon::port_accepts(&a.cfg, daemon::PROBE_POLL);
    let verdict = judge(a, url.is_some(), listening);
    // One missed probe is a hiccup, and the tip keeps what it said. Every other verdict follows the
    // probe, so a daemon that died (or is not ours) stops showing its old version.
    if verdict != Verdict::Hiccup {
        set_tip(health);
    }
    act_on(a, verdict, url);
}

/// Runs the watchdog's policy on this tick's probe, and writes the tray-log line the verdict earns.
fn judge(a: &App, alive: bool, listening: bool) -> Verdict {
    let busy = a.busy.load(Ordering::Relaxed);
    // Ownership gate: for token apps, leave a daemon another session owns alone. An app can opt out
    // (watchdogRequiresOwnership = false) to revive whatever is there, which is what AgentHydra
    // does to keep parity with its pre-kit launcher.
    let not_ours = !a.token.is_empty()
        && !a.started_by_us.load(Ordering::Relaxed)
        && a.cfg.watchdog_requires_ownership;
    let (verdict, line) = {
        let mut watchdog = a.watchdog.lock().unwrap();
        let verdict = watchdog.tick(Instant::now(), alive, listening, busy, not_ours);
        (verdict, watchdog.report(verdict))
    };
    if let Some(line) = line {
        daemon::tray_log(&a.cfg, &line);
    }
    verdict
}

/// Acts on one tick's verdict: a live daemon keeps its URL, and a dead one is reported and revived.
fn act_on(a: &App, verdict: Verdict, url: Option<String>) {
    match verdict {
        Verdict::Alive | Verdict::Rearmed => {
            set_url(url);
            // A death followed by a live daemon has been answered already: a self-update relaunch
            // hands over to a daemon that is not our child. A later revive must not claim it.
            daemon::forget_last_death();
            // Whoever started this daemon, hold its exit code for the day it ends.
            daemon::witness(&a.cfg);
        }
        Verdict::Hiccup | Verdict::StandDown(_) => {}
        Verdict::CrashLoop => {
            let offers_safe_mode = note_unclean_exit(a);
            let hint = if offers_safe_mode {
                "Restart or Restart in Safe Mode"
            } else {
                "Restart to try again"
            };
            balloon(
                &format!(
                    "{} keeps crashing - auto-restart paused. Use {hint}.",
                    a.cfg.display_name
                ),
                NIIF_ERROR,
            );
        }
        Verdict::Revive => {
            note_unclean_exit(a);
            revive(a);
        }
    }
}

/// A death this tray did not cause: from here on, offer the quiet way back in. Only when the app
/// names its crash-sentinel directory, which is its statement that it honours safe mode; an app
/// that ignores LUNARWERX_SAFE_MODE would get a menu item that changes nothing. Returns whether the
/// menu now offers Safe Mode.
fn note_unclean_exit(a: &App) -> bool {
    let offers_safe_mode = a.cfg.crash_sentinel_dir.is_some();
    if offers_safe_mode {
        a.unclean_exit_seen.store(true, Ordering::Relaxed);
    }
    offers_safe_mode
}

/// Kill whatever listens on the daemon's port until nothing does (a few rounds), returning the pids
/// still listening afterwards. A revive may spawn only when this is empty.
pub(crate) fn reap_port_owners(
    mut owners: impl FnMut() -> Vec<u32>,
    mut kill: impl FnMut(u32),
    mut settle: impl FnMut(),
) -> Vec<u32> {
    for _ in 0..6 {
        let pids = owners();
        if pids.is_empty() {
            return pids;
        }
        for pid in pids {
            kill(pid);
        }
        settle();
    }
    owners()
}

fn revive(a: &App) {
    a.started_by_us.store(true, Ordering::Relaxed);

    // REAP THE PREDECESSOR FIRST. A daemon that missed three consecutive probes is not always
    // dead - it can be alive and wedged before it ever binds, and spawning a replacement on top of
    // it leaves both running. Observed here: one launch produced a daemon that never bound, the
    // watchdog revived correctly 25s later, and the machine was then left with two bun processes,
    // the orphan still holding its handles. Repeat that a few times and the pile is the problem.
    //
    // This is a deliberate improvement on the PowerShell host, which also re-spawned without
    // reaping. Safe here because the grace period means we only reach this after ~15s of silence
    // with its port closed (an open port earns BUSY_PATIENCE first): a daemon that has not bound by
    // then is not about to, and taskkill /T takes the cmd.exe
    // wrapper's whole tree with it. CHILD_PID is 0 once that wrapper has exited, so this never
    // kills a recycled pid.
    let previous = daemon::CHILD_PID.swap(0, Ordering::SeqCst);
    if previous > 0 {
        daemon::taskkill(previous);
    }

    // AgentHydra, 2026-10-21: a daemon frozen 222 s was not the wrapper's child any more, the kill
    // above missed it, and the spawn below started a second daemon beside it. Whatever still owns
    // the daemon's port is the old daemon: kill it, and spawn only once the port is free.
    let ports = daemon::revive_ports(&a.cfg);
    let left = reap_port_owners(
        || ports.iter().flat_map(|p| daemon::port_pids(*p)).collect(),
        daemon::taskkill,
        || std::thread::sleep(Duration::from_millis(500)),
    );
    if !left.is_empty() {
        daemon::tray_log(
            &a.cfg,
            &format!(
                "watchdog: NOT reviving: pid {:?} still holds the daemon's port after a kill, so a second daemon would run beside it (will try again after the grace)",
                left
            ),
        );
        return;
    }
    daemon::tray_log(
        &a.cfg,
        "watchdog: the old daemon's port is free, spawning the replacement",
    );

    daemon::spawn(&a.cfg, &a.token, "watchdog revive");
    balloon(
        &format!("{} stopped unexpectedly - restarting.", a.cfg.display_name),
        NIIF_WARNING,
    );
}
