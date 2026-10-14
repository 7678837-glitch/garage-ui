use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::Json;
use axum::Router;
use axum::body::{Body, Bytes, HttpBody};
use axum::extract::{Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
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
use super::require;

const CSV_HEADER: &str = "at,username,ip,result,reason,method,path,target,status\n";
const EXPORT_ROWS: usize = 128;
const EXPORT_FRAME_BYTES: usize = 64 * 1024;

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
    #[serde(skip)]
    id: i64,
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

#[derive(Clone)]
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

async fn load_audit(
    app: &App,
    filter: &AuditFilter,
    offset: u64,
    limit: usize,
    after: Option<i64>,
    until: i64,
) -> Result<Vec<AuditItem>, sqlx::Error> {
    let Ok(offset) = i64::try_from(offset) else {
        return Ok(Vec::new());
    };
    let first_id = match after {
        Some(i64::MAX) => return Ok(Vec::new()),
        Some(id) => id + 1,
        None => i64::MIN,
    };
    let (user, user_any) = text_bound(&filter.user);
    let (from, from_any) = time_bound(filter.from);
    let (to, to_any) = time_bound(filter.to);
    let (action, action_any) = text_bound(&filter.action);
    let rows = sqlx::query(
        "SELECT id, at, username, ip, result, reason, method, path, target, status
         FROM audit
         WHERE (username = ? OR ? = 1)
           AND (at >= ? OR ? = 1)
           AND (at <= ? OR ? = 1)
           AND (target = ? OR ? = 1)
           AND id >= ?
           AND id <= ?
         ORDER BY id ASC LIMIT ? OFFSET ?",
    )
    .bind(user)
    .bind(user_any)
    .bind(from)
    .bind(from_any)
    .bind(to)
    .bind(to_any)
    .bind(action)
    .bind(action_any)
    .bind(first_id)
    .bind(until)
    .bind(limit as i64)
    .bind(offset)
    .fetch_all(&app.db)
    .await?;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        items.push(AuditItem {
            id: row.get("id"),
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
    let mut page = load_audit(&app, &filter, offset, limit + 1, None, i64::MAX)
        .await
        .map_err(|_| ApiError::internal())?;
    let more = page.len() > limit;
    page.truncate(limit);
    Ok(Json(json!({
        "items": page,
        "hasMore": more,
    })))
}

fn csv_cell(value: &str) -> String {
    let dangerous = value
        .trim_start_matches(|ch: char| ch.is_whitespace() || ch.is_control())
        .starts_with(['=', '+', '-', '@', '＝', '＋', '－', '＠'])
        || value
            .chars()
            .take_while(|ch| ch.is_whitespace() || ch.is_control())
            .any(|ch| matches!(ch, '\t' | '\r' | '\n'));
    let value = if dangerous {
        format!("'{value}")
    } else {
        value.to_string()
    };
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

fn csv_body(rows: &[AuditItem]) -> String {
    let mut out = String::new();
    for row in rows {
        let cells = [
            row.at.to_string(),
            csv_cell(&row.username),
            csv_cell(&row.ip),
            csv_cell(&row.result),
            csv_cell(&row.reason),
            csv_cell(&row.method),
            csv_cell(&row.path),
            csv_cell(&row.target),
            row.status.to_string(),
        ];
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    out
}

type AuditBatch = Pin<Box<dyn Future<Output = Result<Vec<AuditItem>, sqlx::Error>> + Send>>;

struct AuditCsv {
    app: App,
    filter: AuditFilter,
    until: i64,
    after: Option<i64>,
    more: bool,
    bytes: Bytes,
    pending: Option<AuditBatch>,
}

impl HttpBody for AuditCsv {
    type Data = Bytes;
    type Error = sqlx::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        if this.bytes.is_empty() {
            if !this.more {
                return Poll::Ready(None);
            }
            if this.pending.is_none() {
                let app = this.app.clone();
                let filter = this.filter.clone();
                let after = this.after;
                let until = this.until;
                this.pending = Some(Box::pin(async move {
                    load_audit(&app, &filter, 0, EXPORT_ROWS, after, until).await
                }));
            }
            let rows = match this
                .pending
                .as_mut()
                .expect("audit batch")
                .as_mut()
                .poll(cx)
            {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(result) => {
                    this.pending = None;
                    match result {
                        Ok(rows) => rows,
                        Err(error) => {
                            this.more = false;
                            return Poll::Ready(Some(Err(error)));
                        }
                    }
                }
            };
            this.more = rows.len() == EXPORT_ROWS;
            this.after = rows.last().map(|row| row.id);
            if rows.is_empty() {
                return Poll::Ready(None);
            }
            this.bytes = Bytes::from(csv_body(&rows));
        }
        let length = this.bytes.len().min(EXPORT_FRAME_BYTES);
        Poll::Ready(Some(Ok(http_body::Frame::data(
            this.bytes.split_to(length),
        ))))
    }
}

async fn export_audit(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<AuditQuery>,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewAudit)?;
    let filter = audit_filter(&query)?;
    // A fixed upper ID keeps new audit events from extending an active export.
    let until: Option<i64> = sqlx::query_scalar("SELECT MAX(id) FROM audit")
        .fetch_one(&app.db)
        .await
        .map_err(|_| ApiError::internal())?;
    let until = until.unwrap_or(i64::MIN);
    let rows = load_audit(&app, &filter, 0, EXPORT_ROWS, None, until)
        .await
        .map_err(|_| ApiError::internal())?;
    let mut bytes = String::from(CSV_HEADER);
    bytes.push_str(&csv_body(&rows));
    let body = AuditCsv {
        app,
        filter,
        until,
        after: rows.last().map(|row| row.id),
        more: rows.len() == EXPORT_ROWS,
        bytes: Bytes::from(bytes),
        pending: None,
    };
    Ok((
        [(header::CONTENT_TYPE, HeaderValue::from_static("text/csv"))],
        Body::new(body),
    )
        .into_response())
}

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route("/api/audit/export", get(export_audit))
        .route("/api/audit", get(list_audit))
}
