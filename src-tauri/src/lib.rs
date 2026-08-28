mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            workspace::load_workspace,
            workspace::save_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running StudentLLM");
}
