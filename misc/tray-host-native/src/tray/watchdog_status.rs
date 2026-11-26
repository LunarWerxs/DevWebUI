//! The watchdog's status file, `tray-watchdog.json`, beside the runtime pointer, for any window that
//! wants to say why the daemon is down. Written only when the watchdog's state changes, atomically
//! (a temp file, then a rename), and best effort: a failure here never stops the tray.

use crate::daemon::DeathInfo;
use crate::json::{self, Json};
use crate::tray::watchdog::Status;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const STATUS_FILE: &str = "tray-watchdog.json";
/// The daemon's last output in the file is cut to this many characters.
const SAID_MAX: usize = 300;

/// Write `status` into `dir` (the runtime pointer's folder). Best effort: every error is dropped.
pub(crate) fn write(dir: &Path, status: &Status, last_death: Option<&DeathInfo>) {
    let _ = try_write(dir, status, last_death);
}

fn try_write(dir: &Path, status: &Status, last_death: Option<&DeathInfo>) -> std::io::Result<()> {
    let text = json::to_string(&render(status, last_death, epoch_ms()));
    let path = dir.join(STATUS_FILE);
    let temp = dir.join(format!("{STATUS_FILE}.tmp"));
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, &path)
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The file's shape, exactly: the state, the reason, the revives in the window, the next revive
/// (epoch ms or null), when this was written (epoch ms), and the last death (or null).
fn render(status: &Status, last_death: Option<&DeathInfo>, at_ms: u64) -> Json {
    let death = match last_death {
        None => Json::Null,
        Some(d) => Json::Obj(vec![
            ("pid".into(), Json::Num(d.pid.to_string())),
            (
                "exitCode".into(),
                d.exit_code
                    .map(|c| Json::Num(c.to_string()))
                    .unwrap_or(Json::Null),
            ),
            ("upSec".into(), Json::Num(format!("{:.1}", d.up_secs))),
            (
                "said".into(),
                Json::Str(d.said.chars().take(SAID_MAX).collect()),
            ),
        ]),
    };
    Json::Obj(vec![
        ("state".into(), Json::Str(status.state.into())),
        ("reason".into(), Json::Str(status.reason.clone())),
        ("revives".into(), Json::Num(status.revives.to_string())),
        (
            "nextReviveAt".into(),
            status
                .next_revive_ms
                .map(|ms| Json::Num(ms.to_string()))
                .unwrap_or(Json::Null),
        ),
        ("at".into(), Json::Num(at_ms.to_string())),
        ("lastDeath".into(), death),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_has_the_agreed_shape_and_the_null_fields_are_null() {
        let status = Status {
            state: "backoff",
            reason: "watchdog: x \"quoted\"".into(),
            revives: 4,
            next_revive_ms: None,
        };
        let text = json::to_string(&render(&status, None, 7));
        let back = json::parse(&text).expect("valid json");
        assert_eq!(back.str_at("state"), Some("backoff"));
        assert_eq!(back.str_at("reason"), Some("watchdog: x \"quoted\""));
        assert_eq!(back.num_at("revives"), Some(4.0));
        assert_eq!(back.num_at("at"), Some(7.0));
        assert!(back.get("nextReviveAt") == Some(&Json::Null));
        assert!(back.get("lastDeath") == Some(&Json::Null));
    }

    #[test]
    fn the_last_death_carries_its_fields_and_a_long_output_is_cut() {
        let death = DeathInfo {
            pid: 42,
            exit_code: None,
            up_secs: 3.25,
            said: "x".repeat(400),
        };
        let status = Status {
            state: "reviving",
            reason: String::new(),
            revives: 0,
            next_revive_ms: Some(9),
        };
        let back = json::parse(&json::to_string(&render(&status, Some(&death), 1))).unwrap();
        assert_eq!(back.num_at("nextReviveAt"), Some(9.0));
        let d = back.get("lastDeath").expect("lastDeath");
        assert_eq!(d.num_at("pid"), Some(42.0));
        assert!(d.get("exitCode") == Some(&Json::Null));
        assert_eq!(d.num_at("upSec"), Some(3.2));
        assert_eq!(d.str_at("said").map(|s| s.chars().count()), Some(SAID_MAX));
    }
}
