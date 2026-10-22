use super::death::{take_last_death, watch_child};
use super::log::{log_line, log_path};
use super::probe::{health_of, Health};
use super::spawn::spawn;
use super::witness::{describe_exit, watch_pid};
use super::CREATE_NO_WINDOW;
use crate::config::Config;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(test)]
mod health_of_tests {
    use super::*;

    fn http_200(content_type: &str, body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n\r\n{body}")
    }

    /// Contract: a version reaches the tooltip only from a responder that passes the identity rule.
    /// A neighbour's daemon (same body, other service) and a SPA fallback give None; ours without a
    /// version is still alive, with version None. Regression: the split must not change health_ok's
    /// identity rule, and a healthy daemon without `version` must not read as dead.
    #[test]
    fn a_version_is_read_only_from_a_responder_that_passes_the_identity_rule() {
        let ours = http_200(
            "application/json",
            r#"{"ok":true,"service":"agenthydra","version":"2.0.4","distribution":"release"}"#,
        );
        assert_eq!(
            health_of(&ours, "agenthydra"),
            Some(Health {
                version: Some("2.0.4".into()),
                distribution: Some("release".into()),
            })
        );

        let neighbour = http_200(
            "application/json",
            r#"{"ok":true,"service":"devwebui","version":"9.9.9","distribution":"release"}"#,
        );
        assert_eq!(health_of(&neighbour, "agenthydra"), None);

        let spa = http_200("text/html", "<!doctype html><html></html>");
        assert_eq!(health_of(&spa, "agenthydra"), None);

        let no_version = http_200("application/json", r#"{"ok":true,"service":"agenthydra"}"#);
        assert_eq!(
            health_of(&no_version, "agenthydra"),
            Some(Health {
                version: None,
                distribution: None,
            })
        );
    }
}

#[cfg(test)]
mod death_record_tests {
    use super::*;

    /// Every watched death writes the one process-wide LAST_DEATH slot, and the test runner runs
    /// tests on parallel threads, so a test that reads the slot must not share it with another
    /// test's child dying at the same moment.
    static SLOT: Mutex<()> = Mutex::new(());

    /// A real short-lived process, so the exit code under test is Windows' own and not a fake.
    fn exiting_with(code: i32) -> std::process::Child {
        Command::new("cmd.exe")
            .raw_arg(format!("/c \"exit {code}\""))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("cmd.exe should spawn")
    }

    fn temp_log(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "lunarwerx-tray-test-{tag}-{}.log",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    /// Wait for the watcher thread to land its line. Polling beats a flat sleep: a wait on a
    /// process that has already exited returns in single-digit ms.
    fn wait_for_log(path: &PathBuf) -> String {
        for _ in 0..200 {
            if let Ok(s) = std::fs::read_to_string(path) {
                if !s.trim().is_empty() {
                    return s;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        String::new()
    }

    #[test]
    fn a_dead_child_is_recorded_with_its_pid_exit_code_and_uptime() {
        let _slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let log = temp_log("death");
        let child = exiting_with(3);
        let pid = child.id();
        watch_child(child, log.clone(), None);
        let body = wait_for_log(&log);
        // The whole point of the item: the pid, HOW it went, and how long it had been up - the
        // three facts that were missing when AgentHydra's daemon died three times in a night.
        assert!(body.contains(&format!("death of pid {pid}")), "got: {body}");
        assert!(body.contains("exit code 3"), "got: {body}");
        assert!(body.contains("up "), "got: {body}");
        // And a wall-clock stamp, so it can be lined up against Event Viewer.
        assert!(body.starts_with('['), "got: {body}");
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn the_next_spawn_names_the_death_it_answers() {
        let _slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let log = temp_log("answers");
        let child = exiting_with(1);
        let pid = child.id();
        watch_child(child, log.clone(), None);
        wait_for_log(&log);
        // take_last_death is what spawn() consults; it must carry the previous death exactly once.
        let first = take_last_death();
        assert!(
            first
                .as_deref()
                .unwrap_or("")
                .contains(&format!("pid {pid}")),
            "expected the death to be handed to the next spawn, got: {first:?}"
        );
        // Taken, not copied: a second spawn must not claim to answer a death already answered.
        assert!(take_last_death().is_none());
        let _ = std::fs::remove_file(&log);
    }

    /// A compiled release laid out as the zip is, under a folder whose name has a space:
    /// `<root>/App.exe` (a real Windows program that exits 0) and `<root>/misc/tray.json` with
    /// `appRoot: ".."`, so the root is resolved, and canonicalized, exactly as a release's is.
    fn release_tree(tag: &str, extra: &str) -> (PathBuf, Config) {
        let root =
            std::env::temp_dir().join(format!("lunarwerx tray {tag} {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("misc")).expect("temp tree");
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        std::fs::copy(
            Path::new(&system).join("System32").join("whoami.exe"),
            root.join("App.exe"),
        )
        .expect("whoami.exe should copy");
        let pointer = root
            .join("home")
            .join("runtime.json")
            .display()
            .to_string()
            .replace('\\', "\\\\");
        let config = root.join("misc").join("tray.json");
        std::fs::write(
            &config,
            format!(
                r#"{{ "displayName": "Test", "serviceName": "test", "mutexName": "TestTray",
                     "appRoot": "..", "compiledExe": "App.exe", "startCommand": "unused",
                     "infoFile": "{pointer}"{extra} }}"#
            ),
        )
        .expect("config");
        (root, Config::load(&config).expect("valid config"))
    }

    fn wait_for_line(path: &Path, needle: &str) -> String {
        for _ in 0..400 {
            if let Ok(s) = std::fs::read_to_string(path) {
                if s.contains(needle) {
                    return s;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        std::fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn a_compiled_release_is_started_by_the_real_spawn() {
        // AgentHydra, 2026-10-05: every watchdog revive of the compiled exe ended `exit code 1, up
        // 0.0s`, because the command named it by the canonicalized root's \\?\ path, which cmd.exe
        // cannot run. Through spawn() itself, so the command line under test is the shipped one.
        let _slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let (root, cfg) = release_tree("start", "");
        let pid = spawn(&cfg, "token", "test").expect("cmd.exe should spawn");
        let body = wait_for_line(&log_path(&cfg), &format!("death of pid {pid} "));
        assert!(
            body.contains(&format!("death of pid {pid} (exit code 0,")),
            "got: {body}"
        );
        let _ = take_last_death();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_launch_that_fails_outright_says_why_in_its_death_line() {
        // A program cmd.exe cannot find: before, the tray log held an exit code and nothing else.
        let _slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let (root, cfg) = release_tree(
            "fails",
            r#", "startCommandCompiled": "\"{COMPILED}.missing\"""#,
        );
        let pid = spawn(&cfg, "token", "test").expect("cmd.exe should spawn");
        // By pid: a respawn line also says "death of pid", naming the death it answers.
        let body = wait_for_line(&log_path(&cfg), &format!("death of pid {pid} "));
        // cmd.exe names the program it could not run, in whatever language Windows speaks.
        let death = body
            .lines()
            .find(|l| l.contains(&format!("death of pid {pid} ")))
            .unwrap_or("");
        assert!(death.contains("exit code 1,"), "got: {body}");
        assert!(
            death.contains(" - it said: ") && death.contains("App.exe.missing"),
            "got: {body}"
        );
        // And the stderr log names the launch it belongs to, by the command as configured.
        let stderr =
            std::fs::read_to_string(root.join("home").join("logs").join("daemon-stderr.log"))
                .unwrap_or_default();
        assert!(stderr.contains("-- test: "), "got: {stderr}");
        let _ = take_last_death();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_daemon_this_tray_did_not_start_has_its_exit_code_recorded() {
        // The witness's own half: a real process, opened by pid alone as a relaunch successor is.
        let log = temp_log("witness");
        let child = exiting_with(7);
        let pid = child.id();
        let handle = crate::win::open_for_exit(pid).expect("a live child can be opened");
        watch_pid(pid, handle, log.clone());
        let body = wait_for_log(&log);
        assert!(
            body.contains(&format!("daemon pid {pid} ended (exit code 7,")),
            "got: {body}"
        );
        drop(child);
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn an_exit_code_reads_as_windows_shows_it() {
        assert_eq!(describe_exit(Some(87)), "exit code 87");
        assert!(
            describe_exit(Some(0xC000_0005)).starts_with("exit code 0xC0000005: access violation")
        );
        assert!(describe_exit(Some(1)).starts_with("exit code 1: "));
        assert_eq!(describe_exit(None), "exit code unknown");
    }

    #[test]
    fn logging_never_panics_on_an_unwritable_path() {
        // A witness must never be a dependency: the tray keeps running the app regardless.
        let bad = PathBuf::from("Z:\no-such-drive\nested\tray.log");
        log_line(&bad, "this must not panic");
    }
}
