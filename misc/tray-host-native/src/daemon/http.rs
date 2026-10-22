//! The sockets the tray talks to the daemon with: resolving its URL, the shutdown request and the
//! app-action POST. Each request opens its own connection.

use crate::config::Config;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Split `http://host:port/...` into its host and port.
pub(super) fn split_url(url: &str) -> Option<(String, u16)> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split('/').next()?;
    let (host, port) = authority.rsplit_once(':')?;
    Some((host.to_string(), port.parse().ok()?))
}

pub(super) fn port_of(url: &str) -> Option<u16> {
    split_url(url).map(|(_, p)| p)
}

/// The first address `host:port` resolves to.
pub(super) fn resolve(host: &str, port: u16) -> Option<SocketAddr> {
    use std::net::ToSocketAddrs;
    (host, port).to_socket_addrs().ok()?.next()
}

/// A connected socket to `host:port`, with both directions capped at `timeout`. None when the
/// address does not resolve or nothing accepts.
pub(super) fn open_socket(host: &str, port: u16, timeout: Duration) -> Option<TcpStream> {
    let addr = resolve(host, port)?;
    let sock = TcpStream::connect_timeout(&addr, timeout).ok()?;
    let _ = sock.set_read_timeout(Some(timeout));
    let _ = sock.set_write_timeout(Some(timeout));
    Some(sock)
}

/// Send one request and report whether the answer is a 2xx status line.
fn answered_2xx(mut sock: TcpStream, req: &str) -> bool {
    if sock.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    let _ = sock.read_to_string(&mut body);
    body.starts_with("HTTP/1.1 2") || body.starts_with("HTTP/1.0 2")
}

/// Ask the daemon to shut itself down cleanly. Token-gated: only a daemon this session started
/// honours our token. Header names are `<prefix>-shutdown-token` / `<prefix>-shutdown-source`.
pub fn request_shutdown(cfg: &Config, url: &str, token: &str, timeout: Duration) -> bool {
    let Some(port) = port_of(url) else {
        return false;
    };
    let Some(sock) = open_socket(&cfg.url_host, port, timeout) else {
        return false;
    };
    let req = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: {}:{port}\r\n{}: {token}\r\n{}: ui\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        cfg.url_host,
        cfg.shutdown_header("shutdown-token"),
        cfg.shutdown_header("shutdown-source"),
    );
    answered_2xx(sock, &req)
}

/// POST to an arbitrary path on the live daemon, for the optional app-action menu item.
/// Returns whether the daemon answered 2xx.
pub fn post(url: &str, path: &str, timeout: Duration) -> bool {
    let Some((host, port)) = split_url(url) else {
        return false;
    };
    let Some(sock) = open_socket(&host, port, timeout) else {
        return false;
    };
    let req = format!(
        "POST {path} HTTP/1.1
Host: {host}:{port}
Content-Length: 0
Connection: close

"
    );
    answered_2xx(sock, &req)
}
