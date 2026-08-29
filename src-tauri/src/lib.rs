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
        .setup(|app| {
            workspace::initialize_workspace(&app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building StudentLLM");

    use tauri::Manager;
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let _ = app_handle.state::<sidecars::SidecarSupervisor>().stop_all();
        }
    });
}
