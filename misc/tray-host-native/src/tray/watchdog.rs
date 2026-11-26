//! The watchdog's policy: when a silent daemon counts as dead, which guard stands a revive down, and
//! how a crash loop is backed off. Kept apart from the probe, the clock and the spawn so the policy
//! can be exercised without a daemon: the health tick (tray/health.rs) feeds it the probe result and
//! acts on the verdict.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
/// Crash-loop guard: this many revives inside the window starts a backoff.
pub(crate) const CRASH_LOOP_MAX: usize = 4;
pub(crate) const CRASH_LOOP_WINDOW: Duration = Duration::from_secs(120);
/// The first wait between revives once the crash-loop guard trips. Each further death before the
/// daemon has stayed up for CRASH_LOOP_WINDOW doubles it, up to BACKOFF_MAX.
pub(crate) const BACKOFF_FIRST: Duration = Duration::from_secs(60);
/// The longest wait between two revive attempts. The backoff never gives up: it keeps trying at
/// this interval for as long as the daemon stays down.
pub(crate) const BACKOFF_MAX: Duration = Duration::from_secs(15 * 60);

/// Why a health tick that found the daemon dead did not revive it.
///
/// Each one is written to the tray log once per episode (see `Watchdog::report`), so a standing
/// guard is never silent.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum StandDown {
    /// A Restart or Rebuild from the menu owns the daemon until its worker finishes.
    Busy,
    /// A token app leaves a daemon it did not start alone (Config::watchdog_requires_ownership).
    NotOurs,
    /// The last revive has not had its grace period to bind yet.
    Grace,
    /// A crash-loop backoff is waiting out its wait before the next revive.
    Backoff,
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
            // Reported from `Watchdog::report`, which knows the step; this is the fallback.
            StandDown::Backoff => "auto-restart is backing off until its next revive".into(),
            StandDown::Slow => format!(
                "its port still takes connections, so it is busy, not dead (revived if still silent after {}s)",
                BUSY_PATIENCE.as_secs()
            ),
        }
    }
}

/// What one health tick decided.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Verdict {
    /// The daemon answered.
    Alive,
    /// The daemon answered for the whole window after a crash-loop backoff: the backoff is cleared.
    Rearmed,
    /// Silent, but not for long enough to count as dead: one slow tick is not a death.
    Hiccup,
    /// Dead, and a guard kept the watchdog from reviving it.
    StandDown(StandDown),
    /// Dead, and a backoff step begins: the crash-loop guard tripped (`first`), or a revive died
    /// before the daemon stayed up (the wait doubles). Each step is one tray-log line.
    Backoff { first: bool },
    /// Dead: reap and respawn it.
    Revive,
}

/// One backoff step: how long the watchdog waits before its next revive.
#[derive(Clone, Debug)]
struct Backoff {
    /// The wait of this step. The next step's is double, capped at BACKOFF_MAX.
    wait: Duration,
    /// When the next revive is due.
    revive_at: Instant,
    /// The same moment as wall-clock epoch milliseconds, for the status file.
    revive_epoch_ms: u64,
    /// The same moment as the local clock (HH:MM:SS), for the tray log and the balloon.
    clock: String,
    /// A revive fired in this step and its outcome is not known yet: a death from here on is a
    /// further death, and doubles the wait.
    attempted: bool,
}

/// What the status file says about the watchdog. Written only when it changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Status {
    /// "ok", "reviving", "backoff" or "standdown".
    pub state: &'static str,
    /// The human line the tray log got for this change ("" when it logged none).
    pub reason: String,
    /// Revives inside the crash-loop window at the time of the change.
    pub revives: usize,
    /// Epoch milliseconds of the next revive, when backing off.
    pub next_revive_ms: Option<u64>,
}

/// The watchdog's memory between ticks, and its whole policy.
///
/// Kept apart from the probe, the clock and the spawn so the policy can be exercised without a
/// daemon: `health_tick` feeds it the probe result and acts on the verdict.
#[derive(Default)]
pub(crate) struct Watchdog {
    misses: u32,
    grace_until: Option<Instant>,
    /// Set while the crash-loop guard is backing off; cleared when the daemon stays up.
    backoff: Option<Backoff>,
    restart_times: Vec<Instant>,
    /// Since when the daemon has answered. Only a death resets it, never a hiccup.
    healthy_since: Option<Instant>,
    /// The first missed probe of the current silence; an answer or a revive ends it.
    silent_since: Option<Instant>,
    /// The stand-down last written to the tray log, so a standing guard is reported once.
    reported: Option<StandDown>,
    /// The status last written to the status file, so a change alone is written.
    status: Option<Status>,
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
            // The backoff must not outlive the crash loop. A daemon that has answered for the whole
            // window has, by the guard's own definition, stopped crash-looping, so the next death is
            // a new one and starts from the fast budget again.
            if self.backoff.is_some() && now.duration_since(since) >= CRASH_LOOP_WINDOW {
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
        // An open backoff owns the next revive: a revive that died is a further death (the wait
        // doubles); otherwise wait until the step's revive is due.
        if let Some(step) = self.backoff.clone() {
            if step.attempted {
                let wait = (step.wait * 2).min(BACKOFF_MAX);
                self.backoff = Some(self.step(now, wait));
                self.misses = 0;
                return Verdict::Backoff { first: false };
            }
            if now < step.revive_at {
                return Verdict::StandDown(StandDown::Backoff);
            }
        }
        // Fast budget: prune the window, then refuse to keep resurrecting something that will not
        // stay up. Tripping it opens the first backoff step instead of a revive.
        self.restart_times
            .retain(|t| now.duration_since(*t) < CRASH_LOOP_WINDOW);
        if self.backoff.is_none() && self.restart_times.len() >= CRASH_LOOP_MAX {
            self.backoff = Some(self.step(now, BACKOFF_FIRST));
            self.misses = 0;
            return Verdict::Backoff { first: true };
        }
        if let Some(step) = self.backoff.as_mut() {
            step.attempted = true;
        }
        self.restart_times.push(now);
        self.grace_until = Some(now + REVIVE_GRACE);
        self.misses = 0;
        self.silent_since = None;
        Verdict::Revive
    }

    /// A new backoff step of `wait`, due at `now + wait`.
    fn step(&self, now: Instant, wait: Duration) -> Backoff {
        let epoch_now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Backoff {
            wait,
            revive_at: now + wait,
            revive_epoch_ms: epoch_now + wait.as_millis() as u64,
            clock: crate::win::local_clock_after(wait),
            attempted: false,
        }
    }

    /// Lift a backoff: a manual Restart, or a daemon that has stayed up.
    pub(crate) fn rearm(&mut self) {
        self.backoff = None;
        self.restart_times.clear();
    }

    /// The local clock (HH:MM:SS) of the backoff's next revive, or "" when no backoff is open.
    pub(crate) fn next_revive_clock(&self) -> String {
        self.backoff
            .as_ref()
            .map(|step| step.clock.clone())
            .unwrap_or_default()
    }

    /// Revives inside the crash-loop window at `now`.
    fn revives(&self, now: Instant) -> usize {
        self.restart_times
            .iter()
            .filter(|t| now.duration_since(**t) < CRASH_LOOP_WINDOW)
            .count()
    }

    /// The tray-log line this verdict earns, or None when it would only repeat the last one.
    pub(crate) fn report(&mut self, verdict: Verdict) -> Option<String> {
        const DEAD: &str = "watchdog: the daemon is not answering, and it is NOT being revived";
        match verdict {
            Verdict::Hiccup => None,
            Verdict::Revive => {
                self.reported = None;
                Some("watchdog: the daemon is not answering, so it is being revived".into())
            }
            Verdict::Alive => self
                .reported
                .take()
                .map(|_| "watchdog: the daemon answers again".to_string()),
            Verdict::Rearmed => {
                self.reported = None;
                Some(format!(
                    "watchdog: re-armed - the daemon has answered for {}s, so the crash-loop backoff is cleared",
                    CRASH_LOOP_WINDOW.as_secs()
                ))
            }
            Verdict::Backoff { first } => {
                let step = self.backoff.clone()?;
                self.reported = Some(StandDown::Backoff);
                let head = if first {
                    format!(
                        "{DEAD}: auto-restart is backing off after {CRASH_LOOP_MAX} revives inside {}s",
                        CRASH_LOOP_WINDOW.as_secs()
                    )
                } else {
                    format!(
                        "{DEAD}: a revive died before the daemon stayed up for {}s, so auto-restart is backing off",
                        CRASH_LOOP_WINDOW.as_secs()
                    )
                };
                Some(format!(
                    "{head}: next revive in {}s (at {}), {}; a tray Restart revives it now",
                    step.wait.as_secs(),
                    step.clock,
                    if step.wait < BACKOFF_MAX {
                        format!("doubling to a {} min cap", BACKOFF_MAX.as_secs() / 60)
                    } else {
                        format!("held at the {} min cap", BACKOFF_MAX.as_secs() / 60)
                    }
                ))
            }
            Verdict::StandDown(why) if self.reported == Some(why) => None,
            Verdict::StandDown(why) => {
                self.reported = Some(why);
                let reason = match (why, self.backoff.as_ref()) {
                    (StandDown::Backoff, Some(step)) => format!(
                        "auto-restart is backing off: next revive in {}s (at {})",
                        step.wait.as_secs(),
                        step.clock
                    ),
                    _ => why.reason(),
                };
                Some(format!("{DEAD}: {reason}"))
            }
        }
    }

    /// The status file's change for this verdict and its tray-log line, or None when the watchdog's
    /// state (and so the file) stays as it was. Called on every tick; it writes only on a change.
    pub(crate) fn status_change(
        &mut self,
        now: Instant,
        verdict: Verdict,
        line: Option<&str>,
    ) -> Option<Status> {
        let state: &'static str = match verdict {
            Verdict::Hiccup => return None,
            Verdict::Alive | Verdict::Rearmed => "ok",
            Verdict::Revive | Verdict::StandDown(StandDown::Grace) => "reviving",
            Verdict::Backoff { .. } | Verdict::StandDown(StandDown::Backoff) => "backoff",
            Verdict::StandDown(_) => "standdown",
        };
        // A tick with nothing new to say changes nothing, except the very first status written.
        if line.is_none() && (verdict != Verdict::Alive || self.status.is_some()) {
            return None;
        }
        let next_revive_ms = match verdict {
            Verdict::Backoff { .. } | Verdict::StandDown(StandDown::Backoff) => {
                self.backoff.as_ref().map(|s| s.revive_epoch_ms)
            }
            _ => None,
        };
        let next = Status {
            state,
            reason: line.unwrap_or("").to_string(),
            revives: self.revives(now),
            next_revive_ms,
        };
        let changed = match &self.status {
            Some(prev) => {
                prev.state != next.state
                    || prev.reason != next.reason
                    || prev.next_revive_ms != next.next_revive_ms
            }
            None => true,
        };
        if !changed {
            return None;
        }
        self.status = Some(next.clone());
        Some(next)
    }
}
