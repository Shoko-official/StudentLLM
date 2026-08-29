mod sidecars;
mod workspace;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    eprintln!("[studentllm] building application");
    let app = tauri::Builder::default()
        .manage(sidecars::SidecarSupervisor::default())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let windows = app.webview_windows().keys().cloned().collect::<Vec<_>>();
                eprintln!("[studentllm] setup complete; windows={windows:?}");
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            #[cfg(debug_assertions)]
            eprintln!(
                "[studentllm] page load: {:?} {} in {}",
                payload.event(),
                payload.url(),
                webview.label()
            );
        })
        .invoke_handler(tauri::generate_handler![
            workspace::load_workspace,
            workspace::save_workspace,
            sidecars::sidecar_status,
            sidecars::start_sidecars,
            sidecars::stop_sidecars
        ])
        .build(tauri::generate_context!())
        .expect("error while building StudentLLM");

    #[cfg(debug_assertions)]
    eprintln!("[studentllm] application built");

    workspace::initialize_workspace(&app.handle()).expect("error while initializing workspace");

    #[cfg(debug_assertions)]
    eprintln!("[studentllm] workspace initialized");

    app.run(|app_handle, event| {
        #[cfg(debug_assertions)]
        if matches!(event, RunEvent::Ready) {
            eprintln!(
                "[studentllm] event loop ready; windows={:?}",
                app_handle.webview_windows().keys().collect::<Vec<_>>()
            );
        }
        if matches!(event, tauri::RunEvent::Exit) {
            let _ = app_handle.state::<sidecars::SidecarSupervisor>().stop_all();
        }
    });
}
