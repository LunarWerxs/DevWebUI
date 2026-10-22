//! Recording how a daemon wrapper died: the last death for the next spawn to name, the pid of the
//! wrapper while it runs, and the thread that watches each child until it ends.

use super::log::log_line;
use super::spawn::stderr_since;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A wrapper that ends non-zero inside this long never got its daemon going, and what it wrote to
/// stderr is the reason, so the death line quotes it.
const FAILED_LAUNCH: Duration = Duration::from_secs(10);

/// The last daemon death this process observed, so the NEXT spawn can name what it is answering.
/// A plain Mutex<Option<String>>: one writer per child thread, one reader per spawn, and a poisoned
/// lock here must never take the tray down - every access degrades to "no previous death".
static LAST_DEATH: Mutex<Option<String>> = Mutex::new(None);

pub(super) fn take_last_death() -> Option<String> {
    LAST_DEATH.lock().ok()?.take()
}

/// Drop the recorded death once a live daemon has been seen after it: a self-update relaunch
/// answers its own wrapper's death, and a revive hours later must not claim that one.
pub fn forget_last_death() {
    let _ = take_last_death();
}

/// The pid of the daemon wrapper this process spawned, for as long as that wrapper runs; 0 once it
/// has exited. It lives here because only the thread watching the child knows when the pid stops
/// being ours, and every reader hands it to `taskkill /T /F`: a pid kept past its process's exit
/// can be reused by any process on the machine, and its whole tree would go with it.
pub static CHILD_PID: AtomicU32 = AtomicU32::new(0);

fn set_last_death(text: String) {
    if let Ok(mut slot) = LAST_DEATH.lock() {
        *slot = Some(text);
    }
}

/// WATCH ONE DAEMON CHILD AND RECORD HOW IT DIED (owner ask, 2026-09-14/15).
///
/// AgentHydra's daemon died three times in one night (01:10Z, 04:23Z, 09:14:17Z, pids 79360 ->
/// 61040), was restarted within seconds, and left NOTHING behind: no `daemon.log` error, no Windows
/// Error Reporting entry naming the process, Task Scheduler history disabled. In-flight orchestrator
/// operations and a fan-out spawn were lost each time and the only evidence was a pid change.
/// AgentHydra's own crash-record covers what the JS process model can see; a process killed from
/// OUTSIDE it writes none of those, and the tray is the only witness left.
///
/// ⛔ `spawn` used to DROP the `Child`, which is why there was nothing to witness with: the exit
/// code existed for exactly as long as that value did. Holding it in a thread costs one parked
/// thread per daemon start and is the whole fix.
///
/// Two honest limits, stated rather than papered over:
/// * The child is the `cmd.exe /c` WRAPPER, not the daemon itself, so this reports the wrapper's
///   exit code. Under `/c` that is the command's own code, which is what we want - but a tree
///   killed with `taskkill /T` can take the wrapper down by its own route, so read the code as
///   "how the wrapper ended", not "what the daemon's last statement was".
/// * Windows has no signals; `ExitStatus::code()` is None only in exotic cases, and that is
///   reported as `unknown` rather than guessed at.
///
/// `said` is where this launch's stderr went and the offset it started at (`open_stderr_log`): a
/// launch that failed outright has its stderr quoted in the death line.
pub(super) fn watch_child(
    mut child: std::process::Child,
    log: PathBuf,
    said: Option<(PathBuf, u64)>,
) {
    let started = Instant::now();
    let pid = child.id();
    std::thread::spawn(move || {
        let status = child.wait();
        // While `child` is alive its handle pins the pid, so clearing it here, before the handle
        // drops, closes the reuse window. Only this child's own pid is cleared: a newer spawn owns
        // the slot by now if it already holds a different one.
        let _ = CHILD_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
        let up = started.elapsed();
        let failed = !matches!(&status, Ok(s) if s.success());
        let how = match status {
            Ok(s) => match s.code() {
                Some(c) => format!("exit code {c}"),
                None => "exit code unknown (terminated without one)".to_string(),
            },
            Err(e) => format!("could not be waited on: {e}"),
        };
        let mut text = format!("death of pid {pid} ({how}, up {:.1}s)", up.as_secs_f64());
        if failed && up < FAILED_LAUNCH {
            let reason = said
                .map(|(path, from)| stderr_since(&path, from))
                .unwrap_or_default();
            if !reason.is_empty() {
                text.push_str(&format!(" - it said: {reason}"));
            }
        }
        // Slot first, line second: whoever sees the line can rely on the slot already holding it.
        set_last_death(text.clone());
        log_line(&log, &text);
    });
}
