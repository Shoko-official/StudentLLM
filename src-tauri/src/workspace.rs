use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, Error as SqliteError, ErrorCode, OptionalExtension};
use tauri::{AppHandle, Manager};

const DATABASE_FILE: &str = "studentllm.sqlite3";
const SCHEMA_VERSION: i32 = 1;
const WAL_ENABLE_ATTEMPTS: usize = 8;

fn is_busy_error(error: &SqliteError) -> bool {
    matches!(
        error,
        SqliteError::SqliteFailure(
            sqlite_error,
            _
        ) if matches!(
            sqlite_error.code,
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
        )
    )
}

fn enable_wal(connection: &Connection) -> Result<(), String> {
    for attempt in 0..WAL_ENABLE_ATTEMPTS {
        match connection.pragma_update(None, "journal_mode", "WAL") {
            Ok(()) => return Ok(()),
            Err(error) if is_busy_error(&error) && attempt + 1 < WAL_ENABLE_ATTEMPTS => {
                std::thread::sleep(Duration::from_millis(25 * (attempt as u64 + 1)));
            }
            Err(error) => {
                return Err(format!("Unable to enable WAL mode: {error}"));
            }
        }
    }

    Err("Unable to enable WAL mode after retrying a busy database".to_string())
}

fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create database directory: {error}"))?;
    }

    let connection = Connection::open(path)
        .map_err(|error| format!("Unable to open workspace database: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Unable to configure workspace lock timeout: {error}"))?;
    enable_wal(&connection)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("Unable to configure SQLite synchronous mode: {error}"))?;
    let schema_version: i32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Unable to read workspace schema version: {error}"))?;
    if schema_version > SCHEMA_VERSION {
        return Err(format!(
            "Workspace database schema version {schema_version} is newer than supported version {SCHEMA_VERSION}"
        ));
    }

    if schema_version == 0 {
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
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|error| format!("Unable to record workspace schema version: {error}"))?;
    }
    Ok(connection)
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve application data directory: {error}"))?
        .join(DATABASE_FILE))
}

pub fn initialize_workspace(app: &AppHandle) -> Result<(), String> {
    open_database(&database_path(app)?).map(|_| ())
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
    use std::sync::Arc;
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
        let schema_version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        assert_eq!(schema_version, 1);
        drop(connection);

        assert_eq!(read_snapshot(&path).expect("read should succeed"), None);
        write_snapshot(&path, "{\"version\":1}").expect("write should succeed");
        assert_eq!(
            read_snapshot(&path).expect("read should succeed"),
            Some("{\"version\":1}".to_string())
        );

        let _ = fs::remove_dir_all(path.parent().expect("test database parent"));
    }

    #[test]
    fn migrates_an_existing_v0_database() {
        let path = test_database_path();
        fs::create_dir_all(path.parent().expect("legacy database parent"))
            .expect("legacy database directory should be created");
        let legacy = rusqlite::Connection::open(&path).expect("legacy database should open");
        legacy
            .execute_batch(
                "CREATE TABLE workspace (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    version INTEGER NOT NULL,
                    snapshot TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );",
            )
            .expect("legacy schema should be created");
        legacy
            .execute(
                "INSERT INTO workspace (id, version, snapshot, updated_at)
                 VALUES (1, 1, ?1, ?2)",
                rusqlite::params!["{\"version\":1,\"legacy\":true}", 1_i64],
            )
            .expect("legacy snapshot should be created");
        drop(legacy);

        let migrated = open_database(&path).expect("legacy database should migrate");
        let schema_version: i32 = migrated
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("migrated schema version should be readable");
        assert_eq!(schema_version, 1);
        drop(migrated);

        assert_eq!(
            read_snapshot(&path).expect("legacy snapshot should remain readable"),
            Some("{\"version\":1,\"legacy\":true}".to_string())
        );

        let _ = fs::remove_dir_all(path.parent().expect("test database parent"));
    }

    #[test]
    fn rejects_a_database_from_a_newer_schema() {
        let path = test_database_path();
        fs::create_dir_all(path.parent().expect("future database parent"))
            .expect("future database directory should be created");
        let connection = rusqlite::Connection::open(&path).expect("future database should open");
        connection
            .pragma_update(None, "user_version", 2_i32)
            .expect("future schema version should be writable");
        drop(connection);

        let error = open_database(&path).expect_err("future schema should be rejected");
        assert!(error.contains("newer than supported version 1"));

        let _ = fs::remove_dir_all(path.parent().expect("future database parent"));
    }

    #[test]
    fn keeps_the_database_valid_when_writers_overlap() {
        let path = Arc::new(test_database_path());
        let writers = (0..8)
            .map(|index| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    write_snapshot(
                        path.as_ref(),
                        &format!("{{\"version\":1,\"writer\":{index}}}"),
                    )
                })
            })
            .collect::<Vec<_>>();

        for writer in writers {
            writer
                .join()
                .expect("writer thread should finish")
                .expect("overlapping write should succeed");
        }

        let connection = open_database(path.as_ref()).expect("database should reopen");
        let integrity: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity check should be readable");
        assert_eq!(integrity, "ok");
        drop(connection);

        let snapshot = read_snapshot(path.as_ref())
            .expect("final snapshot should be readable")
            .expect("at least one writer should persist a snapshot");
        assert!(snapshot.starts_with("{\"version\":1,\"writer\":"));

        let _ = fs::remove_dir_all(path.parent().expect("concurrent database parent"));
    }
}
