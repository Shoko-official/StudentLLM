mod sidecars;
mod workspace;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(sidecars::SidecarSupervisor::default())
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("runtime-diagnostics")
                .on_page_load(|webview, payload| {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[studentllm] page load: {:?} {} in {}",
                        payload.event(),
                        payload.url(),
                        webview.label()
                    );
                })
                .on_window_ready(|window| {
                    #[cfg(debug_assertions)]
                    eprintln!("[studentllm] window ready: {}", window.label());
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            workspace::load_workspace,
            workspace::save_workspace,
            sidecars::sidecar_status,
            sidecars::start_sidecars,
            sidecars::stop_sidecars
        ])
        .build(tauri::generate_context!())
        .expect("error while building StudentLLM");

    workspace::initialize_workspace(&app.handle()).expect("error while initializing workspace");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let _ = app_handle.state::<sidecars::SidecarSupervisor>().stop_all();
        }
    });
}
