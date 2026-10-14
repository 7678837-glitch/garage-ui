use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow};
use sqlx::{ConnectOptions, Row, SqlitePool};

use crate::util::now_secs;

#[derive(Clone, Debug)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub password_hash: String,
    pub role: String,
    pub can_download: bool,
    pub can_share: bool,
    pub disabled: bool,
}

impl User {
    pub fn is_admin(&self) -> bool {
        self.role == "admin" && !self.disabled
    }

    pub fn actor(&self) -> crate::access::Actor {
        crate::access::Actor {
            admin: self.role == "admin",
            download: self.role == "admin" || self.can_download,
            share: self.role == "admin" || self.can_share,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub user_id: i64,
    pub csrf_token: String,
    pub key_id: String,
    pub last_seen_at: i64,
    pub expires_at: i64,
}

#[cfg(test)]
#[derive(Clone, Debug)]
pub struct AuditRow {
    pub username: String,
    pub ip: String,
    pub result: String,
    pub reason: String,
    pub method: String,
    pub path: String,
    pub target: String,
    pub status: i64,
}

pub struct AuditEvent<'a> {
    pub username: &'a str,
    pub ip: &'a str,
    pub result: &'a str,
    pub reason: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub target: &'a str,
    pub status: i64,
}

pub async fn open(path: &Path) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging();
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .map_err(|_| anyhow::anyhow!("数据目录不可写: {}", path.display()))?;
    migrate(&pool).await?;
    Ok(pool)
}

async fn migrate(pool: &SqlitePool) -> anyhow::Result<()> {
    for statement in SCHEMA {
        // 语句来自上面的常量，不是外部输入。sqlx 0.9 只把字面量当成安全 SQL。
        sqlx::query(sqlx::AssertSqlSafe(*statement))
            .execute(pool)
            .await?;
    }
    // CREATE TABLE IF NOT EXISTS does not add columns on a database created before them.
    for statement in ZIP_TOKEN_COLUMNS {
        if let Err(error) = sqlx::query(sqlx::AssertSqlSafe(*statement))
            .execute(pool)
            .await
            && !duplicate_column(&error)
        {
            return Err(error.into());
        }
    }
    Ok(())
}

fn duplicate_column(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(db) => db.message().contains("duplicate column"),
        _ => false,
    }
}

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        can_download INTEGER NOT NULL DEFAULT 0,
        can_share INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    )",
    "CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username COLLATE NOCASE)",
    "CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        key_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        username TEXT NOT NULL,
        ip TEXT NOT NULL,
        result TEXT NOT NULL,
        reason TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL DEFAULT '',
        target TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 0
    )",
    "CREATE TABLE IF NOT EXISTS zip_tokens (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bucket_id TEXT NOT NULL DEFAULT '',
        keys_json TEXT NOT NULL DEFAULT '[]',
        used INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS bucket_keys (
        bucket_id TEXT PRIMARY KEY,
        access_key_id TEXT NOT NULL
    )",
];

pub async fn count_users(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await
}

pub async fn count_enabled_admins(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0")
        .fetch_one(pool)
        .await
}

pub async fn insert_user(
    pool: &SqlitePool,
    username: &str,
    password_hash: &str,
    role: &str,
    can_download: bool,
    can_share: bool,
) -> Result<i64, sqlx::Error> {
    let result = sqlx::query(
        "INSERT INTO users (username, password_hash, role, can_download, can_share, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(username)
    .bind(password_hash)
    .bind(role)
    .bind(i64::from(can_download))
    .bind(i64::from(can_share))
    .bind(now_secs())
    .execute(pool)
    .await?;
    Ok(result.last_insert_rowid())
}

pub async fn find_user_by_name(
    pool: &SqlitePool,
    username: &str,
) -> Result<Option<User>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, username, password_hash, role, can_download, can_share, disabled
         FROM users WHERE username = ? COLLATE NOCASE",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| user_from_row(&row)))
}

pub async fn find_user_by_id(pool: &SqlitePool, id: i64) -> Result<Option<User>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, username, password_hash, role, can_download, can_share, disabled
         FROM users WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| user_from_row(&row)))
}

pub async fn list_users(pool: &SqlitePool) -> Result<Vec<User>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, username, password_hash, role, can_download, can_share, disabled
         FROM users ORDER BY id",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(user_from_row).collect())
}

#[derive(Clone, Copy, Debug)]
pub struct UserCreatedAt {
    pub id: i64,
    pub created_at: i64,
}

pub async fn list_user_created_at(pool: &SqlitePool) -> Result<Vec<UserCreatedAt>, sqlx::Error> {
    let rows = sqlx::query("SELECT id, created_at FROM users")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .map(|row| UserCreatedAt {
            id: row.get("id"),
            created_at: row.get("created_at"),
        })
        .collect())
}

pub async fn update_user(
    pool: &SqlitePool,
    id: i64,
    role: &str,
    can_download: bool,
    can_share: bool,
    disabled: bool,
    password_hash: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE users
         SET role = ?, can_download = ?, can_share = ?, disabled = ?,
             password_hash = COALESCE(?, password_hash)
         WHERE id = ?",
    )
    .bind(role)
    .bind(i64::from(can_download))
    .bind(i64::from(can_share))
    .bind(i64::from(disabled))
    .bind(password_hash)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn reset_user_password(
    pool: &SqlitePool,
    id: i64,
    password_hash: &str,
) -> Result<bool, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let changed = sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(password_hash)
        .bind(id)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
        == 1;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(changed)
}

pub async fn change_user_password(
    pool: &SqlitePool,
    id: i64,
    expected_password_hash: &str,
    current_session_id: &str,
    password_hash: &str,
    replacement: &Session,
    idle_seconds: i64,
) -> Result<Option<User>, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    // The password proof and session must still be current when the password is committed.
    let row = sqlx::query(
        "UPDATE users SET password_hash = ?
         WHERE id = ? AND password_hash = ? AND disabled = 0
           AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND user_id = users.id
             AND key_id = ? AND expires_at > ? AND last_seen_at >= ?)
         RETURNING id, username, password_hash, role, can_download, can_share, disabled",
    )
    .bind(password_hash)
    .bind(id)
    .bind(expected_password_hash)
    .bind(current_session_id)
    .bind(&replacement.key_id)
    .bind(replacement.last_seen_at)
    .bind(replacement.last_seen_at.saturating_sub(idle_seconds))
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
        transaction.rollback().await?;
        return Ok(None);
    };
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query(
        "INSERT INTO sessions (id, user_id, csrf_token, key_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&replacement.id)
    .bind(id)
    .bind(&replacement.csrf_token)
    .bind(&replacement.key_id)
    .bind(replacement.last_seen_at)
    .bind(replacement.last_seen_at)
    .bind(replacement.expires_at)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(Some(user_from_row(&row)))
}

pub async fn delete_user(pool: &SqlitePool, id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn insert_login_session(
    pool: &SqlitePool,
    proof: &User,
    replacement: &Session,
    replace_id: Option<&str>,
) -> Result<Option<User>, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    // Acquire the write lock while checking the password proof, before rotating any session.
    let inserted = sqlx::query(
        "INSERT INTO sessions (id, user_id, csrf_token, key_id, created_at, last_seen_at, expires_at)
         SELECT ?, id, ?, ?, ?, ?, ? FROM users
         WHERE id = ? AND username = ? AND password_hash = ? AND disabled = 0",
    )
    .bind(&replacement.id)
    .bind(&replacement.csrf_token)
    .bind(&replacement.key_id)
    .bind(replacement.last_seen_at)
    .bind(replacement.last_seen_at)
    .bind(replacement.expires_at)
    .bind(proof.id)
    .bind(&proof.username)
    .bind(&proof.password_hash)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    if inserted == 0 {
        transaction.rollback().await?;
        return Ok(None);
    }
    if let Some(old) = replace_id {
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(old)
            .execute(&mut *transaction)
            .await?;
    }
    let row = sqlx::query(
        "SELECT id, username, password_hash, role, can_download, can_share, disabled
         FROM users WHERE id = ?",
    )
    .bind(proof.id)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(Some(user_from_row(&row)))
}

#[cfg(test)]
pub async fn insert_session(
    pool: &SqlitePool,
    id: &str,
    user_id: i64,
    csrf_token: &str,
    key_id: &str,
    now: i64,
    expires_at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sessions (id, user_id, csrf_token, key_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(user_id)
    .bind(csrf_token)
    .bind(key_id)
    .bind(now)
    .bind(now)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_session(pool: &SqlitePool, id: &str) -> Result<Option<Session>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, user_id, csrf_token, key_id, last_seen_at, expires_at FROM sessions WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| Session {
        id: row.get("id"),
        user_id: row.get("user_id"),
        csrf_token: row.get("csrf_token"),
        key_id: row.get("key_id"),
        last_seen_at: row.get("last_seen_at"),
        expires_at: row.get("expires_at"),
    }))
}

pub async fn touch_session(pool: &SqlitePool, id: &str, now: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_session(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_user_sessions(pool: &SqlitePool, user_id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_bucket_key(
    pool: &SqlitePool,
    bucket_id: &str,
    access_key_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO bucket_keys (bucket_id, access_key_id) VALUES (?, ?)
         ON CONFLICT(bucket_id) DO UPDATE SET access_key_id = excluded.access_key_id",
    )
    .bind(bucket_id)
    .bind(access_key_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn bucket_key(pool: &SqlitePool, bucket_id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT access_key_id FROM bucket_keys WHERE bucket_id = ?")
        .bind(bucket_id)
        .fetch_optional(pool)
        .await
}

pub async fn insert_audit(pool: &SqlitePool, event: AuditEvent<'_>) -> Result<(), sqlx::Error> {
    let username = truncate(event.username, 128);
    sqlx::query(
        "INSERT INTO audit (at, username, ip, result, reason, method, path, target, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(now_secs())
    .bind(username)
    .bind(event.ip)
    .bind(event.result)
    .bind(event.reason)
    .bind(event.method)
    .bind(event.path)
    .bind(event.target)
    .bind(event.status)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) fn retention_days() -> i64 {
    const DEFAULT_DAYS: i64 = 90;
    let Ok(raw) = std::env::var("AUDIT_RETENTION_DAYS") else {
        return DEFAULT_DAYS;
    };
    match raw.parse::<i64>() {
        Ok(days) if days >= 1 => days,
        _ => DEFAULT_DAYS,
    }
}

pub(crate) async fn delete_expired_audit(
    pool: &SqlitePool,
    now_secs: i64,
    retention_days: i64,
) -> Result<u64, sqlx::Error> {
    // Retention has no upper bound, so the window can exceed i64::MAX.
    let cutoff = now_secs.saturating_sub(retention_days.saturating_mul(86_400));
    let result = sqlx::query("DELETE FROM audit WHERE at < ?")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
pub async fn recent_audit(pool: &SqlitePool) -> Result<Vec<AuditRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT username, ip, result, reason, method, path, target, status
         FROM audit ORDER BY id DESC LIMIT 50",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| AuditRow {
            username: row.get("username"),
            ip: row.get("ip"),
            result: row.get("result"),
            reason: row.get("reason"),
            method: row.get("method"),
            path: row.get("path"),
            target: row.get("target"),
            status: row.get("status"),
        })
        .collect())
}

const ZIP_TOKEN_COLUMNS: &[&str] = &[
    "ALTER TABLE zip_tokens ADD COLUMN bucket_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE zip_tokens ADD COLUMN keys_json TEXT NOT NULL DEFAULT '[]'",
];

pub struct StoredZip {
    pub user_id: i64,
    pub bucket_id: String,
    pub keys_json: String,
    pub used: i64,
    pub created_at: i64,
}

pub async fn insert_zip(
    pool: &SqlitePool,
    id: &str,
    user_id: i64,
    bucket_id: &str,
    keys_json: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO zip_tokens (id, user_id, bucket_id, keys_json, used, created_at)
         VALUES (?, ?, ?, ?, 0, ?)",
    )
    .bind(id)
    .bind(user_id)
    .bind(bucket_id)
    .bind(keys_json)
    .bind(now_secs())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_unused_zip(pool: &SqlitePool, user_id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM zip_tokens WHERE user_id = ? AND used = 0")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn load_zip(pool: &SqlitePool, id: &str) -> Result<Option<StoredZip>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT user_id, bucket_id, keys_json, used, created_at FROM zip_tokens WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| StoredZip {
        user_id: row.get("user_id"),
        bucket_id: row.get("bucket_id"),
        keys_json: row.get("keys_json"),
        used: row.get("used"),
        created_at: row.get("created_at"),
    }))
}

pub async fn claim_zip(pool: &SqlitePool, id: &str, user_id: i64) -> Result<bool, sqlx::Error> {
    let result =
        sqlx::query("UPDATE zip_tokens SET used = 1 WHERE id = ? AND user_id = ? AND used = 0")
            .bind(id)
            .bind(user_id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected() == 1)
}

fn user_from_row(row: &SqliteRow) -> User {
    User {
        id: row.get("id"),
        username: row.get("username"),
        password_hash: row.get("password_hash"),
        role: row.get("role"),
        can_download: row.get::<i64, _>("can_download") != 0,
        can_share: row.get::<i64, _>("can_share") != 0,
        disabled: row.get::<i64, _>("disabled") != 0,
    }
}

fn truncate(value: &str, max_chars: usize) -> &str {
    match value.char_indices().nth(max_chars) {
        Some((index, _)) => &value[..index],
        None => value,
    }
}
