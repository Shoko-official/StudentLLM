use std::collections::HashMap;
use std::env;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum SidecarKind {
    Asr,
    Documents,
}

impl SidecarKind {
    const ALL: [Self; 2] = [Self::Asr, Self::Documents];

    fn label(self) -> &'static str {
        match self {
            Self::Asr => "asr",
            Self::Documents => "documents",
        }
    }

    fn command_variable(self) -> &'static str {
        match self {
            Self::Asr => "STUDENTLLM_ASR_COMMAND",
            Self::Documents => "STUDENTLLM_DOCUMENT_COMMAND",
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SidecarStatus {
    pub kind: String,
    pub configured: bool,
    pub running: bool,
    pub pid: Option<u32>,
    pub detail: String,
}

#[derive(Default)]
struct SupervisorState {
    children: HashMap<SidecarKind, Child>,
    errors: HashMap<SidecarKind, String>,
}

#[derive(Default)]
pub struct SidecarSupervisor(Mutex<SupervisorState>);

fn configured_command(kind: SidecarKind) -> Option<String> {
    env::var(kind.command_variable())
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn split_command_line(value: &str) -> Result<Vec<String>, String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quote = None;

    for character in value.chars() {
        match (quote, character) {
            (None, '"') | (None, '\'') => quote = Some(character),
            (Some(active), character) if active == character => quote = None,
            (None, character) if character.is_whitespace() => {
                if !current.is_empty() {
                    arguments.push(std::mem::take(&mut current));
                }
            }
            (_, character) => current.push(character),
        }
    }

    if quote.is_some() {
        return Err("Configured sidecar command has an unterminated quote".to_string());
    }
    if !current.is_empty() {
        arguments.push(current);
    }
    if arguments.is_empty() {
        return Err("Configured sidecar command is empty".to_string());
    }
    Ok(arguments)
}

impl SidecarSupervisor {
    fn start_one(&self, state: &mut SupervisorState, kind: SidecarKind) {
        if let Some(child) = state.children.get_mut(&kind) {
            match child.try_wait() {
                Ok(None) => return,
                Ok(Some(_)) => {}
                Err(error) => {
                    state
                        .errors
                        .insert(kind, format!("Unable to inspect process: {error}"));
                    return;
                }
            }
            state.children.remove(&kind);
        }

        let Some(command_line) = configured_command(kind) else {
            state.errors.remove(&kind);
            return;
        };
        let arguments = match split_command_line(&command_line) {
            Ok(arguments) => arguments,
            Err(error) => {
                state.errors.insert(kind, error);
                return;
            }
        };

        let child = Command::new(&arguments[0])
            .args(&arguments[1..])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match child {
            Ok(child) => {
                state.children.insert(kind, child);
                state.errors.remove(&kind);
            }
            Err(error) => {
                state
                    .errors
                    .insert(kind, format!("Unable to start sidecar: {error}"));
            }
        }
    }

    fn statuses(&self) -> Result<Vec<SidecarStatus>, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Sidecar supervisor state is unavailable".to_string())?;
        Ok(SidecarKind::ALL
            .into_iter()
            .map(|kind| status_for(&mut state, kind))
            .collect())
    }

    pub fn start_all(&self) -> Result<Vec<SidecarStatus>, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Sidecar supervisor state is unavailable".to_string())?;
        for kind in SidecarKind::ALL {
            self.start_one(&mut state, kind);
        }
        Ok(SidecarKind::ALL
            .into_iter()
            .map(|kind| status_for(&mut state, kind))
            .collect())
    }

    pub fn stop_all(&self) -> Result<Vec<SidecarStatus>, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Sidecar supervisor state is unavailable".to_string())?;
        for child in state.children.values_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        state.children.clear();
        Ok(SidecarKind::ALL
            .into_iter()
            .map(|kind| status_for(&mut state, kind))
            .collect())
    }
}

impl Drop for SupervisorState {
    fn drop(&mut self) {
        for child in self.children.values_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn status_for(state: &mut SupervisorState, kind: SidecarKind) -> SidecarStatus {
    let configured = configured_command(kind).is_some();
    let process = state.children.get_mut(&kind).map(|child| {
        let pid = child.id();
        match child.try_wait() {
            Ok(None) => (true, Some(pid), None),
            Ok(Some(status)) => (
                false,
                None,
                Some(format!(
                    "Exited with status {status}. Start again to recover."
                )),
            ),
            Err(error) => (
                false,
                None,
                Some(format!("Unable to inspect process: {error}")),
            ),
        }
    });

    if let Some((running, pid, detail)) = process {
        if !running {
            state.children.remove(&kind);
            if let Some(detail) = detail {
                state.errors.insert(kind, detail);
            }
        } else {
            return SidecarStatus {
                kind: kind.label().to_string(),
                configured,
                running,
                pid,
                detail: "Managed process is running.".to_string(),
            };
        }
    }

    SidecarStatus {
        kind: kind.label().to_string(),
        configured,
        running: false,
        pid: None,
        detail: state.errors.get(&kind).cloned().unwrap_or_else(|| {
            if configured {
                "Configured but stopped. Start it to recover.".to_string()
            } else {
                format!("Not configured. Set {}.", kind.command_variable())
            }
        }),
    }
}

#[tauri::command]
pub fn sidecar_status(
    supervisor: State<'_, SidecarSupervisor>,
) -> Result<Vec<SidecarStatus>, String> {
    supervisor.statuses()
}

#[tauri::command]
pub fn start_sidecars(
    supervisor: State<'_, SidecarSupervisor>,
) -> Result<Vec<SidecarStatus>, String> {
    supervisor.start_all()
}

#[tauri::command]
pub fn stop_sidecars(
    supervisor: State<'_, SidecarSupervisor>,
) -> Result<Vec<SidecarStatus>, String> {
    supervisor.stop_all()
}

#[cfg(test)]
mod tests {
    use super::split_command_line;

    #[test]
    fn splits_quoted_command_arguments() {
        assert_eq!(
            split_command_line("python \"scripts/local_asr_server.py\" --device cuda")
                .expect("command should parse"),
            vec!["python", "scripts/local_asr_server.py", "--device", "cuda"]
        );
    }

    #[test]
    fn rejects_unterminated_quotes() {
        let error = split_command_line("python \"scripts/local_asr_server.py")
            .expect_err("command should be rejected");
        assert!(error.contains("unterminated quote"));
    }
}
