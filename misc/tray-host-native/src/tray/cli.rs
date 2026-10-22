//! The command line, and where the config file is looked for.

use std::path::PathBuf;

/// The command line: an optional config file and `--background`, which starts the tray (or finds
/// it running) WITHOUT opening the UI. For an app's own window launcher that starts the tray beside
/// the window it is already opening: without it the tray opens a second copy.
pub(crate) struct Args {
    pub(crate) config: Option<String>,
    pub(crate) background: bool,
}

pub(crate) fn parse_args(args: impl IntoIterator<Item = String>) -> Args {
    let mut out = Args {
        config: None,
        background: false,
    };
    for a in args {
        if a == "--background" {
            out.background = true;
        } else if out.config.is_none() && !a.starts_with("--") {
            out.config = Some(a);
        }
    }
    out
}

pub(crate) fn config_path() -> PathBuf {
    if let Some(arg) = parse_args(std::env::args().skip(1)).config {
        let p = PathBuf::from(&arg);
        if p.is_absolute() {
            return p;
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                return dir.join(arg);
            }
        }
        return p;
    }
    let mut p = std::env::current_exe().expect("exe path");
    p.set_extension("json");
    p
}
