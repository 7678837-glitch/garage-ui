use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

use crate::access::Op;
use crate::error::ApiError;
use crate::state::App;

use super::Authed;
use super::PageQuery;
use super::page_bounds;
use super::page_window;
use super::require;

#[derive(Deserialize)]
struct AuditQuery {
    user: Option<String>,
    from: Option<String>,
    to: Option<String>,
    action: Option<String>,
    offset: Option<String>,
    limit: Option<String>,
}

#[derive(Serialize)]
struct AuditItem {
    at: i64,
    username: String,
    ip: String,
    result: String,
    reason: String,
    method: String,
    path: String,
    target: String,
    status: i64,
}

struct AuditFilter {
    user: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
    action: Option<String>,
}

fn unix_seconds(value: Option<&str>) -> Result<Option<i64>, ApiError> {
    match value {
        None => Ok(None),
        Some(text) => text.parse::<i64>().map(Some).map_err(|_| {
            ApiError::bad_request("invalid_filter", "from and to must be unix seconds")
        }),
    }
}

fn audit_filter(query: &AuditQuery) -> Result<AuditFilter, ApiError> {
    Ok(AuditFilter {
        user: query.user.clone(),
        from: unix_seconds(query.from.as_deref())?,
        to: unix_seconds(query.to.as_deref())?,
        action: query.action.clone(),
    })
}

fn text_bound(value: &Option<String>) -> (String, i64) {
    match value {
        Some(text) => (text.clone(), 0),
        None => (String::new(), 1),
    }
}

fn time_bound(value: Option<i64>) -> (i64, i64) {
    match value {
        Some(seconds) => (seconds, 0),
        None => (0, 1),
    }
}

async fn load_audit(app: &App, filter: &AuditFilter) -> Result<Vec<AuditItem>, ApiError> {
    let (user, user_any) = text_bound(&filter.user);
    let (from, from_any) = time_bound(filter.from);
    let (to, to_any) = time_bound(filter.to);
    let (action, action_any) = text_bound(&filter.action);
    let rows = sqlx::query(
        "SELECT at, username, ip, result, reason, method, path, target, status
         FROM audit
         WHERE (username = ? OR ? = 1)
           AND (at >= ? OR ? = 1)
           AND (at <= ? OR ? = 1)
           AND (target = ? OR ? = 1)
         ORDER BY id ASC",
    )
    .bind(user)
    .bind(user_any)
    .bind(from)
    .bind(from_any)
    .bind(to)
    .bind(to_any)
    .bind(action)
    .bind(action_any)
    .fetch_all(&app.db)
    .await
    .map_err(|_| ApiError::internal())?;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        items.push(AuditItem {
            at: row.get("at"),
            username: row.get("username"),
            ip: row.get("ip"),
            result: row.get("result"),
            reason: row.get("reason"),
            method: row.get("method"),
            path: row.get("path"),
            target: row.get("target"),
            status: row.get("status"),
        });
    }
    Ok(items)
}

async fn list_audit(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Value>, ApiError> {
    require(&current.user, Op::ViewAudit)?;
    let (offset, limit) = page_bounds(&PageQuery {
        offset: query.offset.clone(),
        limit: query.limit.clone(),
    })?;
    let filter = audit_filter(&query)?;
    let rows = load_audit(&app, &filter).await?;
    let (page, more) = page_window(rows, offset, limit);
    Ok(Json(json!({
        "items": page,
        "hasMore": more,
    })))
}

pub(crate) fn routes() -> Router<App> {
    Router::new().route("/api/audit", get(list_audit))
}
