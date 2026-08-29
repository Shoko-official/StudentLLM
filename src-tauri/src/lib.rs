mod sidecars;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(sidecars::SidecarSupervisor::default())
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

    #[cfg(debug_assertions)]
    eprintln!("[studentllm] workspace database initialized before event loop");

    use tauri::Manager;
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let _ = app_handle.state::<sidecars::SidecarSupervisor>().stop_all();
        }
    });
}
