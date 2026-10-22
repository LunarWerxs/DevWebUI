//! The watchdog's policy: when a silent daemon counts as dead, and which guard stands a revive down.
//! Kept apart from the probe, the clock and the spawn so the policy can be exercised without a
//! daemon: the health tick (tray/health.rs) feeds it the probe result and acts on the verdict.

use std::time::{Duration, Instant};

// --- watchdog thresholds (all from Tray-Host.ps1) ----------------------------------------------
/// CONSECUTIVE failed probes before a daemon counts as dead. Must be > 1: a single miss is a
/// hiccup, and reviving on one turns a slow tick into a spurious restart.
pub(crate) const REVIVE_AFTER_MISSES: u32 = 3;
/// How long a silent daemon whose port still takes connections is left alone: busy, not dead.
/// A daemon can freeze for tens of seconds at a time under heavy load, and three missed probes (about
/// 15 s) had the watchdog kill one that was only busy. A daemon still silent after this is wedged,
/// and is revived as a dead one.
pub(crate) const BUSY_PATIENCE: Duration = Duration::from_secs(120);
/// After firing a relaunch, wait this long for it to bind before considering another.
const REVIVE_GRACE: Duration = Duration::from_secs(20);
/// Crash-loop guard: this many restarts inside the window pauses auto-restart entirely.
pub(crate) const CRASH_LOOP_MAX: usize = 4;
pub(crate) const CRASH_LOOP_WINDOW: Duration = Duration::from_secs(120);

/// Why a health tick that found the daemon dead did not revive it.
///
/// Each one is written to the tray log once per episode (see `Watchdog::report`). Before
/// 2026-09-26 every guard returned without a word, and AgentHydra's watchdog stood down for ~31
/// hours with nothing to show for it but a spawn line that never came.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum StandDown {
    /// A Restart or Rebuild from the menu owns the daemon until its worker finishes.
    Busy,
    /// A token app leaves a daemon it did not start alone (Config::watchdog_requires_ownership).
    NotOurs,
    /// The last revive has not had its grace period to bind yet.
    Grace,
    /// The crash-loop guard paused auto-restart.
    Paused,
    /// Its port still takes connections: a blocked event loop, given BUSY_PATIENCE to clear.
    Slow,
}

impl StandDown {
    fn reason(self) -> String {
        match self {
            StandDown::Busy => "a Restart or Rebuild from the tray menu is still running".into(),
            StandDown::NotOurs => {
                "this tray did not start it, and watchdogRequiresOwnership is on".into()
            }
            StandDown::Grace => format!(
                "the last revive is still inside its {}s grace",
                REVIVE_GRACE.as_secs()
            ),
            StandDown::Paused => format!(
                "auto-restart is paused by the crash-loop guard {}",
                rearm_hint()
            ),
            StandDown::Slow => format!(
                "its port still takes connections, so it is busy, not dead (revived if still silent after {}s)",
                BUSY_PATIENCE.as_secs()
            ),
        }
    }
}

fn rearm_hint() -> String {
    format!(
        "(it re-arms once the daemon answers for {}s, or on a tray Restart)",
        CRASH_LOOP_WINDOW.as_secs()
    )
}

/// What one health tick decided.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Verdict {
    /// The daemon answered.
    Alive,
    /// The daemon answered, and has for long enough that a crash-loop pause is lifted.
    Rearmed,
    /// Silent, but not for long enough to count as dead: one slow tick is not a death.
    Hiccup,
    /// Dead, and a guard kept the watchdog from reviving it.
    StandDown(StandDown),
    /// Dead, and one revive too many inside the crash-loop window: auto-restart pauses.
    CrashLoop,
    /// Dead: reap and respawn it.
    Revive,
}

/// The watchdog's memory between ticks, and its whole policy.
///
/// Kept apart from the probe, the clock and the spawn so the policy can be exercised without a
/// daemon: `health_tick` feeds it the probe result and acts on the verdict.
#[derive(Default)]
pub(crate) struct Watchdog {
    misses: u32,
    grace_until: Option<Instant>,
    paused: bool,
    restart_times: Vec<Instant>,
    /// Since when the daemon has answered. Only a death resets it, never a hiccup.
    healthy_since: Option<Instant>,
    /// The first missed probe of the current silence; an answer or a revive ends it.
    silent_since: Option<Instant>,
    /// The stand-down last written to the tray log, so a standing guard is reported once.
    reported: Option<StandDown>,
}

impl Watchdog {
    /// `listening`: the probe got no answer, but the daemon's port still takes connections.
    pub(crate) fn tick(
        &mut self,
        now: Instant,
        alive: bool,
        listening: bool,
        busy: bool,
        not_ours: bool,
    ) -> Verdict {
        if alive {
            self.misses = 0;
            self.silent_since = None;
            let since = *self.healthy_since.get_or_insert(now);
            // The pause must not outlive the crash loop. A daemon that has answered for the whole
            // window has, by the guard's own definition, stopped crash-looping, and a pause kept
            // past that turns the NEXT unrelated death into one nothing revives: AgentHydra paused
            // after four fast revives, the fifth daemon served for 15 hours, and when it was killed
            // the watchdog stood down for good.
            if self.paused && now.duration_since(since) >= CRASH_LOOP_WINDOW {
                self.rearm();
                return Verdict::Rearmed;
            }
            return Verdict::Alive;
        }

        let silent_since = *self.silent_since.get_or_insert(now);
        self.misses += 1;
        if self.misses < REVIVE_AFTER_MISSES {
            return Verdict::Hiccup;
        }
        // Busy, not dead: killing it would end every chat and request it is in the middle of.
        if listening && now.duration_since(silent_since) < BUSY_PATIENCE {
            return Verdict::StandDown(StandDown::Slow);
        }
        // Dead from here. Every guard below stands the revive down, and says which it was.
        self.healthy_since = None;
        if busy {
            self.misses = 0;
            return Verdict::StandDown(StandDown::Busy);
        }
        if not_ours {
            self.misses = 0;
            return Verdict::StandDown(StandDown::NotOurs);
        }
        if self.grace_until.is_some_and(|until| now < until) {
            return Verdict::StandDown(StandDown::Grace);
        }
        if self.paused {
            return Verdict::StandDown(StandDown::Paused);
        }
        // Crash-loop guard: prune the window, then refuse to keep resurrecting something that will
        // not stay up.
        self.restart_times
            .retain(|t| now.duration_since(*t) < CRASH_LOOP_WINDOW);
        if self.restart_times.len() >= CRASH_LOOP_MAX {
            self.paused = true;
            return Verdict::CrashLoop;
        }
        self.restart_times.push(now);
        self.grace_until = Some(now + REVIVE_GRACE);
        self.misses = 0;
        self.silent_since = None;
        Verdict::Revive
    }

    /// Lift a crash-loop pause: a manual Restart, or a daemon that has stayed up.
    pub(crate) fn rearm(&mut self) {
        self.paused = false;
        self.restart_times.clear();
    }

    /// The tray-log line this verdict earns, or None when it would only repeat the last one.
    /// A revive needs none: its own spawn line is the record.
    pub(crate) fn report(&mut self, verdict: Verdict) -> Option<String> {
        const DEAD: &str = "watchdog: the daemon is not answering, and it is NOT being revived";
        match verdict {
            Verdict::Hiccup => None,
            Verdict::Revive => {
                self.reported = None;
                None
            }
            Verdict::Alive => self
                .reported
                .take()
                .map(|_| "watchdog: the daemon answers again".to_string()),
            Verdict::Rearmed => {
                self.reported = None;
                Some(format!(
                    "watchdog: re-armed - the daemon has answered for {}s since the crash-loop guard paused auto-restart",
                    CRASH_LOOP_WINDOW.as_secs()
                ))
            }
            Verdict::CrashLoop => {
                self.reported = Some(StandDown::Paused);
                Some(format!(
                    "{DEAD}: {} revives inside {}s tripped the crash-loop guard, so auto-restart is paused {}",
                    CRASH_LOOP_MAX,
                    CRASH_LOOP_WINDOW.as_secs(),
                    rearm_hint()
                ))
            }
            Verdict::StandDown(why) if self.reported == Some(why) => None,
            Verdict::StandDown(why) => {
                self.reported = Some(why);
                Some(format!("{DEAD}: {}", why.reason()))
            }
        }
    }
}
