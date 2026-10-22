//! The tray icon: its balloons, its visibility, its tooltip, and its removal. All of it runs on the
//! UI thread, through the thread-local `UI` in main.rs.

use crate::win::*;
use crate::{app, daemon, json, UI};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

pub(crate) fn balloon(text: &str, flag: u32) {
    UI.with(|ui| {
        let mut slot = ui.borrow_mut();
        let Some(ui) = slot.as_mut() else { return };
        ui.nid.uFlags = NIF_INFO;
        ui.nid.dwInfoFlags = flag;
        fill(&mut ui.nid.szInfoTitle, &app().cfg.display_name);
        fill(&mut ui.nid.szInfo, text);
        unsafe { Shell_NotifyIconW(NIM_MODIFY, &mut ui.nid) };
        // Restore the steady-state flags so a later MODIFY (e.g. the visibility sync) does not
        // re-fire the balloon.
        ui.nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    });
}

/// Whether the SHELL currently holds our icon. Recorded from Shell_NotifyIcon's real return value,
/// never assumed.
///
/// This used to default to `true` on the theory that the startup NIM_ADD had obviously worked.
/// NIM_ADD genuinely fails — the taskbar not existing yet at logon is the common one, and Microsoft
/// documents retrying — and treating a failure as success meant the sync below saw "already shown"
/// forever and never retried. The symptom is the worst kind: the app runs perfectly, there is no
/// icon anywhere (not even in the Windows 11 overflow flyout), and relaunching the shortcut hits
/// the single-instance branch and just opens the UI, so nothing the user can do brings it back.
/// Starting at `false` makes the health tick's sync a free five-second retry loop.
pub(crate) static ICON_SHOWN: AtomicBool = AtomicBool::new(false);

/// The shell's "TaskbarCreated" broadcast id, resolved once at startup (0 until then).
pub(crate) static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);

/// The "hide tray icon" opt-in, read fresh from the runtime pointer every time. A missing or
/// unreadable pointer means visible: the icon is how the user reaches Quit.
fn hide_tray_icon_setting() -> bool {
    std::fs::read_to_string(&app().cfg.info_file)
        .ok()
        .and_then(|s| json::parse(&s))
        .map(|v| v.flag_at("hideTrayIcon"))
        .unwrap_or(false)
}

/// Live-sync the icon's visibility from the runtime pointer, so flipping "hide tray icon" in the
/// web UI takes effect within one tick without restarting anything.
///
/// Windows has no "hide a NotifyIcon" call, so hiding is DELETE and showing is ADD; the tray data
/// itself is kept either way, because the menu, the timers and Quit all hang off it. Also the
/// retry path for a failed ADD, and the re-add path after Explorer restarts (see wndproc).
pub(crate) fn sync_icon_visibility() {
    let hidden = hide_tray_icon_setting();
    UI.with(|ui| {
        let mut slot = ui.borrow_mut();
        let Some(ui) = slot.as_mut() else { return };
        let shown = ICON_SHOWN.load(Ordering::Relaxed);
        if hidden && shown {
            unsafe { Shell_NotifyIconW(NIM_DELETE, &mut ui.nid) };
            ICON_SHOWN.store(false, Ordering::Relaxed);
        } else if !hidden && !shown {
            // Restore the steady-state flags: a balloon leaves NIF_INFO behind if it fired between
            // the icon going away and this add.
            ui.nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            let added = unsafe { Shell_NotifyIconW(NIM_ADD, &mut ui.nid) } != 0;
            ICON_SHOWN.store(added, Ordering::Relaxed);
        }
    });
}

/// The tooltip: the display name, then the running version and distribution when the daemon's
/// health names one (Safe Mode replaces the distribution). Without a version it is the plain name,
/// with " (Safe Mode)" added in safe mode.
fn tip_text(name: &str, health: Option<&daemon::Health>, safe: bool) -> String {
    let Some(version) = health.and_then(|h| h.version.as_deref()) else {
        return if safe {
            format!("{name} (Safe Mode)")
        } else {
            name.to_string()
        };
    };
    let mode = if safe {
        Some("Safe Mode")
    } else {
        health.and_then(|h| h.distribution.as_deref())
    };
    match mode {
        Some(mode) => format!("{name} {version} ({mode})"),
        None => format!("{name} {version}"),
    }
}

/// Stores the health behind the tooltip and rewrites it. NIM_MODIFY is sent only while the icon is
/// shown and the text changed; a hidden icon takes the new text on its next NIM_ADD.
pub(crate) fn set_tip(health: Option<daemon::Health>) {
    let safe = daemon::SAFE_MODE.load(Ordering::Relaxed);
    let name = app().cfg.display_name.clone();
    UI.with(|ui| {
        let mut slot = ui.borrow_mut();
        let Some(ui) = slot.as_mut() else { return };
        let tip = tip_text(&name, health.as_ref(), safe);
        ui.health = health;
        if tip == ui.tip {
            return;
        }
        fill(&mut ui.nid.szTip, &tip);
        ui.tip = tip;
        if ICON_SHOWN.load(Ordering::Relaxed) {
            ui.nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            unsafe { Shell_NotifyIconW(NIM_MODIFY, &mut ui.nid) };
        }
    });
}

/// Removes the tray icon and releases the single-instance mutex. Used by Quit, by the not-serving
/// teardown, and when the message loop ends.
pub(crate) unsafe fn remove_tray_icon() {
    UI.with(|ui| {
        let mut slot = ui.borrow_mut();
        if let Some(ui) = slot.as_mut() {
            Shell_NotifyIconW(NIM_DELETE, &mut ui.nid);
            if !ui.mutex.is_null() {
                ReleaseMutex(ui.mutex);
                CloseHandle(ui.mutex);
                ui.mutex = null_mut();
            }
        }
    });
}
