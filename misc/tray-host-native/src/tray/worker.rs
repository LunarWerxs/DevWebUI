//! Work that runs off the UI thread: Restart, Rebuild & Restart, and the app's own action. Each one
//! posts its outcome back to the window as WM_APP_WORKER_DONE.

use crate::tray::icon::{balloon, set_tip};
use crate::win::*;
use crate::{
    app, daemon, get_url, set_url, App, UI, WORK_ACTION_FAILED, WORK_ACTION_OK, WORK_BUILD_FAILED,
    WORK_CANCELED, WORK_OK_NOT_READY, WORK_OK_READY,
};
use std::sync::atomic::Ordering;
use std::time::Duration;

/// A hidden `cmd.exe` running `line` as its raw command line, with no console window and its output
/// discarded. Callers add a working directory where they need one.
pub(crate) fn hidden_cmd(line: String) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("cmd.exe");
    cmd.raw_arg(line)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(0x0800_0000);
    cmd
}

/// Run the rebuild (optional) and the daemon restart off the UI thread, then post the outcome back.
///
/// The UI thread must never block on this: a rebuild is a full `bun run build`, and a stop can take
/// seconds waiting out a graceful shutdown.
pub(crate) fn start_worker(hwnd: HWND, rebuild: bool) {
    let a = app();
    if a.busy.swap(true, Ordering::SeqCst) {
        return; // one at a time
    }
    // A manual Restart is the operator saying "try again", so it clears the crash-loop pause.
    a.watchdog.lock().unwrap().rearm();
    a.cancel.store(false, Ordering::Relaxed);
    a.was_rebuild.store(rebuild, Ordering::Relaxed);

    let hwnd_val = hwnd as usize;
    std::thread::spawn(move || {
        let outcome = run_worker(rebuild);
        app().busy.store(false, Ordering::SeqCst);
        unsafe {
            PostMessageW(hwnd_val as HWND, WM_APP_WORKER_DONE, outcome, 0);
        }
    });
}

/// Restart in the requested mode: the daemon comes back with its auto-start work skipped (safe) or
/// as normal. The mode only flips when a restart will actually run, so a click while busy cannot
/// leave the flag saying one thing and the daemon doing another.
pub(crate) fn restart_in_mode(hwnd: HWND, safe: bool) {
    let a = app();
    if a.busy.load(Ordering::SeqCst) {
        return;
    }
    daemon::SAFE_MODE.store(safe, Ordering::Relaxed);
    let health = UI.with(|ui| ui.borrow().as_ref().and_then(|ui| ui.health.clone()));
    set_tip(health);
    start_worker(hwnd, false);
}

/// Fire the app-action POST on a background thread.
///
/// Off the UI thread because the request can legitimately take seconds (DevWebUI's stop-all waits
/// out each child's SIGTERM grace), and a tray menu that freezes while it runs is worse than the
/// action itself. Deliberately NOT gated on `busy`: this acts on the daemon's work, not the daemon,
/// so it stays available while a rebuild is in flight.
pub(crate) fn start_action(hwnd: HWND) {
    let a = app();
    let Some(path) = a.cfg.action_path.clone() else {
        return;
    };
    let Some(url) = get_url() else {
        balloon(
            &format!("{} isn't running.", a.cfg.display_name),
            NIIF_WARNING,
        );
        return;
    };
    let hwnd_val = hwnd as usize;
    let timeout = Duration::from_secs(a.cfg.action_timeout_secs);
    std::thread::spawn(move || {
        let ok = daemon::post(&url, &path, timeout);
        let code = if ok {
            WORK_ACTION_OK
        } else {
            WORK_ACTION_FAILED
        };
        unsafe {
            PostMessageW(hwnd_val as HWND, WM_APP_WORKER_DONE, code, 0);
        }
    });
}

/// The worker thread's body: an optional rebuild, then the restart. Returns the outcome to post.
fn run_worker(rebuild: bool) -> usize {
    let a = app();
    if rebuild {
        if let Err(outcome) = run_build(a) {
            return outcome;
        }
    }
    if a.cancel.load(Ordering::Relaxed) {
        return WORK_CANCELED;
    }
    if restart_with_retries(a) {
        WORK_OK_READY
    } else {
        WORK_OK_NOT_READY
    }
}

/// The rebuild step: the app's own rebuild command, run hidden. An Err carries the outcome to report
/// instead of going on to the restart.
fn run_build(a: &App) -> Result<(), usize> {
    let cfg = &a.cfg;
    // Defence in depth: refuse a rebuild outside a dev tree even if one was somehow requested.
    if !cfg.is_dev_tree {
        return Err(WORK_BUILD_FAILED);
    }
    let Some(command) = cfg.rebuild_command.as_deref() else {
        return Err(WORK_BUILD_FAILED);
    };
    let log_path = cfg.script_dir.join(&cfg.rebuild_log_name);
    let full = format!(
        "cd /d \"{}\" && {command} > \"{}\" 2>&1",
        cfg.app_root.display(),
        log_path.display()
    );
    let child = hidden_cmd(format!("/c \"{full}\""))
        .current_dir(&cfg.app_root)
        .spawn();
    let Ok(mut child) = child else {
        return Err(WORK_BUILD_FAILED);
    };
    a.build_pid.store(child.id(), Ordering::Relaxed);
    wait_for_build(a, &mut child)
}

/// Poll rather than wait, so Quit can cancel promptly and reap the build tree instead of the app
/// hanging until a full build finishes.
fn wait_for_build(a: &App, child: &mut std::process::Child) -> Result<(), usize> {
    loop {
        if a.cancel.load(Ordering::Relaxed) {
            daemon::taskkill(child.id());
            return Err(WORK_CANCELED);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                a.build_pid.store(0, Ordering::Relaxed);
                if !status.success() {
                    return Err(WORK_BUILD_FAILED);
                }
                return Ok(());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(_) => return Err(WORK_BUILD_FAILED),
        }
    }
}

/// The restart, then extra attempts for a daemon that was slow or failed to bind. True when the
/// daemon ends up serving.
fn restart_with_retries(a: &App) -> bool {
    let cfg = &a.cfg;
    let mut ready = restart_once(Duration::from_secs(cfg.worker_wait_secs));
    // Optional extra attempts for a daemon that was slow or failed to bind.
    let mut attempt = 0;
    while !ready && !a.cancel.load(Ordering::Relaxed) && attempt < cfg.restart_retries {
        attempt += 1;
        let pid = daemon::CHILD_PID.swap(0, Ordering::SeqCst);
        if pid > 0 {
            daemon::taskkill(pid);
        }
        std::thread::sleep(Duration::from_millis(400));
        ready = restart_once(Duration::from_secs(cfg.worker_wait_secs));
    }
    ready
}

fn restart_once(budget: Duration) -> bool {
    let a = app();
    let cfg = &a.cfg;
    // A daemon already dead with its run file left behind crashed on its own: keep that file so the
    // next launch reports it. Only a stop THIS restart causes is cleared as deliberate.
    let crashed_before = daemon::unclean_run_left(cfg);
    daemon::stop(cfg, &a.token, true, false);
    if !crashed_before {
        daemon::clear_run_sentinels(cfg);
    }
    if cfg.use_port_free_wait {
        daemon::wait_port_free(cfg.port, 6);
    }
    std::thread::sleep(Duration::from_millis(300));
    let why = if a.was_rebuild.load(Ordering::Relaxed) {
        "tray Rebuild & Restart"
    } else {
        "tray Restart"
    };
    if daemon::spawn(cfg, &a.token, why).is_some() {
        a.started_by_us.store(true, Ordering::Relaxed);
    }
    match daemon::wait_for_url(cfg, budget) {
        Some(url) => {
            set_url(Some(url));
            true
        }
        None => false,
    }
}
