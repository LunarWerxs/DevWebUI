//! Startup, after the config is read: the single-instance claim, the first-run steps and the daemon's
//! spawn, the tray window and its first balloon, and the message loop that runs until Quit.

use crate::config::{Config, StrayPolicy};
use crate::tray::icon::{balloon, remove_tray_icon, sync_icon_visibility, TASKBAR_CREATED};
use crate::tray::menu::open_current_ui;
use crate::tray::wndproc::wndproc;
use crate::tray::worker::hidden_cmd;
use crate::win::*;
use crate::{
    app, browser, daemon, get_url, set_url, App, Ui, HEALTH_INTERVAL_MS, SENTINEL_INTERVAL_MS,
    TIMER_HEALTH, TIMER_SENTINEL, UI,
};
use std::path::Path;
use std::ptr::null_mut;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// A shutdown token, from the OS CSPRNG. Only a daemon this session started knows it, which is what
/// makes `POST /api/shutdown` safe to expose on a passwordless loopback API.
pub(crate) fn new_token() -> String {
    #[link(name = "advapi32")]
    extern "system" {
        #[link_name = "SystemFunction036"]
        fn RtlGenRandom(buf: *mut u8, len: u32) -> u8;
    }
    let mut bytes = [0u8; 16];
    let ok = unsafe { RtlGenRandom(bytes.as_mut_ptr(), bytes.len() as u32) };
    if ok == 0 {
        // Never fall back to something predictable; without randomness, run untokened instead.
        return String::new();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Claims the single-instance mutex. `None` means another tray host already holds it, and the
/// loser has opened the running UI (unless `background`), so the caller exits without a second icon.
pub(crate) fn claim_single_instance(cfg: &Config, background: bool) -> Option<HANDLE> {
    let mutex_name = wide(&cfg.mutex_name);
    let mutex = unsafe { CreateMutexW(null_mut(), 1, mutex_name.as_ptr()) };
    let already_hosted = mutex.is_null() || unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if already_hosted {
        if !background {
            open_running_host(cfg);
        }
        return None;
    }
    Some(mutex)
}

/// The loser of the single-instance race: open the running UI, or say the winner is still starting.
fn open_running_host(cfg: &Config) {
    match daemon::live_url(cfg, daemon::PROBE_POLL) {
        Some(url) => browser::open_ui(cfg, &url),
        // Nothing serving yet means the winner is still cold-starting. Opening a browser at a
        // guessed URL would just show connection-refused, so say so instead.
        None => message_box(
            &cfg.display_name,
            &format!(
                "{} is already starting in the tray. Wait a moment, then open it from the tray icon.",
                cfg.display_name
            ),
            MB_ICONWARNING,
        ),
    }
}

/// True when a daemon is serving without our tray and the policy says to warn and stop.
pub(crate) fn warned_about_stray_daemon(cfg: &Config, existing: Option<&str>) -> bool {
    let Some(url) = existing else { return false };
    if cfg.on_stray_daemon != StrayPolicy::Warn {
        return false;
    }
    message_box(
        &cfg.display_name,
        &format!(
            "{} is already serving at {url}, but the tray icon is not running. Stop that process, then run the shortcut again.",
            cfg.display_name
        ),
        MB_ICONWARNING,
    );
    true
}

/// First-run bootstrap (blocking, once) before the daemon can possibly work, then spawn it.
/// Split out of `main` along with `report_not_serving_and_teardown` below so `main` reads as the
/// startup sequence and each non-trivial step's own branching lives in its own named function.
/// Returns false having already reported the failure — the caller must then return immediately.
pub(crate) fn bootstrap_and_spawn_daemon(cfg: &Config, token: &str) -> bool {
    for step in &cfg.first_run {
        if cfg.app_root.join(&step.missing).exists() {
            continue;
        }
        let _ = hidden_cmd(format!(
            "/c \"cd /d \"{}\" && {}\"",
            cfg.app_root.display(),
            step.run
        ))
        .status();
    }
    // SPAWNED BEFORE ANY UI IS BUILT. This is the whole point: the daemon's ~120 ms boot runs
    // concurrently with our window, icon and menu setup rather than after it.
    if daemon::spawn(cfg, token, "tray start").is_some() {
        return true;
    }
    message_box(
        &cfg.display_name,
        &format!(
            "{} could not start its background process.",
            cfg.display_name
        ),
        MB_ICONERROR,
    );
    false
}

/// "Started but not serving" guidance, torn down and reported. One app's overwhelmingly likely
/// cause is a missing configuration step, and the honest answer is to say which command to run
/// rather than leave a tray icon that quietly does nothing. Returns true when this fired — the
/// caller must then return immediately: a half-started app with a tray icon invites the user to
/// keep clicking it.
unsafe fn report_not_serving_and_teardown(a: &App) -> bool {
    let Some(hint) = a.cfg.not_serving_hint.clone() else {
        return false;
    };
    daemon::stop(&a.cfg, &a.token, true, false);
    let pid = daemon::CHILD_PID.swap(0, Ordering::SeqCst);
    if pid > 0 {
        daemon::taskkill(pid);
    }
    remove_tray_icon();
    message_box(&a.cfg.display_name, &hint, MB_ICONWARNING);
    true
}

/// Build the (invisible) message window and the tray icon, start the health/sentinel timers, and
/// show the "running in the tray" balloon. Split out of `main` for the same reason as its
/// siblings above. Returns the message window's handle, needed by the message loop and the final
/// `DestroyWindow`.
unsafe fn create_tray_window(display_name: &str, icon_file: &Path, mutex: HANDLE) -> HWND {
    let hinst = GetModuleHandleW(null_mut());
    let class = wide("LunarWerxTrayHost");
    let mut wc: WNDCLASSW = std::mem::zeroed();
    wc.lpfnWndProc = Some(wndproc);
    wc.hInstance = hinst;
    wc.lpszClassName = class.as_ptr();
    RegisterClassW(&wc);
    // A plain top-level window, zero-sized and never shown. It exists to receive the tray
    // callback and timer ticks — but it must NOT become a message-only window (HWND_MESSAGE
    // parent), because those are excluded from broadcasts and TaskbarCreated is a broadcast.
    let title = wide(display_name);
    let hwnd = CreateWindowExW(
        0,
        class.as_ptr(),
        title.as_ptr(),
        0,
        0,
        0,
        0,
        0,
        null_mut(),
        null_mut(),
        hinst,
        null_mut(),
    );

    let icon_path = wide(&icon_file.to_string_lossy());
    let hicon = LoadImageW(
        null_mut(),
        icon_path.as_ptr(),
        IMAGE_ICON,
        0,
        0,
        LR_LOADFROMFILE | LR_DEFAULTSIZE,
    );

    // Subscribe to the taskbar-recreated broadcast BEFORE the icon exists, so a restart that
    // lands during our own startup is still caught.
    TASKBAR_CREATED.store(
        RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()),
        Ordering::Relaxed,
    );

    let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
    nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = hwnd;
    nid.uID = 1;
    nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    nid.uCallbackMessage = WM_APP_TRAY;
    nid.hIcon = hicon;
    fill(&mut nid.szTip, display_name);

    UI.with(|ui| {
        *ui.borrow_mut() = Some(Ui {
            nid,
            mutex,
            health: None,
            tip: display_name.to_string(),
        })
    });
    // The ADD itself: ICON_SHOWN starts false, so this is the initial add as well as the
    // hide-gate. If it fails, the health tick retries every 5s and TaskbarCreated re-fires it.
    sync_icon_visibility();

    SetTimer(hwnd, TIMER_HEALTH, HEALTH_INTERVAL_MS, null_mut());
    if app().cfg.sentinel_file.is_some() {
        SetTimer(hwnd, TIMER_SENTINEL, SENTINEL_INTERVAL_MS, null_mut());
    }

    if app().unclean_exit_seen.load(Ordering::Relaxed) {
        balloon(
            &format!(
                "{display_name} did not shut down cleanly last time. If it misbehaves, right-click > Restart in Safe Mode."
            ),
            NIIF_WARNING,
        );
    } else {
        balloon("Running in the tray - right-click for options.", NIIF_INFO);
    }
    hwnd
}

/// The window path of startup: build the tray window, wait for the daemon's URL, report a daemon
/// that never serves, then pump messages until Quit.
pub(crate) unsafe fn run_tray(
    display_name: &str,
    icon_file: &Path,
    mutex: HANDLE,
    background: bool,
    startup_wait: Duration,
) {
    let hwnd = create_tray_window(display_name, icon_file, mutex);

    // Only now do we wait: by this point the daemon has had our entire setup as a head start.
    if get_url().is_none() {
        set_url(daemon::wait_for_url(&app().cfg, startup_wait));
    }

    let a = app();
    if get_url().is_none() && report_not_serving_and_teardown(a) {
        return;
    }
    if !background {
        open_current_ui();
    }

    run_message_loop();
    remove_tray_icon();
    DestroyWindow(hwnd);
}

unsafe fn run_message_loop() {
    let mut msg: MSG = std::mem::zeroed();
    while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}
