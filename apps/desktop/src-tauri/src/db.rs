use crate::error::{AppError, AppResult};
use crate::timeutil::now_iso;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::Path;

const SCHEMA_VERSION: i64 = 1;

/// App-level state: settings, recent projects and the audit log. Project content lives in project folders.
pub struct Db {
    conn: Connection,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub title: String,
    pub template: String,
    pub engine: String,
    pub opened_at: String,
    pub exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub at: String,
    pub project: Option<String>,
    pub actor: String,
    pub action: String,
    pub detail: Value,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 80 && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Settings are stored in plain text, so credential-like keys are refused outright.
fn looks_secret(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["apikey", "api_key", "api-key", "secret", "token", "password", "credential"].iter().any(|w| k.contains(w))
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Db> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_in_memory() -> AppResult<Db> {
        let db = Db { conn: Connection::open_in_memory()? };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> AppResult<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS recent_projects (
                 path TEXT PRIMARY KEY, title TEXT NOT NULL, template TEXT NOT NULL,
                 engine TEXT NOT NULL, opened_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS audit_log (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, project TEXT,
                 actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS audit_project ON audit_log(project, id);",
        )?;
        let current: Option<String> = self.conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).optional()?;
        match current.as_deref().map(str::parse::<i64>) {
            None => {
                self.conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', ?1)", params![SCHEMA_VERSION.to_string()])?;
            }
            Some(Ok(v)) if v > SCHEMA_VERSION => {
                return Err(AppError::Unavailable(format!("This data was written by a newer Game Studio (database version {v}).")));
            }
            Some(Ok(_)) => {}
            Some(Err(_)) => return Err(AppError::Internal("Unreadable database version".into())),
        }
        Ok(())
    }

    pub fn settings(&self) -> AppResult<Map<String, Value>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Map::new();
        for row in rows {
            let (k, v) = row?;
            out.insert(k, serde_json::from_str(&v).unwrap_or(Value::Null));
        }
        Ok(out)
    }

    pub fn get_setting(&self, key: &str) -> AppResult<Option<Value>> {
        let raw: Option<String> = self.conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0)).optional()?;
        Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
    }

    pub fn set_setting(&self, key: &str, value: &Value) -> AppResult<()> {
        if !valid_key(key) {
            return Err(AppError::Invalid(format!("Invalid setting name '{key}'")));
        }
        if looks_secret(key) {
            return Err(AppError::Denied("Credentials are never stored in settings. Use environment variables for API keys.".into()));
        }
        if value.is_null() {
            self.conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
            return Ok(());
        }
        let text = serde_json::to_string(value)?;
        if text.len() > 65_536 {
            return Err(AppError::Invalid("Setting value is too large".into()));
        }
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, text],
        )?;
        Ok(())
    }

    pub fn touch_recent(&self, path: &str, title: &str, template: &str, engine: &str) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO recent_projects (path, title, template, engine, opened_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET title = excluded.title, template = excluded.template,
             engine = excluded.engine, opened_at = excluded.opened_at",
            params![path, title, template, engine, now_iso()],
        )?;
        Ok(())
    }

    pub fn recents(&self, limit: u32) -> AppResult<Vec<RecentProject>> {
        let mut stmt = self.conn.prepare("SELECT path, title, template, engine, opened_at FROM recent_projects ORDER BY opened_at DESC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit], |r| {
            let path: String = r.get(0)?;
            Ok(RecentProject {
                exists: Path::new(&path).join("gamestudio.json").is_file(),
                path,
                title: r.get(1)?,
                template: r.get(2)?,
                engine: r.get(3)?,
                opened_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn is_recent(&self, path: &str) -> AppResult<bool> {
        Ok(self.conn.query_row("SELECT 1 FROM recent_projects WHERE path = ?1", params![path], |_| Ok(())).optional()?.is_some())
    }

    pub fn forget_recent(&self, path: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM recent_projects WHERE path = ?1", params![path])?;
        Ok(())
    }

    pub fn audit(&self, project: Option<&str>, actor: &str, action: &str, detail: &Value) -> AppResult<i64> {
        let text = serde_json::to_string(detail)?;
        if text.len() > 262_144 {
            return Err(AppError::Invalid("Audit detail is too large".into()));
        }
        self.conn.execute(
            "INSERT INTO audit_log (at, project, actor, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![now_iso(), project, actor, action, text],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn audit_list(&self, project: Option<&str>, limit: u32) -> AppResult<Vec<AuditEntry>> {
        let map = |r: &rusqlite::Row| -> rusqlite::Result<AuditEntry> {
            let detail: String = r.get(5)?;
            Ok(AuditEntry { id: r.get(0)?, at: r.get(1)?, project: r.get(2)?, actor: r.get(3)?, action: r.get(4)?, detail: serde_json::from_str(&detail).unwrap_or(Value::Null) })
        };
        let rows = match project {
            Some(p) => {
                let mut stmt = self.conn.prepare("SELECT id, at, project, actor, action, detail FROM audit_log WHERE project = ?1 ORDER BY id DESC LIMIT ?2")?;
                let v = stmt.query_map(params![p, limit], map)?.collect::<Result<Vec<_>, _>>()?;
                v
            }
            None => {
                let mut stmt = self.conn.prepare("SELECT id, at, project, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?1")?;
                let v = stmt.query_map(params![limit], map)?.collect::<Result<Vec<_>, _>>()?;
                v
            }
        };
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stores_settings_and_refuses_credentials() {
        let db = Db::open_in_memory().unwrap();
        db.set_setting("ai.allowCloud", &json!(true)).unwrap();
        db.set_setting("engines.godot.path", &json!("/Applications/Godot.app")).unwrap();
        assert_eq!(db.get_setting("ai.allowCloud").unwrap(), Some(json!(true)));
        assert!(matches!(db.set_setting("ai.openai.apiKey", &json!("sk-123")), Err(AppError::Denied(_))));
        assert!(matches!(db.set_setting("bad key!", &json!(1)), Err(AppError::Invalid(_))));
        db.set_setting("ai.allowCloud", &Value::Null).unwrap();
        assert_eq!(db.get_setting("ai.allowCloud").unwrap(), None);
    }

    #[test]
    fn keeps_recent_projects_newest_first() {
        let db = Db::open_in_memory().unwrap();
        db.touch_recent("/tmp/a", "A", "oware-abapa", "studio-board").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        db.touch_recent("/tmp/b", "B", "exploration-3d", "godot").unwrap();
        let list = db.recents(10).unwrap();
        assert_eq!(list.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["B", "A"]);
        assert!(db.is_recent("/tmp/a").unwrap());
        db.forget_recent("/tmp/a").unwrap();
        assert!(!db.is_recent("/tmp/a").unwrap());
    }

    #[test]
    fn records_audit_entries_per_project() {
        let db = Db::open_in_memory().unwrap();
        db.audit(Some("/p"), "assistant", "proposal.applied", &json!({"ops": 2})).unwrap();
        db.audit(None, "studio", "engine.install", &json!({"version": "4.7.2"})).unwrap();
        assert_eq!(db.audit_list(Some("/p"), 10).unwrap().len(), 1);
        assert_eq!(db.audit_list(None, 10).unwrap().len(), 2);
    }

    #[test]
    fn refuses_a_newer_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("studio.db");
        {
            let db = Db::open(&path).unwrap();
            db.conn.execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'", []).unwrap();
        }
        assert!(matches!(Db::open(&path), Err(AppError::Unavailable(_))));
    }
}
