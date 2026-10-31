//! Keeps one StudentLLM process per user session. Two processes would open the same
//! `workspace.sqlite3` and the same webview profile, and each saves its whole snapshot on every
//! change, so the last writer would silently overwrite the other window's work.
//!
//! The lock is held by the operating system and goes away with the process, so a crashed or
//! force-stopped instance leaves nothing to clean up: a named mutex on Windows, a D-Bus name on
//! Linux, and a Unix socket in `/tmp` on macOS (a stale socket file refuses connections, and the
//! next instance replaces it). It is keyed by the bundle identifier only, not by the data
//! directory, so a second launch with another `XDG_DATA_HOME` or `APPDATA` is also redirected.

use tauri::{AppHandle, Manager, Runtime};

/// The label of the window created from `tauri.conf.json`.
const MAIN_WINDOW_LABEL: &str = "main";

/// Shows the existing main window to the user: restores it when minimized, makes it visible when
/// hidden, and focuses it. Failures are ignored on purpose: the window may be closing.
fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The single-instance plugin. It must be the first plugin registered: the second instance exits
/// from the plugin's setup, so everything registered before it would already have run.
///
/// The arguments and working directory of the second launch are not used or logged; the app has no
/// command line, and they could contain paths.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_single_instance::init(|app, _arguments, _working_directory| {
        eprintln!("A second launch was redirected to the running StudentLLM window.");
        focus_main_window(app);
    })
}
