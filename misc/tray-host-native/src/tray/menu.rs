//! The right-click menu, and the double-click that opens the UI.

use crate::tray::icon::balloon;
use crate::win::*;
use crate::{
    app, browser, daemon, get_url, ID_ACTION, ID_OPEN, ID_QUIT, ID_REBUILD, ID_RESTART,
    ID_SAFE_MODE,
};
use std::ptr::null_mut;
use std::sync::atomic::Ordering;

pub(crate) unsafe fn show_menu(hwnd: HWND) {
    let a = app();
    let menu = CreatePopupMenu();
    let busy = a.busy.load(Ordering::Relaxed);
    let grey = if busy { MF_GRAYED } else { 0 };

    let open = wide(&a.cfg.menu_open_label);
    AppendMenuW(menu, MF_STRING, ID_OPEN, open.as_ptr());
    // "Rebuild & Restart" only exists in a dev tree: a distributed build ships no source, so
    // rebuilding there could only fail. Triple-gated, exactly as before (menu, dispatch, worker).
    if a.cfg.is_dev_tree && a.cfg.rebuild_command.is_some() {
        let rebuild = wide("Rebuild && Restart");
        AppendMenuW(menu, MF_STRING | grey, ID_REBUILD, rebuild.as_ptr());
    }
    // In safe mode, Restart is the way back out, and says so.
    let safe = daemon::SAFE_MODE.load(Ordering::Relaxed);
    let restart = wide(if safe { "Restart Normally" } else { "Restart" });
    AppendMenuW(menu, MF_STRING | grey, ID_RESTART, restart.as_ptr());
    if !safe && a.unclean_exit_seen.load(Ordering::Relaxed) {
        let safe_item = wide("Restart in Safe Mode");
        AppendMenuW(menu, MF_STRING | grey, ID_SAFE_MODE, safe_item.as_ptr());
    }
    // The app-action item, for apps that supervise WORK the daemon owns rather than just the
    // daemon itself: Restart and Quit act on the daemon, this acts on what the daemon is running.
    if a.cfg.action_path.is_some() {
        let label = wide(&a.cfg.action_label);
        AppendMenuW(menu, MF_STRING | grey, ID_ACTION, label.as_ptr());
    }
    AppendMenuW(menu, MF_SEPARATOR, 0, null_mut());
    let quit = wide("Quit");
    AppendMenuW(menu, MF_STRING, ID_QUIT, quit.as_ptr());

    let mut pt = POINT::default();
    GetCursorPos(&mut pt);
    // Required, or the menu never dismisses when focus moves elsewhere.
    SetForegroundWindow(hwnd);
    TrackPopupMenu(menu, TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, null_mut());
    DestroyMenu(menu);
}

pub(crate) fn open_current_ui() {
    match get_url() {
        Some(url) => browser::open_ui(&app().cfg, &url),
        None => balloon(
            &format!("{} isn't running.", app().cfg.display_name),
            NIIF_WARNING,
        ),
    }
}
