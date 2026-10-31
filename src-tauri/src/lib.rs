mod navigation;
mod sidecars;
#[cfg(desktop)]
mod single_instance;
mod workspace;

use std::time::Duration;

use tauri::Manager;

/// Creates the windows declared in `tauri.conf.json` (and in the `--config` overrides merged into
/// it). Each has `"create": false`, so Tauri does not build them itself: only a window builder can
/// register `on_new_window`, and the hook is what stops `window.open` and `target="_blank"` links
/// from opening a window of the webview. The builder is made from the same configuration, so the
/// size, the webview data directory and the extra browser arguments of the WebDriver build are
/// unchanged. This runs in `setup`; creating a window from a synchronous command or event handler
/// can deadlock on Windows.
fn create_windows(app: &tauri::AppHandle) -> tauri::Result<()> {
    for config in &app.config().app.windows {
        tauri::WebviewWindowBuilder::from_config(app, config)?
            .on_new_window(|url, _features| navigation::new_window_response(&url))
            .build()?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // First, so that a second instance exits before anything else is set up (see `single_instance`).
    #[cfg(desktop)]
    let builder = builder.plugin(single_instance::plugin::<tauri::Wry>());

    let builder = builder
        .plugin(navigation::plugin::<tauri::Wry>())
        .manage(sidecars::SidecarSupervisor::default())
        .setup(|app| {
            create_windows(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::load_workspace,
            workspace::save_workspace,
            workspace::smoke_frontend_ipc,
            sidecars::sidecar_status,
            sidecars::start_sidecars,
            sidecars::stop_sidecars
        ]);

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_wdio::init());

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building StudentLLM");

    workspace::initialize_workspace(&app.handle()).expect("error while initializing workspace");

    if std::env::var("STUDENTLLM_AUTOSTART_SIDECARS").as_deref() == Ok("true") {
        if let Err(error) = app.state::<sidecars::SidecarSupervisor>().start_all() {
            eprintln!("Unable to autostart configured sidecars: {error}");
        }
    }

    if let Some(milliseconds) = std::env::var("STUDENTLLM_SMOKE_EXIT_AFTER_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
    {
        let exit_handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(milliseconds));
            exit_handle.exit(0);
        });
    }

    let app_handle = app.handle().clone();
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let _ = app_handle.state::<sidecars::SidecarSupervisor>().stop_all();
        }
    });

    let _ = app_handle.state::<sidecars::SidecarSupervisor>().stop_all();
}
