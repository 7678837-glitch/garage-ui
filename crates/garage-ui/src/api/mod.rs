use std::convert::Infallible;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{post, put};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::access::{self, Op};
use crate::db::{self, AuditEvent, User};
use crate::error::ApiError;
use crate::password;
use crate::proxy;
use crate::session::{
    self, Current, client_ip, csrf_exempt, csrf_matches,
};
use crate::state::App;

mod auth;
mod users;
mod buckets;
mod keys;
mod objects;
mod admin_tokens;
mod cluster;
mod workers;
mod audit;
pub(crate) use objects::put_bucket_object;
pub(crate) use objects::upload_object;
#[path = "../thumb.rs"]
mod thumb;

pub(crate) struct Authed(Current);

impl FromRequestParts<App> for Authed {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, ApiError> {
        let ip = client_ip(parts, app.settings.trusted_proxy);
        Ok(Authed(
            session::authenticate(app, &parts.headers, &ip).await?,
        ))
    }
}

pub(crate) struct ClientIp(String);

impl FromRequestParts<App> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, Infallible> {
        Ok(ClientIp(client_ip(parts, app.settings.trusted_proxy)))
    }
}

pub fn routes(app: App) -> Router<App> {
    let json_limit = app.settings.json_body_limit;
    let upload_limit = usize::try_from(app.settings.max_upload_bytes).unwrap_or(usize::MAX);
    let json_routes = Router::new()
        .merge(auth::routes())
        .merge(users::routes())
        .merge(buckets::routes())
        .merge(objects::routes())
        .merge(keys::routes())
        .merge(admin_tokens::routes())
        .merge(cluster::routes())
        .merge(workers::routes())
        .merge(audit::routes())
        .layer(middleware::from_fn_with_state(app.clone(), csrf))
        .layer(DefaultBodyLimit::max(json_limit));
    let upload = Router::new()
        .route("/api/objects", post(upload_object))
        .route("/api/buckets/{id}/objects/{*key}", put(put_bucket_object))
        .layer(middleware::from_fn_with_state(app, csrf))
        .layer(DefaultBodyLimit::max(upload_limit));
    json_routes.merge(upload)
}

async fn csrf(State(app): State<App>, request: Request, next: Next) -> Result<Response, ApiError> {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    if matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) || csrf_exempt(&method, &path)
    {
        return Ok(next.run(request).await);
    }
    let headers = request.headers().clone();
    let ip = request_ip(&app, &request);
    let current = session::authenticate(&app, &headers, &ip).await?;
    let header = headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !csrf_matches(header, &current.csrf_token) {
        record(
            &app,
            &current.user.username,
            &ip,
            "denied",
            "csrf_rejected",
            method.as_str(),
            &path,
            "",
            403,
        )
        .await?;
        return Err(ApiError::forbidden(
            "csrf_rejected",
            "CSRF token missing or mismatched",
        ));
    }
    Ok(next.run(request).await)
}

fn request_ip(app: &App, request: &Request) -> String {
    if app.settings.trusted_proxy
        && let Some(hop) = request
            .headers()
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .rfind(|part| !part.is_empty())
            })
    {
        return hop.to_string();
    }
    request
        .extensions()
        .get::<axum::extract::connect_info::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip().to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

#[derive(Deserialize)]
pub(crate) struct PageQuery {
    offset: Option<String>,
    limit: Option<String>,
}

async fn post_garage(
    app: &App,
    current: &Current,
    headers: &HeaderMap,
    endpoint: &str,
    query: Option<&str>,
    body: &[u8],
) -> Result<Response, ApiError> {
    proxy::dispatch(
        app,
        &current.user,
        &current.ip,
        &Method::POST,
        &format!("v2/{endpoint}"),
        query,
        body,
        headers,
    )
    .await
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn is_json_ws(byte: &u8) -> bool {
    matches!(*byte, b' ' | b'\n' | b'\r' | b'\t')
}

fn page_bounds(query: &PageQuery) -> Result<(u64, usize), ApiError> {
    let offset = match query.offset.as_deref() {
        None => 0,
        Some(text) => text.parse::<u64>().map_err(|_| {
            ApiError::bad_request("invalid_offset", "Offset must be a non-negative integer")
        })?,
    };
    let limit = match query.limit.as_deref() {
        None => 100,
        Some(text) => text.parse::<usize>().map_err(|_| {
            ApiError::bad_request("invalid_limit", "Limit must be a non-negative integer")
        })?,
    };
    Ok((offset, limit.min(1000)))
}

fn page_window<T>(items: Vec<T>, offset: u64, limit: usize) -> (Vec<T>, bool) {
    let total = items.len();
    let start = usize::try_from(offset).unwrap_or(usize::MAX);
    if start >= total {
        return (Vec::new(), false);
    }
    let end = start.saturating_add(limit).min(total);
    let page = items.into_iter().skip(start).take(limit).collect();
    (page, end < total)
}

fn page_json(page: proxy::Page) -> Json<Value> {
    Json(json!({
        "items": page.items,
        "hasMore": page.more,
    }))
}

fn require(user: &User, op: Op) -> Result<(), ApiError> {
    if access::permits(user.actor(), op) {
        Ok(())
    } else {
        Err(ApiError::forbidden("forbidden", "Not allowed"))
    }
}

pub(crate) fn validate_username(username: &str) -> Result<(), ApiError> {
    let count = username.chars().count();
    let legal = (1..=64).contains(&count)
        && username
            .chars()
            .all(|ch| !ch.is_control() && ch != ';' && ch != ' ');
    if legal {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "invalid_username",
            "Username is invalid",
        ))
    }
}

fn validate_password(password: &str) -> Result<(), ApiError> {
    password::validate(password).map_err(|_| {
        ApiError::bad_request(
            "password_invalid",
            "Password must be 10 to 72 characters and not blank",
        )
    })
}

async fn hash_password(password: &str, cost: u32) -> Result<String, ApiError> {
    password::hash_async(password.to_string(), cost)
        .await
        .map_err(|_| ApiError::internal())
}

// The arguments are the audit-table columns. Another struct would repeat AuditEvent.
#[allow(clippy::too_many_arguments)]
async fn record(
    app: &App,
    username: &str,
    ip: &str,
    result: &'static str,
    reason: &'static str,
    method: &str,
    path: &str,
    target: &str,
    status: i64,
) -> Result<(), ApiError> {
    db::insert_audit(
        &app.db,
        AuditEvent {
            username,
            ip,
            result,
            reason,
            method,
            path,
            target,
            status,
        },
    )
    .await
    .map_err(|_| ApiError::internal())
}

#[cfg(test)]
mod tests {
    include!("tests/support.rs");
    include!("tests/auth.rs");
    include!("tests/users.rs");
    include!("tests/buckets.rs");
    include!("tests/objects.rs");
    include!("tests/keys.rs");
    include!("tests/admin_tokens.rs");
    include!("tests/cluster.rs");
    include!("tests/workers.rs");
    include!("tests/audit.rs");
}
