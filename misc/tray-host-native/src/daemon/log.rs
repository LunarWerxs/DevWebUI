//! The tray's own log: one line per event, appended beside the rebuild log.

use crate::config::Config;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

/// One line in the tray log, for the watchdog's own record.
pub fn tray_log(cfg: &Config, text: &str) {
    log_line(&log_path(cfg), text);
}

/// Where the tray's own log lives: beside the rebuild log, under the script dir.
pub(super) fn log_path(cfg: &Config) -> PathBuf {
    cfg.script_dir.join(&cfg.tray_log_name)
}

/// Append ONE line, best effort. A tray that cannot write its log still runs the app: this is a
/// witness, never a dependency, so every failure here is swallowed deliberately.
pub(super) fn log_line(path: &Path, text: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {text}", crate::win::local_timestamp());
    }
}
