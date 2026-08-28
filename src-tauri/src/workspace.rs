use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};

const DATABASE_FILE: &str = "studentllm.sqlite3";

fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create database directory: {error}"))?;
    }

    let connection = Connection::open(path)
        .map_err(|error| format!("Unable to open workspace database: {error}"))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("Unable to enable WAL mode: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("Unable to configure SQLite synchronous mode: {error}"))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS workspace (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version INTEGER NOT NULL,
                snapshot TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .map_err(|error| format!("Unable to migrate workspace database: {error}"))?;
    Ok(connection)
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve application data directory: {error}"))?
        .join(DATABASE_FILE))
}

fn read_snapshot(path: &Path) -> Result<Option<String>, String> {
    let connection = open_database(path)?;
    connection
        .query_row(
            "SELECT snapshot FROM workspace WHERE id = 1 AND version = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Unable to read workspace database: {error}"))
}

fn write_snapshot(path: &Path, snapshot: &str) -> Result<(), String> {
    let connection = open_database(path)?;
    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Unable to read system clock: {error}"))?
        .as_secs() as i64;
    connection
        .execute(
            "INSERT INTO workspace (id, version, snapshot, updated_at)
             VALUES (1, 1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET version = excluded.version, snapshot = excluded.snapshot, updated_at = excluded.updated_at",
            params![snapshot, updated_at],
        )
        .map_err(|error| format!("Unable to write workspace database: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_workspace(app: AppHandle) -> Result<Option<String>, String> {
    read_snapshot(&database_path(&app)?)
}

#[tauri::command]
pub fn save_workspace(app: AppHandle, snapshot: String) -> Result<(), String> {
    write_snapshot(&database_path(&app)?, &snapshot)
}

#[cfg(test)]
mod tests {
    use super::{open_database, read_snapshot, write_snapshot};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_database_path() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("studentllm-{suffix}"))
            .join("workspace.sqlite3")
    }

    #[test]
    fn creates_wal_database_and_round_trips_snapshot() {
        let path = test_database_path();
        let connection = open_database(&path).expect("database should open");
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode should be readable");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        drop(connection);

        assert_eq!(read_snapshot(&path).expect("read should succeed"), None);
        write_snapshot(&path, "{\"version\":1}").expect("write should succeed");
        assert_eq!(
            read_snapshot(&path).expect("read should succeed"),
            Some("{\"version\":1}".to_string())
        );

        let _ = fs::remove_dir_all(path.parent().expect("test database parent"));
    }
}
