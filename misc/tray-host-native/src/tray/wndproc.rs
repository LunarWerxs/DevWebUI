//! The window procedure: every message the tray window gets, each sent to its own small handler.

use crate::tray::health::health_tick;
use crate::tray::icon::{balloon, sync_icon_visibility, ICON_SHOWN, TASKBAR_CREATED};
use crate::tray::menu::{open_current_ui, show_menu};
use crate::tray::quit::{quit_app, sentinel_tick};
use crate::tray::worker::{restart_in_mode, start_action, start_worker};
use crate::win::*;
use crate::{
    app, ID_ACTION, ID_OPEN, ID_QUIT, ID_REBUILD, ID_RESTART, ID_SAFE_MODE, TIMER_HEALTH,
    TIMER_SENTINEL, WORK_ACTION_FAILED, WORK_ACTION_NO_DAEMON, WORK_ACTION_OK, WORK_BUILD_FAILED,
    WORK_OK_NOT_READY, WORK_OK_READY,
};
use std::sync::atomic::Ordering;

pub(crate) unsafe extern "system" fn wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        WM_APP_TRAY => {
            on_tray_callback(h, l);
            0
        }
        WM_COMMAND => {
            on_command(h, w);
            0
        }
        WM_TIMER => {
            on_timer(h, w);
            0
        }
        WM_APP_WORKER_DONE => {
            on_worker_done(w);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        // Explorer (re)created the taskbar. EVERY tray icon on the machine was destroyed with the
        // old one, and the shell expects each app to add its own back — an app that does not is
        // simply gone from the tray for the rest of the session while its process keeps running
        // fine. WinForms' NotifyIcon did this for us in the PowerShell host, which is why the
        // hand-rolled port lost it silently: nothing here was wrong until Explorer restarted.
        //
        // This also covers the cold case. A host launched at logon (Startup folder, scheduled
        // task) can beat the taskbar into existence; its first NIM_ADD fails, and this broadcast
        // is precisely the signal that adding will work now.
        //
        // Requires a real top-level window: message-only windows (HWND_MESSAGE parent) do NOT
        // receive broadcasts. Ours passes a null parent, so it does — do not "tidy" that.
        m if m != 0 && m == TASKBAR_CREATED.load(Ordering::Relaxed) => {
            on_taskbar_created();
            0
        }
        _ => DefWindowProcW(h, msg, w, l),
    }
}

/// The tray icon's callback: a right-click opens the menu, a double-click opens the UI.
unsafe fn on_tray_callback(h: HWND, l: LPARAM) {
    match l as u32 {
        WM_RBUTTONUP => show_menu(h),
        WM_LBUTTONDBLCLK => open_current_ui(),
        _ => {}
    }
}

/// A menu item, by its id (the low word of wParam).
fn on_command(h: HWND, w: WPARAM) {
    match w & 0xFFFF {
        ID_OPEN => open_current_ui(),
        ID_REBUILD => start_worker(h, true),
        ID_RESTART => restart_in_mode(h, false),
        ID_SAFE_MODE => restart_in_mode(h, true),
        ID_ACTION => start_action(h),
        ID_QUIT => quit_app(h),
        _ => {}
    }
}

fn on_timer(h: HWND, w: WPARAM) {
    match w {
        TIMER_HEALTH => health_tick(),
        TIMER_SENTINEL => sentinel_tick(h),
        _ => {}
    }
}

/// The outcome a worker posted back: the balloon it earns, or the window it re-opens.
fn on_worker_done(w: WPARAM) {
    let a = app();
    match w {
        WORK_BUILD_FAILED => balloon(
            &format!("Build failed. See misc\\{}.", a.cfg.rebuild_log_name),
            NIIF_ERROR,
        ),
        WORK_OK_NOT_READY => balloon(
            &format!("Restarted, but {} isn't answering yet.", a.cfg.display_name),
            NIIF_WARNING,
        ),
        WORK_OK_READY => {
            // A rebuild is "show me the new build"; a plain Restart is not.
            if a.was_rebuild.load(Ordering::Relaxed) {
                open_current_ui();
            }
        }
        WORK_ACTION_OK => balloon(
            &a.cfg.action_ok_text.replace("{APP}", &a.cfg.display_name),
            NIIF_INFO,
        ),
        WORK_ACTION_FAILED => balloon(
            &a.cfg.action_fail_text.replace("{APP}", &a.cfg.display_name),
            NIIF_WARNING,
        ),
        WORK_ACTION_NO_DAEMON => balloon(
            &format!("{} isn't running.", a.cfg.display_name),
            NIIF_WARNING,
        ),
        _ => {}
    }
}

/// The taskbar was recreated: the icon is gone with the old one, so the next sync adds it again.
fn on_taskbar_created() {
    ICON_SHOWN.store(false, Ordering::Relaxed);
    sync_icon_visibility();
}
