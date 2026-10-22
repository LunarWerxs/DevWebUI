//! Stopping the daemon: the graceful request, then the kill of whatever still holds its ports.

use super::http::{port_of, request_shutdown};
use super::probe::live_url;
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
        kill_port_owners(cfg, url.as_deref().unwrap_or(""));
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
    kill_port_owners(cfg, url);
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

fn kill_port_owners(cfg: &Config, url: &str) {
    let mut ports = vec![cfg.port];
    if let Some(p) = port_of(url) {
        if p > 0 && !ports.contains(&p) {
            ports.push(p);
        }
    }
    for port in ports {
        if port == 0 {
            continue;
        }
        for pid in port_pids(port) {
            taskkill(pid);
        }
    }
}
