mod sidecars;
mod workspace;

use std::time::Duration;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(sidecars::SidecarSupervisor::default())
        .invoke_handler(tauri::generate_handler![
            workspace::load_workspace,
            workspace::save_workspace,
            workspace::smoke_frontend_ipc,
            sidecars::sidecar_status,
            sidecars::start_sidecars,
            sidecars::stop_sidecars
        ])
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
