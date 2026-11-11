//! Stopping the daemon: the graceful request, then the kill of whatever still holds its ports.

use super::http::{port_of, request_shutdown, split_url};
use super::probe::{health_ok, live_url};
use super::{CREATE_NO_WINDOW, PROBE_POLL};
use crate::config::Config;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// PIDs LISTENING on a port, via netstat (always present).
///
/// Plain `netstat -ano`, NOT `-p tcp`, so IPv4 and IPv6 listeners are both included. That omission
/// is deliberate in the original and must not be "cleaned up".
pub fn port_pids(port: u16) -> Vec<u32> {
    let Ok(out) = Command::new("netstat")
        .args(["-ano"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let suffix = format!(":{port}");
    let mut pids = Vec::new();
    for line in text.lines() {
        if !line.contains("LISTENING") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        if !parts[1].ends_with(&suffix) {
            continue;
        }
        if let Ok(pid) = parts[4].parse::<u32>() {
            if pid > 0 && !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

pub fn taskkill(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn is_port_listening(port: u16) -> bool {
    !port_pids(port).is_empty()
}

/// Wait for the listen socket to actually release after a force-kill (Windows can hold it briefly),
/// so a follow-on start does not lose the port race. 150 ms grid, matching Wait-PortFree.
pub fn wait_port_free(port: u16, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if !is_port_listening(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Stop the live daemon, in the PowerShell host's two flavours.
///
/// Token flavour: graceful POST first (unless `skip_graceful`, which Quit sets because it already
/// ran its own bounded POST and a second 20s attempt would turn Quit into a ~30 s hang), then poll
/// 40x250 ms for it to go, then force-kill the port owners and settle 20x200 ms.
/// Force-kill flavour: straight to the kill, then settle 25x200 ms.
///
/// Both cover BOTH the preferred port and the pointer's actually-bound port, which is what handles
/// a daemon that hopped.
pub fn stop(cfg: &Config, token: &str, force_kill: bool, skip_graceful: bool) {
    let url = live_url(cfg, PROBE_POLL);
    if token.is_empty() {
        kill_port_owners(cfg, url.as_deref());
        wait_gone(cfg, 25, 200);
        return;
    }
    let Some(url) = url.as_deref() else { return };
    if !force_kill {
        return; // only ever act on a daemon we own
    }
    let graceful = !skip_graceful && request_shutdown(cfg, url, token, Duration::from_secs(20));
    if graceful && wait_gone(cfg, 40, 250) {
        return;
    }
    kill_port_owners(cfg, Some(url));
    wait_gone(cfg, 20, 200);
}

/// Poll for the daemon to go: up to `polls` checks, with a `nap_ms` sleep after each one that still
/// finds it. True once it is gone.
fn wait_gone(cfg: &Config, polls: u32, nap_ms: u64) -> bool {
    for _ in 0..polls {
        if live_url(cfg, PROBE_POLL).is_none() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(nap_ms));
    }
    false
}

/// The ports a stop may force-kill, decided from the live URL the probe just confirmed.
///
/// Only that URL's port qualifies. `live_url` returns a URL only after `/api/health` names this
/// service, so its port is ours. The configured port is never a target on its own: a daemon that
/// hopped off it leaves that port to whatever else holds it, and with no confirmed daemon there is
/// no target at all.
pub fn kill_ports(confirmed_url: Option<&str>) -> Vec<u16> {
    match confirmed_url.and_then(port_of) {
        Some(p) if p > 0 => vec![p],
        _ => Vec::new(),
    }
}

fn kill_port_owners(cfg: &Config, url: Option<&str>) {
    let host = url
        .and_then(split_url)
        .map(|(h, _)| h)
        .unwrap_or_else(|| cfg.url_host.clone());
    for port in kill_ports(url) {
        // Re-confirm just before the kill: the probe ran a moment ago, and the port may have changed
        // hands since. Nothing is killed on a port that no longer answers as this service.
        if !health_ok(&host, port, &cfg.service_name, PROBE_POLL) {
            continue;
        }
        for pid in port_pids(port) {
            taskkill(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::kill_ports;

    // Old rule, for reference: always the configured port (7787), plus the live URL's port. These
    // tests assert the new rule, so they fail on the old one: it killed 7787 with no daemon found,
    // and killed 7787 next to a hopped daemon's port.

    #[test]
    fn no_confirmed_daemon_kills_nothing() {
        assert!(kill_ports(None).is_empty());
    }

    #[test]
    fn daemon_on_preferred_port_kills_only_that_port() {
        assert_eq!(kill_ports(Some("http://127.0.0.1:7787")), vec![7787]);
    }

    #[test]
    fn hopped_daemon_leaves_the_preferred_port_alone() {
        assert_eq!(kill_ports(Some("http://127.0.0.1:7790")), vec![7790]);
    }

    #[test]
    fn url_without_a_usable_port_kills_nothing() {
        assert!(kill_ports(Some("http://127.0.0.1")).is_empty());
        assert!(kill_ports(Some("http://127.0.0.1:0")).is_empty());
    }
}
