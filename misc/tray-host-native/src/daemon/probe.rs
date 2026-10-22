//! Finding the live daemon: whether a responder is ours, what it says about itself, and the URL it
//! actually bound.

use super::http::{open_socket, port_of, resolve, split_url};
use super::PROBE_POLL;
use crate::config::Config;
use crate::json::Json;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::{Duration, Instant};

/// What a responder that passed the identity rule says about itself. A field is None when the body
/// does not carry it (an older build, or a sibling app whose health has no version).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Health {
    pub version: Option<String>,
    pub distribution: Option<String>,
}

/// One `GET /api/health`, over a raw socket: the whole response (headers and body), or None when
/// nothing answered.
pub fn health_response(host: &str, port: u16, timeout: Duration) -> Option<String> {
    let mut sock = open_socket(host, port, timeout)?;
    let req =
        format!("GET /api/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if sock.write_all(req.as_bytes()).is_err() {
        return None;
    }
    let mut body = String::new();
    let mut buf = [0u8; 4096];
    loop {
        match sock.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                body.push_str(&String::from_utf8_lossy(&buf[..n]));
                if body.len() > 64 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = sock.shutdown(Shutdown::Both);
    Some(body)
}

/// Identity and version from one health response.
///
/// The identity rule is the PowerShell host's, unchanged and load-bearing: a responder is ours only
/// when the body carries `"ok":true` AND a `"service"` equal to ours. Silence is not identity and
/// neither is a 200 - a Vite dev server on a neighbouring port answers /api/health with its SPA
/// fallback, which is how a sibling app once latched onto a stranger and reported the wrong thing
/// in both directions. Only a responder that passes it is read for `version` and `distribution`.
pub fn health_of(response: &str, service: &str) -> Option<Health> {
    if !(response.contains("\"ok\":true")
        && response.contains(&format!("\"service\":\"{service}\"")))
    {
        return None;
    }
    let body = response.split_once("\r\n\r\n").map_or("", |(_, body)| body);
    let json = crate::json::parse(body);
    let field = |key: &str| {
        json.as_ref()
            .and_then(|v| v.str_at(key))
            .map(str::to_string)
    };
    Some(Health {
        version: field("version"),
        distribution: field("distribution"),
    })
}

/// Whether the responder at host:port is ours (the identity rule of `health_of`).
pub fn health_ok(host: &str, port: u16, service: &str, timeout: Duration) -> bool {
    probe(host, port, service, timeout).is_some()
}

fn probe(host: &str, port: u16, service: &str, timeout: Duration) -> Option<Health> {
    health_response(host, port, timeout).and_then(|r| health_of(&r, service))
}

/// The runtime pointer (the info file) parsed as JSON, or None when it is missing or unreadable.
pub(super) fn read_pointer(cfg: &Config) -> Option<Json> {
    std::fs::read_to_string(&cfg.info_file)
        .ok()
        .and_then(|s| crate::json::parse(&s))
}

/// The URL of a live instance, or None.
///
/// The runtime pointer's `url` is tried FIRST and VERBATIM, which matters for more than speed: the
/// daemon writes the host it actually bound (127.0.0.1), while an app's configured `urlHost` may be
/// the friendlier "localhost". Those are not the same thing here - localhost can resolve to ::1
/// first, and a daemon listening only on 127.0.0.1 then looks dead. Probing the pointer's own URL
/// asks the daemon where it is instead of guessing.
///
/// The configured host and preferred port remain the fallback for the window before the pointer
/// exists. Identity is validated either way; a pointer is never trusted on its own.
pub fn live_url(cfg: &Config, timeout: Duration) -> Option<String> {
    live_probe(cfg, timeout).map(|(url, _)| url)
}

/// `live_url` with the health the probe read alongside it. The watchdog's tick takes both from this
/// one request, so the tray's tooltip shows the version without a second probe.
pub fn live_probe(cfg: &Config, timeout: Duration) -> Option<(String, Health)> {
    let pointer = read_pointer(cfg);
    pointed_url_probe(pointer.as_ref(), cfg, timeout)
        .or_else(|| pointed_port_probe(pointer.as_ref(), cfg, timeout))
        .or_else(|| probe_endpoint(&cfg.url_host, cfg.port, cfg, timeout))
}

/// The pointer's own `url`, probed first and verbatim (see `live_url`).
fn pointed_url_probe(
    pointer: Option<&Json>,
    cfg: &Config,
    timeout: Duration,
) -> Option<(String, Health)> {
    let url = pointer?.str_at("url")?;
    let (host, port) = split_url(url)?;
    let health = probe(&host, port, &cfg.service_name, timeout)?;
    Some((url.to_string(), health))
}

/// A pointer written by an older daemon may carry only the port.
fn pointed_port_probe(
    pointer: Option<&Json>,
    cfg: &Config,
    timeout: Duration,
) -> Option<(String, Health)> {
    let port = pointer?.num_at("port")? as u16;
    probe_endpoint("127.0.0.1", port, cfg, timeout)
}

/// Probe `host:port`, named by the URL it answers on. Port 0 is never a bound port, so it is skipped.
fn probe_endpoint(
    host: &str,
    port: u16,
    cfg: &Config,
    timeout: Duration,
) -> Option<(String, Health)> {
    if port == 0 {
        return None;
    }
    let health = probe(host, port, &cfg.service_name, timeout)?;
    Some((format!("http://{host}:{port}"), health))
}

/// Whether the daemon's port still takes a connection, for a daemon that did not answer its
/// health probe.
///
/// Windows completes a TCP handshake from the listen backlog without the process's help, so a
/// daemon whose event loop is blocked still accepts here and a dead one does not. Measured
/// against a Bun server frozen in a busy loop: the connect took under 1 ms while the request got
/// nothing for the whole freeze. The watchdog reads this as busy, not dead.
pub fn port_accepts(cfg: &Config, timeout: Duration) -> bool {
    let pointer = read_pointer(cfg);
    let mut targets = Vec::new();
    if let Some(target) = pointer
        .as_ref()
        .and_then(|v| v.str_at("url"))
        .and_then(split_url)
    {
        targets.push(target);
    }
    if cfg.port != 0 {
        targets.push((cfg.url_host.clone(), cfg.port));
    }
    targets.iter().any(|(host, port)| {
        resolve(host, *port).is_some_and(|addr| TcpStream::connect_timeout(&addr, timeout).is_ok())
    })
}

/// The ports a replacement daemon would collide on: the configured one and the one the runtime
/// pointer names.
pub fn revive_ports(cfg: &Config) -> Vec<u16> {
    let mut ports = Vec::new();
    let pointed = read_pointer(cfg).and_then(|v| v.str_at("url").and_then(port_of));
    for p in [Some(cfg.port), pointed].into_iter().flatten() {
        if p > 0 && !ports.contains(&p) {
            ports.push(p);
        }
    }
    ports
}

/// Wait for the daemon to come up and return the URL it ACTUALLY bound.
///
/// The interval RAMPS rather than sitting flat: this loop is the last thing between the daemon
/// being ready and the user's window opening, and once a daemon boots in ~120 ms a flat 250 ms grid
/// costs more on average than the boot it is waiting on.
pub fn wait_for_url(cfg: &Config, budget: Duration) -> Option<String> {
    let started = Instant::now();
    while started.elapsed() < budget {
        if let Some(u) = live_url(cfg, PROBE_POLL) {
            return Some(u);
        }
        let waited = started.elapsed().as_millis();
        let nap = if waited < 1000 {
            15
        } else if waited < 4000 {
            100
        } else {
            250
        };
        std::thread::sleep(Duration::from_millis(nap));
    }
    live_url(cfg, PROBE_POLL)
}
