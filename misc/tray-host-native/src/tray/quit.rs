//! Quit: the one path that tears the whole app down, from the menu or the daemon's shutdown sentinel.

use crate::tray::icon::remove_tray_icon;
use crate::win::*;
use crate::{app, daemon, get_url, App, TIMER_HEALTH, TIMER_SENTINEL};
use std::sync::atomic::Ordering;
use std::time::Duration;

/// The full-shutdown sentinel: the daemon drops this file when the user picks "Shut down" in the
/// web UI, and the tray must then tear the WHOLE app down instead of reviving it.
pub(crate) fn sentinel_tick(hwnd: HWND) {
    let a = app();
    if a.intentional_stop.load(Ordering::Relaxed) || a.busy.load(Ordering::Relaxed) {
        return;
    }
    let Some(path) = a.cfg.sentinel_file.as_ref() else {
        return;
    };
    if path.exists() {
        let _ = std::fs::remove_file(path);
        quit_app(hwnd);
    }
}

pub(crate) fn quit_app(hwnd: HWND) {
    let a = app();
    if a.quitting.swap(true, Ordering::SeqCst) {
        return; // the menu item and the sentinel watcher can both land here
    }
    a.intentional_stop.store(true, Ordering::Relaxed);
    unsafe {
        KillTimer(hwnd, TIMER_HEALTH);
        KillTimer(hwnd, TIMER_SENTINEL);
    }
    if let Some(path) = a.cfg.sentinel_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }
    a.cancel.store(true, Ordering::Relaxed);

    run_quit_command(a);
    stop_daemon(a);

    unsafe {
        remove_tray_icon();
        PostQuitMessage(0);
    }
}

/// What else goes with the app (AgentHydra: its window and the window server). First, so it runs
/// beside the daemon's stop instead of after it, and not waited on: it is its own process and
/// outlives this one.
fn run_quit_command(a: &App) {
    if let Some(q) = a.cfg.quit_command.as_ref().filter(|q| q.ready()) {
        let url = get_url().unwrap_or_default();
        if !spawn_in(&q.exe, &q.args_for(&url), &q.cwd) {
            daemon::tray_log(
                &a.cfg,
                &format!("quit command {} could not be started", q.exe.display()),
            );
        }
    }
}

/// Stops the daemon for Quit: a short graceful POST first when this session owns it, then the stop.
fn stop_daemon(a: &App) {
    let use_token = !a.token.is_empty();
    let owned = a.started_by_us.load(Ordering::Relaxed);

    // A short graceful POST first, so a daemon that can close cleanly does. Bounded at 3s: Quit
    // must never feel like a hang, and the force-kill below is the guaranteed backstop.
    if use_token && owned {
        if let Some(url) = get_url() {
            daemon::request_shutdown(&a.cfg, &url, &a.token, Duration::from_secs(3));
        }
    }
    reap_workers(a);
    // skip_graceful: the bounded POST above already ran, and a second 20s attempt plus its 10s
    // poll is exactly how Quit used to turn into a ~30 s hang.
    if !use_token {
        daemon::stop(&a.cfg, &a.token, true, false);
        daemon::clear_run_sentinels(&a.cfg);
    } else if owned {
        daemon::stop(&a.cfg, &a.token, true, true);
        daemon::clear_run_sentinels(&a.cfg);
    }
}

/// Reaps anything a worker spawned (the rebuild, then the daemon's wrapper) before the daemon itself
/// is killed.
fn reap_workers(a: &App) {
    for pid in [
        a.build_pid.swap(0, Ordering::Relaxed),
        daemon::CHILD_PID.swap(0, Ordering::SeqCst),
    ] {
        if pid > 0 {
            daemon::taskkill(pid);
        }
    }
}
