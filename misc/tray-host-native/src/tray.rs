//! The tray host's parts: the command line, startup, the tray icon and its menu, the window
//! procedure, the health tick and watchdog, the background worker, and quit. main.rs keeps the
//! shared state (App, Ui, the ids and timers) and the startup sequence that runs them.

pub(crate) mod cli;
pub(crate) mod health;
pub(crate) mod icon;
pub(crate) mod menu;
pub(crate) mod quit;
pub(crate) mod startup;
pub(crate) mod watchdog;
pub(crate) mod wndproc;
pub(crate) mod worker;
