use std::convert::Infallible;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, RawQuery, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, patch, post, put};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::access::{self, Op};
use crate::db::{self, AuditEvent, User};
use crate::error::ApiError;
use crate::password;
use crate::proxy::{self, confirmed};
use crate::session::{
    self, Current, apply_login_cookies, clear_cookies, client_ip, cookie, csrf_exempt, csrf_matches,
};
use crate::state::{self, App};

mod auth;
mod users;
mod buckets;
mod keys;
mod objects;
mod admin_tokens;
mod cluster;
pub(crate) use admin_tokens::create_admin_token;
pub(crate) use admin_tokens::current_admin_token;
pub(crate) use admin_tokens::delete_admin_token;
pub(crate) use admin_tokens::get_admin_token;
pub(crate) use admin_tokens::list_admin_tokens;
pub(crate) use admin_tokens::update_admin_token;
pub(crate) use auth::capabilities;
pub(crate) use auth::change_password;
pub(crate) use auth::login;
pub(crate) use auth::logout;
pub(crate) use auth::public_config;
pub(crate) use auth::setup;
pub(crate) use auth::status;
pub(crate) use buckets::abort_multipart_uploads;
pub(crate) use buckets::add_bucket_alias;
pub(crate) use buckets::cleanup_uploads;
pub(crate) use buckets::create_bucket;
pub(crate) use buckets::delete_bucket;
pub(crate) use buckets::get_bucket;
pub(crate) use buckets::get_bucket_cors;
pub(crate) use buckets::get_bucket_lifecycle;
pub(crate) use buckets::grant_bucket_permissions;
pub(crate) use buckets::list_buckets;
pub(crate) use buckets::list_multipart_uploads;
pub(crate) use buckets::put_bucket_cors;
pub(crate) use buckets::put_bucket_lifecycle;
pub(crate) use buckets::put_bucket_credential;
pub(crate) use buckets::put_bucket_quotas;
pub(crate) use buckets::remove_bucket_alias;
pub(crate) use buckets::revoke_bucket_permissions;
pub(crate) use cluster::cluster_health;
pub(crate) use cluster::cluster_statistics;
pub(crate) use cluster::cluster_status;
pub(crate) use cluster::connect_cluster;
pub(crate) use cluster::garage;
pub(crate) use cluster::get_worker_variable;
pub(crate) use cluster::node_statistics;
pub(crate) use cluster::post_repair;
pub(crate) use cluster::put_worker_variable;
pub(crate) use cluster::stage_layout;
pub(crate) use keys::create_key;
pub(crate) use keys::delete_key;
pub(crate) use keys::key_secret;
pub(crate) use keys::list_keys;
pub(crate) use keys::patch_key;
pub(crate) use objects::create_archive_token;
pub(crate) use objects::download_archive;
pub(crate) use objects::delete_bucket_object;
pub(crate) use objects::delete_bucket_objects;
pub(crate) use objects::download_object;
pub(crate) use objects::inspect_object;
pub(crate) use objects::list_bucket_objects;
pub(crate) use objects::object_metadata;
pub(crate) use objects::preview_object;
pub(crate) use objects::put_bucket_object;
pub(crate) use objects::put_object;
pub(crate) use objects::search_bucket_objects;
pub(crate) use objects::share;
pub(crate) use objects::thumbnail_object;
pub(crate) use objects::upload_object;
pub(crate) use users::create_user;
pub(crate) use users::list_users;
pub(crate) use users::patch_user;
pub(crate) use users::remove_user;
pub(crate) use users::reset_password;
#[path = "../thumb.rs"]
mod thumb;

struct Authed(Current);

impl FromRequestParts<App> for Authed {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, ApiError> {
        let ip = client_ip(parts, app.settings.trusted_proxy);
        Ok(Authed(
            session::authenticate(app, &parts.headers, &ip).await?,
        ))
    }
}

struct ClientIp(String);

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
        .route("/api/setup", post(setup))
        .route("/api/auth/status", get(status))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/change-password", post(change_password))
        .route("/api/config", get(public_config))
        .route("/api/capabilities", get(capabilities))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", patch(patch_user).delete(remove_user))
        .route("/api/users/{id}/reset-password", post(reset_password))
        .route("/api/buckets", get(list_buckets).post(create_bucket))
        .route("/api/buckets/{id}", get(get_bucket).delete(delete_bucket))
        .route(
            "/api/buckets/{id}/aliases",
            post(add_bucket_alias).delete(remove_bucket_alias),
        )
        .route("/api/buckets/{id}/quotas", put(put_bucket_quotas))
        .route(
            "/api/buckets/{id}/cors",
            get(get_bucket_cors).put(put_bucket_cors),
        )
        .route(
            "/api/buckets/{id}/lifecycle",
            get(get_bucket_lifecycle).put(put_bucket_lifecycle),
        )
        .route(
            "/api/buckets/{id}/multipart",
            get(list_multipart_uploads).delete(abort_multipart_uploads),
        )
        .route(
            "/api/buckets/{id}/cleanup-uploads",
            post(cleanup_uploads),
        )
        .route("/api/buckets/{id}/credential", put(put_bucket_credential))
        .route(
            "/api/buckets/{id}/permissions",
            post(grant_bucket_permissions).delete(revoke_bucket_permissions),
        )
        .route("/api/buckets/{id}/objects", get(list_bucket_objects))
        .route(
            "/api/buckets/{id}/objects:delete",
            post(delete_bucket_objects),
        )
        .route(
            "/api/buckets/{id}/objects/{*key}",
            get(object_metadata).delete(delete_bucket_object),
        )
        .route("/api/buckets/{id}/search", get(search_bucket_objects))
        .route("/api/buckets/{id}/inspect/{*key}", get(inspect_object))
        .route("/api/keys", get(list_keys).post(create_key))
        .route("/api/keys/{id}", patch(patch_key).delete(delete_key))
        .route("/api/keys/{id}/secret", post(key_secret))
        .route(
            "/api/admin-tokens",
            get(list_admin_tokens).post(create_admin_token),
        )
        .route("/api/admin-tokens/current", get(current_admin_token))
        .route(
            "/api/admin-tokens/{id}",
            get(get_admin_token)
                .patch(update_admin_token)
                .delete(delete_admin_token),
        )
        .route("/api/objects/preview", get(preview_object))
        .route("/api/objects/download", get(download_object))
        .route("/api/objects/thumbnail", get(thumbnail_object))
        .route(
            "/api/buckets/{id}/archive-token",
            post(create_archive_token),
        )
        .route("/api/buckets/{id}/archive", get(download_archive))
        .route("/api/share", post(share))
        .route("/api/cluster/health", get(cluster_health))
        .route("/api/cluster/status", get(cluster_status))
        .route("/api/cluster/statistics", get(cluster_statistics))
        .route("/api/nodes/{id}/statistics", get(node_statistics))
        .route(
            "/api/nodes/{id}/worker-variables",
            get(get_worker_variable).put(put_worker_variable),
        )
        .route("/api/nodes/{id}/repair", post(post_repair))
        .route("/api/cluster/connect", post(connect_cluster))
        .route("/api/layout/stage", post(stage_layout))
        .route("/api/garage/{*path}", any(garage))
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
struct PageQuery {
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
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use axum::body::{Body, HttpBody};
    use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
    use axum::response::IntoResponse;
    use serde_json::{Value, json};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    use crate::error::ApiError;
    use crate::limit::test_quota;
    use crate::objects;
    use crate::router;
    use crate::state::{self, App};

    const PASSWORD: &str = "correct horse";
    const TOKEN: &str = "admin-token-value1";

    struct Session {
        id: String,
        csrf: String,
    }

    struct Exchange {
        status: StatusCode,
        headers: HeaderMap,
        body: String,
    }

    struct GarageMock {
        url: String,
        hits: Arc<AtomicUsize>,
        requests: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for GarageMock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl GarageMock {
        async fn start(node_info: &str) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let hits = Arc::new(AtomicUsize::new(0));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let hits_task = Arc::clone(&hits);
            let requests_task = Arc::clone(&requests);
            let node_info = node_info.to_string();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    hits_task.fetch_add(1, Ordering::SeqCst);
                    let mut buf = Vec::new();
                    let mut tmp = [0_u8; 1024];
                    while let Ok(read) = socket.read(&mut tmp).await {
                        if read == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..read]);
                        if buf.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let text = String::from_utf8_lossy(&buf);
                    let line = text.lines().next().unwrap_or("").to_string();
                    requests_task.lock().expect("requests").push(line.clone());
                    let body = if line.contains("/v2/GetNodeInfo?") {
                        node_info.clone()
                    } else {
                        r#"{"ok":true}"#.to_string()
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    if socket.write_all(response.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = socket.shutdown().await;
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                hits,
                requests,
                task,
            }
        }

        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("requests").clone()
        }
    }

    fn cookie_header(session: &Session) -> String {
        format!(
            "garage_session={}; garage_csrf={}",
            session.id, session.csrf
        )
    }

    fn session_from(headers: &HeaderMap) -> Session {
        let mut id = None;
        let mut csrf = None;
        for value in headers.get_all("set-cookie") {
            let text = value.to_str().expect("cookie");
            let pair = text.split(';').next().expect("pair");
            let (name, val) = pair.split_once('=').expect("equals");
            if name == "garage_session" {
                id = Some(val.to_string());
            }
            if name == "garage_csrf" {
                csrf = Some(val.to_string());
            }
        }
        Session {
            id: id.expect("session cookie"),
            csrf: csrf.expect("csrf cookie"),
        }
    }

    fn request(
        method: &str,
        uri: &str,
        body: Option<&str>,
        session: Option<&Session>,
    ) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(session) = session {
            builder = builder
                .header("cookie", cookie_header(session))
                .header("x-csrf-token", &session.csrf);
        }
        if let Some(body) = body {
            builder = builder.header("content-type", "application/json");
            return builder.body(Body::from(body.to_string())).unwrap();
        }
        builder.body(Body::empty()).unwrap()
    }

    async fn exchange(app: &App, request: Request<Body>) -> Exchange {
        let response = router(app.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        Exchange {
            status,
            headers,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    async fn login(app: &App) -> (Session, HeaderMap) {
        let response = router(app.clone())
            .oneshot(request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers().clone();
        (session_from(&headers), headers)
    }

    async fn app_for(dir: &std::path::Path, url: &str) -> App {
        state::test_app_with(
            dir,
            &[("GARAGE_ADMIN_URL", url), ("GARAGE_ADMIN_TOKEN", TOKEN)],
            test_quota(),
        )
        .await
    }

    fn user_items(body: &str) -> Vec<Value> {
        serde_json::from_str::<Value>(body).unwrap()["items"]
            .as_array()
            .expect("items")
            .clone()
    }

    fn code_of(body: &str) -> String {
        serde_json::from_str::<Value>(body).unwrap()["code"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }

    async fn authed_status(app: &App, session: &Session) -> Value {
        let response = exchange(app, request("GET", "/api/auth/status", None, Some(session))).await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(!response.body.contains(TOKEN), "{}", response.body);
        serde_json::from_str(&response.body).unwrap()
    }

    #[tokio::test]
    async fn old_garage_blocks_writes_and_keeps_reads() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let anon = exchange(&app, request("GET", "/api/auth/status", None, None)).await;
        assert_eq!(anon.status, StatusCode::OK, "{}", anon.body);
        assert_eq!(mock.hits(), 0, "anonymous status probed Garage");
        let (session, _) = login(&app).await;
        assert_eq!(mock.hits(), 0, "login probed Garage");

        let first = authed_status(&app, &session).await;
        assert_eq!(first["garage_version"], "v2.2.0");
        assert_eq!(first["garage_write_blocked"], true);
        assert_eq!(mock.hits(), 1);
        let second = authed_status(&app, &session).await;
        assert_eq!(second["garage_version"], "v2.2.0");
        assert_eq!(second["garage_write_blocked"], true);
        assert_eq!(mock.hits(), 1, "second status opened another connection");

        app.clear_garage_link().await;
        let third = authed_status(&app, &session).await;
        assert_eq!(third["garage_write_blocked"], true);
        assert_eq!(mock.hits(), 2, "cleared cache did not probe again");

        for (method, path) in [
            ("POST", "/api/garage/v2/PreviewClusterLayoutChanges"),
            ("POST", "/api/garage/v2/GetWorkerInfo"),
            ("POST", "/api/garage/v2/ListWorkers"),
            ("GET", "/api/garage/v2/GetClusterHealth"),
        ] {
            let body = if method == "POST" { Some("{}") } else { None };
            let response = exchange(&app, request(method, path, body, Some(&session))).await;
            assert_eq!(
                response.status,
                StatusCode::OK,
                "{method} {path} {}",
                response.body
            );
            assert_ne!(code_of(&response.body), "garage_too_old");
        }
        assert_eq!(mock.hits(), 6);

        for path in [
            "/api/garage/v2/CreateBucket",
            "/api/garage/v2/UpdateClusterLayout",
        ] {
            let response = exchange(&app, request("POST", path, Some("{}"), Some(&session))).await;
            assert_eq!(
                response.status,
                StatusCode::CONFLICT,
                "{path} {}",
                response.body
            );
            assert_eq!(code_of(&response.body), "garage_too_old");
            assert!(!response.body.contains(TOKEN), "{path} {}", response.body);
        }
        assert_eq!(mock.hits(), 6, "a blocked write called upstream");
        let seen = mock.requests().join("\n");
        assert!(seen.contains("GET /v2/GetNodeInfo?node=self "));
        assert!(seen.contains("POST /v2/PreviewClusterLayoutChanges "));
        assert!(seen.contains("POST /v2/GetWorkerInfo "));
        assert!(seen.contains("POST /v2/ListWorkers "));
        assert!(seen.contains("GET /v2/GetClusterHealth "));
        assert!(!seen.contains("CreateBucket"));
        assert!(!seen.contains("UpdateClusterLayout"));
    }

    #[tokio::test]
    async fn old_garage_write_block_is_audited() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (session, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/garage/v2/CreateBucket",
                Some("{}"),
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::CONFLICT,
            "garage_too_old",
            "Garage v2.3.0 or newer is required",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "garage_too_old");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "v2/CreateBucket");
        assert_eq!(row.target, "CreateBucket");
        assert_eq!(row.status, 409);
        let seen = mock.requests().join("\n");
        assert!(!seen.contains("CreateBucket"), "{seen}");
        let health = exchange(
            &app,
            request("GET", "/api/garage/v2/GetClusterHealth", None, Some(&session)),
        )
        .await;
        assert_eq!(health.status, StatusCode::OK, "{}", health.body);
        let after_read = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(after_read.len(), rows.len(), "{after_read:?}");
    }

    #[tokio::test]
    async fn unconfigured_garage_write_is_audited() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let (session, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/garage/v2/CreateBucket",
                Some("{}"),
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not configured",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "garage_unavailable");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "v2/CreateBucket");
        assert_eq!(row.target, "CreateBucket");
        assert_eq!(row.status, 502);
        let health = exchange(
            &app,
            request("GET", "/api/garage/v2/GetClusterHealth", None, Some(&session)),
        )
        .await;
        assert_eq!(health.status, StatusCode::BAD_GATEWAY, "{}", health.body);
        let after_read = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(after_read.len(), rows.len(), "{after_read:?}");
    }

    #[tokio::test]
    async fn garage_2_3_0_allows_a_write() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.3.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (session, _) = login(&app).await;
        let status = authed_status(&app, &session).await;
        assert_eq!(status["garage_version"], "v2.3.0");
        assert_eq!(status["garage_write_blocked"], false);
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/garage/v2/CreateBucket",
                Some("{}"),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(
            !response.body.contains("garage_too_old"),
            "{}",
            response.body
        );
        assert!(!response.body.contains(TOKEN), "{}", response.body);
        let seen = mock.requests().join("\n");
        assert!(seen.contains("POST /v2/CreateBucket "));
    }

    #[tokio::test]
    async fn missing_garage_version_does_not_block_writes() {
        let mock = GarageMock::start("{}").await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (session, _) = login(&app).await;
        let status = authed_status(&app, &session).await;
        assert_eq!(status["garage_version"], Value::Null);
        assert_eq!(status["garage_write_blocked"], false);
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/garage/v2/CreateBucket",
                Some("{}"),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(
            mock.requests()
                .join("\n")
                .contains("POST /v2/CreateBucket ")
        );
    }

    #[tokio::test]
    async fn changing_the_admin_url_probes_again() {
        let old = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let current = GarageMock::start(r#"{"garageVersion":"v2.3.0"}"#).await;
        let dir = crate::util::temp_dir();
        let mut app = app_for(&dir, &old.url).await;
        let (session, _) = login(&app).await;
        let first = authed_status(&app, &session).await;
        assert_eq!(first["garage_write_blocked"], true);
        let again = authed_status(&app, &session).await;
        assert_eq!(again["garage_version"], "v2.2.0");
        assert_eq!(old.hits(), 1);
        assert_eq!(current.hits(), 0);

        {
            let settings = std::sync::Arc::get_mut(&mut app.settings).expect("settings owners");
            settings.garage_admin_url = Some(current.url.clone());
        }
        let switched = authed_status(&app, &session).await;
        assert_eq!(switched["garage_version"], "v2.3.0");
        assert_eq!(switched["garage_write_blocked"], false);
        assert_eq!(old.hits(), 1, "the old admin URL was probed again");
        assert_eq!(current.hits(), 1);
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/garage/v2/CreateBucket",
                Some("{}"),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(
            current
                .requests()
                .join("\n")
                .contains("POST /v2/CreateBucket ")
        );
        assert!(!old.requests().join("\n").contains("CreateBucket"));
    }

    #[tokio::test]
    async fn download_filename_uses_rfc5987() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let (session, _) = login(&app).await;
        for (name, filename) in [("report", "报告.txt"), ("odd", "a?b#c%20d=e")] {
            app.fixtures.lock().expect("fixtures").insert(
                name.into(),
                state::Fixture {
                    content_type: "application/octet-stream".into(),
                    filename: filename.into(),
                    body: b"bytes".to_vec(),
                },
            );
        }
        let report = download(&app, &session, "report").await;
        assert_eq!(report.status, StatusCode::OK);
        assert_eq!(report.body, "bytes");
        assert_eq!(
            report.disposition,
            "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt"
        );
        let odd = download(&app, &session, "odd").await;
        assert_eq!(odd.status, StatusCode::OK);
        assert_eq!(odd.body, "bytes");
        assert_eq!(
            odd.disposition,
            "attachment; filename*=UTF-8''a%3Fb#c%2520d%3De"
        );
    }

    struct Download {
        status: StatusCode,
        body: String,
        disposition: String,
    }

    async fn download(app: &App, session: &Session, name: &str) -> Download {
        let response = router(app.clone())
            .oneshot(request(
                "GET",
                &format!("/api/objects/download?name={name}"),
                None,
                Some(session),
            ))
            .await
            .unwrap();
        let status = response.status();
        let disposition = response
            .headers()
            .get("content-disposition")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        Download {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
            disposition,
        }
    }

    struct CatalogMock {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for CatalogMock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl CatalogMock {
        async fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let requests_task = Arc::clone(&requests);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        break;
                    };
                    let _ = serve_catalog(socket, Arc::clone(&requests_task)).await;
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                requests,
                task,
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("requests").clone()
        }
    }

    async fn serve_catalog(
        mut socket: tokio::net::TcpStream,
        requests: Arc<Mutex<Vec<String>>>,
    ) -> std::io::Result<()> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..read]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() > 65536 {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf);
        let line = text.lines().next().unwrap_or("").to_string();
        requests.lock().expect("requests").push(line.clone());
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let path = target.split('?').next().unwrap_or("");
        let (status, body) = match path {
            "/v2/ListBucketsInfo" => ("200 OK", catalog_json(&["b0", "b1", "b2"], target)),
            "/v2/ListKeysInfo" => ("200 OK", catalog_json(&["k0", "k1", "k2"], target)),
            _ => ("404 Not Found", r#"{"error":"not found"}"#.to_string()),
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await?;
        let _ = socket.shutdown().await;
        Ok(())
    }

    fn catalog_json(ids: &[&str], target: &str) -> String {
        let limit = query_value(target, "limit")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(ids.len());
        let start = query_value(target, "offset")
            .and_then(|id| ids.iter().position(|item| *item == id))
            .unwrap_or(0);
        let end = start.saturating_add(limit).min(ids.len());
        let items: Vec<_> = ids[start..end]
            .iter()
            .map(|id| json!({ "id": id }))
            .collect();
        serde_json::to_string(&items).unwrap()
    }

    fn query_value<'a>(target: &'a str, key: &str) -> Option<&'a str> {
        let query = target.split_once('?')?.1;
        query.split('&').find_map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (name == key).then_some(value)
        })
    }

    fn assert_error(response: &Exchange, status: StatusCode, code: &str, message: &str) {
        assert_eq!(response.status, status, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "code": code, "message": message })
        );
    }

    fn assert_page(response: &Exchange, items: Value, more: bool) {
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(!response.body.contains(TOKEN), "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "items": items, "hasMore": more })
        );
    }

    async fn sign_in(app: &App, username: &str, password: &str) -> Session {
        let response = router(app.clone())
            .oneshot(request(
                "POST",
                "/api/auth/login",
                Some(&json!({ "username": username, "password": password }).to_string()),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        session_from(response.headers())
    }

    #[tokio::test]
    async fn anonymous_catalog_pages_are_unauthorized() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        for path in [
            "/api/buckets",
            "/api/keys",
            "/api/buckets?limit=nope",
            "/api/keys?offset=abc",
        ] {
            let response = exchange(&app, request("GET", path, None, None)).await;
            assert_error(
                &response,
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Login required",
            );
        }
    }

    #[tokio::test]
    async fn catalog_pages_without_garage_are_unavailable() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let (session, _) = login(&app).await;
        for path in ["/api/buckets", "/api/keys"] {
            let response = exchange(&app, request("GET", path, None, Some(&session))).await;
            assert_error(
                &response,
                StatusCode::BAD_GATEWAY,
                "garage_unavailable",
                "Garage admin API is not configured",
            );
        }
    }

    #[tokio::test]
    async fn catalog_pages_reject_a_bad_window() {
        let mock = CatalogMock::start().await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (session, _) = login(&app).await;
        for (path, code, message) in [
            (
                "/api/buckets?offset=abc&limit=2",
                "invalid_offset",
                "Offset must be a non-negative integer",
            ),
            (
                "/api/keys?offset=",
                "invalid_offset",
                "Offset must be a non-negative integer",
            ),
            (
                "/api/buckets?offset=-1&limit=2",
                "invalid_offset",
                "Offset must be a non-negative integer",
            ),
            (
                "/api/keys?offset=1&limit=abc",
                "invalid_limit",
                "Limit must be a non-negative integer",
            ),
            (
                "/api/buckets?limit=",
                "invalid_limit",
                "Limit must be a non-negative integer",
            ),
        ] {
            let response = exchange(&app, request("GET", path, None, Some(&session))).await;
            assert_error(&response, StatusCode::BAD_REQUEST, code, message);
        }
        assert!(
            mock.requests().is_empty(),
            "a rejected window called Garage: {:?}",
            mock.requests()
        );
    }

    #[tokio::test]
    async fn catalog_pages_clamp_an_oversized_limit() {
        let mock = CatalogMock::start().await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (session, _) = login(&app).await;

        let buckets = exchange(
            &app,
            request("GET", "/api/buckets?limit=1001", None, Some(&session)),
        )
        .await;
        assert_page(
            &buckets,
            json!([{ "id": "b0" }, { "id": "b1" }, { "id": "b2" }]),
            false,
        );

        let keys = exchange(
            &app,
            request("GET", "/api/keys?offset=0&limit=5000", None, Some(&session)),
        )
        .await;
        assert_page(
            &keys,
            json!([{ "id": "k0" }, { "id": "k1" }, { "id": "k2" }]),
            false,
        );

        let lines = mock.requests();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("GET /v2/ListBucketsInfo?limit=1000 "));
        assert!(!lines[0].contains("limit=1001"));
        assert!(lines[1].contains("GET /v2/ListKeysInfo?limit=1000 "));
        assert!(!lines[1].contains("offset="));
        assert!(!lines[1].contains("limit=5000"));
    }

    #[tokio::test]
    async fn catalog_pages_return_items_and_more() {
        let mock = CatalogMock::start().await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;

        let first = exchange(
            &app,
            request("GET", "/api/buckets?limit=2", None, Some(&admin)),
        )
        .await;
        assert_page(&first, json!([{ "id": "b0" }, { "id": "b1" }]), true);
        assert_eq!(mock.requests().len(), 1, "{:?}", mock.requests());
        assert!(mock.requests()[0].contains("GET /v2/ListBucketsInfo?limit=2 "));
        assert!(!mock.requests()[0].contains("offset="));

        let tail = exchange(
            &app,
            request("GET", "/api/buckets?offset=2&limit=2", None, Some(&admin)),
        )
        .await;
        assert_page(&tail, json!([{ "id": "b2" }]), false);

        let defaults = exchange(&app, request("GET", "/api/buckets", None, Some(&admin))).await;
        assert_page(
            &defaults,
            json!([{ "id": "b0" }, { "id": "b1" }, { "id": "b2" }]),
            false,
        );
        let bucket_lines: Vec<_> = mock
            .requests()
            .into_iter()
            .filter(|line| line.contains("ListBucketsInfo?limit=100 "))
            .collect();
        assert_eq!(bucket_lines.len(), 1, "{:?}", mock.requests());
        assert!(bucket_lines[0].contains("GET /v2/ListBucketsInfo?limit=100 "));
        assert!(!bucket_lines[0].contains("offset="));

        let wide = exchange(
            &app,
            request("GET", "/api/buckets?limit=1000", None, Some(&admin)),
        )
        .await;
        assert_page(
            &wide,
            json!([{ "id": "b0" }, { "id": "b1" }, { "id": "b2" }]),
            false,
        );
        assert!(
            mock.requests()
                .iter()
                .any(|line| line.contains("ListBucketsInfo?limit=1000 "))
        );

        let empty = exchange(
            &app,
            request("GET", "/api/keys?limit=0", None, Some(&admin)),
        )
        .await;
        assert_page(&empty, json!([]), true);
        assert!(
            mock.requests()
                .iter()
                .any(|line| line.contains("GET /v2/ListKeysInfo?limit=0 "))
        );

        let keys = exchange(
            &app,
            request("GET", "/api/keys?offset=2&limit=2", None, Some(&admin)),
        )
        .await;
        assert_page(&keys, json!([{ "id": "k2" }]), false);
        assert!(
            mock.requests()
                .iter()
                .all(|line| !line.contains("GetBucketInfo") && !line.contains("GetKeyInfo"))
        );

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Bea",
                        "password": "viewer horse",
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let viewer = sign_in(&app, "Bea", "viewer horse").await;
        let viewer_buckets = exchange(
            &app,
            request("GET", "/api/buckets?limit=1", None, Some(&viewer)),
        )
        .await;
        assert_page(&viewer_buckets, json!([{ "id": "b0" }]), true);
        let viewer_keys = exchange(
            &app,
            request("GET", "/api/keys?limit=1", None, Some(&viewer)),
        )
        .await;
        assert_page(&viewer_keys, json!([{ "id": "k0" }]), true);
    }

    #[derive(Clone)]
    struct UpstreamCall {
        line: String,
        body: String,
    }

    struct Upstream {
        url: String,
        hits: Arc<AtomicUsize>,
        calls: Arc<Mutex<Vec<UpstreamCall>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Upstream {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    #[derive(Clone)]
    enum UpstreamReply {
        Ok(String),
        Fixed(&'static str, String),
        WorkerVariables,
    }

    impl Upstream {
        async fn start(reply: UpstreamReply) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let hits = Arc::new(AtomicUsize::new(0));
            let calls = Arc::new(Mutex::new(Vec::new()));
            let hits_task = Arc::clone(&hits);
            let calls_task = Arc::clone(&calls);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    hits_task.fetch_add(1, Ordering::SeqCst);
                    let Ok((line, body)) = read_upstream(&mut socket).await else {
                        break;
                    };
                    calls_task.lock().expect("calls").push(UpstreamCall {
                        line: line.clone(),
                        body,
                    });
                    let (status, response_body) = upstream_reply(&line, &reply);
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{response_body}",
                        response_body.len()
                    );
                    if socket.write_all(response.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = socket.shutdown().await;
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                hits,
                calls,
                task,
            }
        }

        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }

        fn calls(&self) -> Vec<UpstreamCall> {
            self.calls.lock().expect("calls").clone()
        }
    }

    fn upstream_reply(line: &str, reply: &UpstreamReply) -> (String, String) {
        if line.contains("/v2/GetNodeInfo?") {
            return (
                "200 OK".to_string(),
                r#"{"garageVersion":"v2.3.0"}"#.to_string(),
            );
        }
        if let UpstreamReply::WorkerVariables = reply {
            if line.contains("/v2/SetWorkerVariable?") {
                return (
                    "200 OK".to_string(),
                    r#"{"success":{"n1":{"variable":"scrub_tranquility","value":"3"}},"error":{"gone":"down"}}"#
                        .to_string(),
                );
            }
            if line.contains("/v2/GetWorkerVariable?") {
                return (
                    "200 OK".to_string(),
                    r#"{"success":{"n1":{"scrub_tranquility":"3"}},"error":{"gone":"down"}}"#
                        .to_string(),
                );
            }
        }
        match reply {
            UpstreamReply::Ok(body) => ("200 OK".to_string(), body.clone()),
            UpstreamReply::Fixed(status, body) => ((*status).to_string(), body.clone()),
            UpstreamReply::WorkerVariables => (
                "500 Internal Server Error".to_string(),
                r#"{"error":"unexpected worker call"}"#.to_string(),
            ),
        }
    }

    async fn read_upstream(
        socket: &mut tokio::net::TcpStream,
    ) -> std::io::Result<(String, String)> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 2048];
        let header_end = loop {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "headers",
                ));
            }
            buf.extend_from_slice(&tmp[..read]);
            if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                break pos + 4;
            }
        };
        let header_text = String::from_utf8_lossy(&buf[..header_end]).into_owned();
        let length = header_text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap_or(0))
        });
        let mut body = buf[header_end..].to_vec();
        if let Some(length) = length {
            while body.len() < length {
                let read = socket.read(&mut tmp).await?;
                if read == 0 {
                    break;
                }
                body.extend_from_slice(&tmp[..read]);
            }
            body.truncate(length);
        }
        let line = header_text.lines().next().unwrap_or("").to_string();
        Ok((line, String::from_utf8_lossy(&body).into_owned()))
    }

    async fn viewer_session(app: &App, admin: &Session) -> Session {
        let created = exchange(
            app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Bea",
                        "password": "viewer horse",
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        sign_in(app, "Bea", "viewer horse").await
    }

    #[tokio::test]
    async fn admin_create_hits_create_bucket_once() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"new"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets",
                Some(
                    &json!({
                        "globalAlias": "photos",
                        "localAlias": {
                            "accessKeyId": "GK1",
                            "alias": "home",
                            "allow": { "read": true }
                        }
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, r#"{"id":"new"}"#);
        assert!(!response.body.contains(TOKEN), "{}", response.body);
        let creates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/CreateBucket "))
            .collect();
        assert_eq!(
            creates.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&creates[0].body).unwrap(),
            json!({
                "globalAlias": "photos",
                "localAlias": {
                    "accessKeyId": "GK1",
                    "alias": "home",
                    "allow": { "read": true }
                }
            })
        );
    }

    #[tokio::test]
    async fn viewer_create_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"new"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets",
                Some(r#"{"globalAlias":"photos"}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| &call.line)
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn delete_puts_encoded_id_in_the_query() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"ok":true}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("DELETE", "/api/buckets/a%20b%26c%3Dd", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, r#"{"ok":true}"#);
        let deletes: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("DeleteBucket"))
            .collect();
        assert_eq!(deletes.len(), 1);
        assert!(
            deletes[0]
                .line
                .contains("POST /v2/DeleteBucket?id=a%20b%26c%3Dd "),
            "{}",
            deletes[0].line
        );
    }

    #[tokio::test]
    async fn delete_keeps_garage_400_body() {
        let body = r#"{"message":"Bucket is not empty"}"#.to_string();
        let mock = Upstream::start(UpstreamReply::Fixed("400 Bad Request", body.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("DELETE", "/api/buckets/full", None, Some(&admin)),
        )
        .await;
        assert_eq!(
            response.status,
            StatusCode::BAD_REQUEST,
            "{}",
            response.body
        );
        assert_eq!(response.body, body);
    }

    const BUCKET_DIGITS: &str = r#"{"id":"bkt-1","objects":9007199254740993,"bytes":9007199254740993,"quotas":{"maxSize":9007199254740993,"maxObjects":9007199254740993}}"#;

    fn bucket_info_calls(mock: &Upstream) -> Vec<UpstreamCall> {
        mock.calls()
            .into_iter()
            .filter(|call| call.line.contains("GetBucketInfo"))
            .collect()
    }

    #[tokio::test]
    async fn bucket_detail_keeps_upstream_digits() {
        let mock = Upstream::start(UpstreamReply::Ok(BUCKET_DIGITS.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, BUCKET_DIGITS);
        assert!(response.body.contains("9007199254740993"));
        assert!(!response.body.contains("9007199254740992"));
        let details = bucket_info_calls(&mock);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            details[0].line.contains("GET /v2/GetBucketInfo?id=bkt-1 "),
            "{}",
            details[0].line
        );
        assert!(
            !details[0].line.contains("globalAlias"),
            "{}",
            details[0].line
        );
        assert!(!details[0].line.contains("search"), "{}", details[0].line);
    }

    #[tokio::test]
    async fn bucket_detail_encodes_an_id_with_ampersand_or_equals() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"kept"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/a%26b%3Dc", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, r#"{"id":"kept"}"#);
        let details = bucket_info_calls(&mock);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            details
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            details[0]
                .line
                .contains("GET /v2/GetBucketInfo?id=a%26b%3Dc "),
            "{}",
            details[0].line
        );
        assert!(
            !details[0].line.contains("globalAlias"),
            "{}",
            details[0].line
        );
        assert!(!details[0].line.contains("search"), "{}", details[0].line);
    }

    #[tokio::test]
    async fn viewer_can_read_one_bucket() {
        let mock = Upstream::start(UpstreamReply::Ok(BUCKET_DIGITS.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1", None, Some(&viewer)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, BUCKET_DIGITS);
        let details = bucket_info_calls(&mock);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            details[0].line.contains("GET /v2/GetBucketInfo?id=bkt-1 "),
            "{}",
            details[0].line
        );
    }

    #[tokio::test]
    async fn bucket_detail_requires_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let anonymous = exchange(&app, request("GET", "/api/buckets/bkt-1", None, None)).await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1", None, Some(&admin)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not configured",
        );
    }

    #[tokio::test]
    async fn bucket_detail_keeps_upstream_404() {
        let body = r#"{"message":"Bucket not found"}"#.to_string();
        let mock = Upstream::start(UpstreamReply::Fixed("404 Not Found", body.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/missing", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{}", response.body);
        assert_eq!(response.body, body);
        assert!(!response.body.contains("garage_unavailable"));
    }

    #[tokio::test]
    async fn mismatched_alias_bucket_id_stays_local() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"ok":true}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        for method in ["POST", "DELETE"] {
            let response = exchange(
                &app,
                request(
                    method,
                    "/api/buckets/bkt-1/aliases",
                    Some(r#"{"bucketId":"other","globalAlias":"photos"}"#),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &response,
                StatusCode::BAD_REQUEST,
                "bucket_id_mismatch",
                "Bucket id does not match",
            );
        }
        assert_eq!(mock.hits(), 0);
    }

    #[tokio::test]
    async fn alias_routes_send_path_id_to_garage() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let added = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"bucketId":"bkt-1","globalAlias":"photos"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(added.status, StatusCode::OK, "{}", added.body);
        let removed = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"localAlias":"photos","accessKeyId":"GK1"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);
        let calls = mock.calls();
        let add = calls
            .iter()
            .find(|call| call.line.contains("POST /v2/AddBucketAlias "))
            .expect("add");
        assert_eq!(
            serde_json::from_str::<Value>(&add.body).unwrap(),
            json!({"bucketId":"bkt-1","globalAlias":"photos"})
        );
        let remove = calls
            .iter()
            .find(|call| call.line.contains("POST /v2/RemoveBucketAlias "))
            .expect("remove");
        assert_eq!(
            serde_json::from_str::<Value>(&remove.body).unwrap(),
            json!({"bucketId":"bkt-1","localAlias":"photos","accessKeyId":"GK1"})
        );
    }

    #[tokio::test]
    async fn bucket_mutations_require_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        for (method, path, body) in [
            ("POST", "/api/buckets", Some("{}")),
            ("DELETE", "/api/buckets/bkt-1", None),
            (
                "POST",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"globalAlias":"photos"}"#),
            ),
            (
                "DELETE",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"globalAlias":"photos"}"#),
            ),
        ] {
            let response = exchange(&app, request(method, path, body, None)).await;
            assert_error(
                &response,
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Login required",
            );
        }
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("POST", "/api/buckets", Some("{}"), Some(&admin)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not configured",
        );
    }

    #[tokio::test]
    async fn quota_keeps_the_large_size_digits() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/a%20b%26c%3Dd/quotas",
                Some(r#"{"maxObjects":12,"maxSize":9007199254740993}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, r#"{"id":"bkt-1"}"#);
        let updates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("UpdateBucket"))
            .collect();
        assert_eq!(
            updates.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            updates[0]
                .line
                .contains("POST /v2/UpdateBucket?id=a%20b%26c%3Dd "),
            "{}",
            updates[0].line
        );
        assert_eq!(
            updates[0].body,
            r#"{"quotas":{"maxSize":9007199254740993,"maxObjects":12}}"#
        );
    }

    #[tokio::test]
    async fn quota_nulls_clear_both_fields() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxObjects":null,"maxSize":null}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let updates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/UpdateBucket?id=bkt-1 "))
            .collect();
        assert_eq!(updates.len(), 1);
        assert_eq!(
            updates[0].body,
            r#"{"quotas":{"maxSize":null,"maxObjects":null}}"#
        );
    }

    #[tokio::test]
    async fn rejected_quota_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        for body in [
            r#"{"maxSize":1}"#,
            r#"{"maxObjects":1}"#,
            r#"{"maxSize":-1,"maxObjects":1}"#,
            r#"{"maxSize":1.5,"maxObjects":1}"#,
            r#"{"maxSize":1e2,"maxObjects":2}"#,
            r#"{"maxSize":01,"maxObjects":1}"#,
        ] {
            let response = exchange(
                &app,
                request("PUT", "/api/buckets/bkt-1/quotas", Some(body), Some(&admin)),
            )
            .await;
            assert_error(
                &response,
                StatusCode::BAD_REQUEST,
                "invalid_quota",
                "maxSize and maxObjects must be non-negative integers or null",
            );
        }
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn bucket_quota_rejection_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxSize":1}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "invalid_quota",
            "maxSize and maxObjects must be non-negative integers or null",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_quota");
        assert_eq!(row.method, "PUT");
        assert_eq!(row.path, "/api/buckets/quotas");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn viewer_quota_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxSize":1,"maxObjects":2}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn bucket_cors_put_replaces_the_rules_and_get_returns_them() {
        let rules = json!([{
            "ID": "photos",
            "AllowedOrigin": ["https://photos.example"],
            "AllowedMethod": ["GET", "HEAD"],
            "AllowedHeader": ["*"],
            "ExposeHeader": ["ETag"],
            "MaxAgeSeconds": 600
        }]);
        let info = json!({
            "id": "bkt-1",
            "corsRules": rules.clone(),
            "lifecycleRules": [{ "ID": "expire", "Status": "Enabled" }]
        });
        let mock = Upstream::start(UpstreamReply::Ok(info.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let read = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/cors", None, Some(&admin)),
        )
        .await;
        assert_eq!(read.status, StatusCode::OK, "{}", read.body);
        assert_eq!(
            serde_json::from_str::<Value>(&read.body).unwrap(),
            json!({ "corsRules": rules })
        );
        assert!(!read.body.contains("lifecycleRules"), "{}", read.body);
        let details = bucket_info_calls(&mock);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            details
                .iter()
                .map(|call| &call.line)
                .collect::<Vec<_>>()
        );
        assert!(
            details[0].line.contains("GET /v2/GetBucketInfo?id=bkt-1 "),
            "{}",
            details[0].line
        );

        let replaced = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/cors",
                Some(&json!({ "corsRules": rules }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(replaced.status, StatusCode::OK, "{}", replaced.body);
        let updates = |mock: &Upstream| {
            mock.calls()
                .into_iter()
                .filter(|call| call.line.contains("UpdateBucket"))
                .collect::<Vec<_>>()
        };
        let sent = updates(&mock);
        assert_eq!(
            sent.len(),
            1,
            "{:?}",
            sent.iter().map(|call| &call.line).collect::<Vec<_>>()
        );
        assert!(
            sent[0].line.contains("POST /v2/UpdateBucket?id=bkt-1 "),
            "{}",
            sent[0].line
        );
        let sent_body: Value = serde_json::from_str(&sent[0].body).unwrap();
        assert_eq!(sent_body, json!({ "corsRules": rules }));
        assert!(sent_body.get("lifecycleRules").is_none(), "{}", sent[0].body);

        let cleared = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/cors",
                Some(r#"{"corsRules":[]}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.body);
        let sent = updates(&mock);
        assert_eq!(sent.len(), 2);
        assert_eq!(
            serde_json::from_str::<Value>(&sent[1].body).unwrap(),
            json!({ "corsRules": [] })
        );

        let viewer = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/cors",
                Some(&json!({ "corsRules": rules }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(updates(&mock).len(), 2);

        let missing = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/cors",
                Some("{}"),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(missing.status, StatusCode::BAD_REQUEST, "{}", missing.body);
        assert_eq!(updates(&mock).len(), 2);
    }

    #[tokio::test]
    async fn bucket_lifecycle_put_replaces_the_rules_and_get_returns_them() {
        let rules = json!([{
            "ID": "expire",
            "Status": "Enabled"
        }]);
        let info = json!({
            "id": "bkt-1",
            "corsRules": [{
                "ID": "photos",
                "AllowedOrigin": ["https://photos.example"]
            }],
            "lifecycleRules": rules.clone(),
        });
        let mock = Upstream::start(UpstreamReply::Ok(info.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let read = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/lifecycle", None, Some(&admin)),
        )
        .await;
        assert_eq!(read.status, StatusCode::OK, "{}", read.body);
        assert_eq!(
            serde_json::from_str::<Value>(&read.body).unwrap(),
            json!({ "lifecycleRules": rules })
        );
        assert!(!read.body.contains("corsRules"), "{}", read.body);
        let details = bucket_info_calls(&mock);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            details
                .iter()
                .map(|call| &call.line)
                .collect::<Vec<_>>()
        );
        assert!(
            details[0].line.contains("GET /v2/GetBucketInfo?id=bkt-1 "),
            "{}",
            details[0].line
        );

        let replaced = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/lifecycle",
                Some(&json!({ "lifecycleRules": rules }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(replaced.status, StatusCode::OK, "{}", replaced.body);
        let updates = |mock: &Upstream| {
            mock.calls()
                .into_iter()
                .filter(|call| call.line.contains("UpdateBucket"))
                .collect::<Vec<_>>()
        };
        let sent = updates(&mock);
        assert_eq!(
            sent.len(),
            1,
            "{:?}",
            sent.iter().map(|call| &call.line).collect::<Vec<_>>()
        );
        assert!(
            sent[0].line.contains("POST /v2/UpdateBucket?id=bkt-1 "),
            "{}",
            sent[0].line
        );
        let sent_body: Value = serde_json::from_str(&sent[0].body).unwrap();
        assert_eq!(sent_body, json!({ "lifecycleRules": rules }));
        assert!(sent_body.get("corsRules").is_none(), "{}", sent[0].body);

        let cleared = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/lifecycle",
                Some(r#"{"lifecycleRules":[]}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.body);
        let sent = updates(&mock);
        assert_eq!(sent.len(), 2);
        assert_eq!(
            serde_json::from_str::<Value>(&sent[1].body).unwrap(),
            json!({ "lifecycleRules": [] })
        );

        let viewer = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/lifecycle",
                Some(&json!({ "lifecycleRules": rules }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(updates(&mock).len(), 2);

        let missing = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/lifecycle",
                Some("{}"),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &missing,
            StatusCode::BAD_REQUEST,
            "invalid_lifecycle",
            "lifecycleRules must be an array",
        );
        assert_eq!(updates(&mock).len(), 2);
    }

    fn multipart_uploads_xml(uploads: &[(&str, &str, &str)]) -> String {
        let mut xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>bkt-1</Bucket><IsTruncated>false</IsTruncated>"#,
        );
        for (key, upload_id, initiated) in uploads {
            xml.push_str(&format!(
                "<Upload><Key>{key}</Key><UploadId>{upload_id}</UploadId><Initiated>{initiated}</Initiated></Upload>"
            ));
        }
        xml.push_str("</ListMultipartUploadsResult>");
        http_xml(&xml)
    }

    fn cleanup_calls(mock: &Upstream) -> Vec<UpstreamCall> {
        mock.calls()
            .into_iter()
            .filter(|call| call.line.contains("CleanupIncompleteUploads"))
            .collect()
    }

    #[tokio::test]
    async fn cleanup_drops_uploads_older_than_the_threshold() {
        let admin = Upstream::start(UpstreamReply::Ok(
            r#"{"uploadsDeleted":1}"#.to_string(),
        ))
        .await;
        let calls = Arc::clone(&admin.calls);
        let s3 = S3Mock::start(move |line| {
            if !line.contains("uploads") {
                return "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string();
            }
            let cleaned = calls.lock().expect("admin calls").iter().any(|call| {
                call.line.contains("CleanupIncompleteUploads")
            });
            if cleaned {
                multipart_uploads_xml(&[])
            } else {
                multipart_uploads_xml(&[("old.bin", "up-old", "2000-01-01T00:00:00Z")])
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", admin.url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("S3_ENDPOINT_URL", s3.url.as_str()),
                ("S3_REGION", "garage"),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
            ],
            test_quota(),
        )
        .await;
        let (session, _) = login(&app).await;

        let rejected = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/cleanup-uploads",
                Some(r#"{"olderThanSecs":-1}"#),
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &rejected,
            StatusCode::BAD_REQUEST,
            "invalid_age",
            "olderThanSecs must be an integer that is at least 0",
        );
        assert!(
            cleanup_calls(&admin).is_empty(),
            "{:?}",
            admin.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );

        let listed = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/multipart",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "uploads": [{
                    "key": "old.bin",
                    "uploadId": "up-old",
                    "initiated": "2000-01-01T00:00:00Z"
                }]
            })
        );

        let cleaned = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/cleanup-uploads",
                Some(r#"{"olderThanSecs":3600}"#),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(cleaned.status, StatusCode::OK, "{}", cleaned.body);
        assert_eq!(
            serde_json::from_str::<Value>(&cleaned.body).unwrap(),
            json!({ "uploadsDeleted": 1 })
        );
        let sent = cleanup_calls(&admin);
        assert_eq!(
            sent.len(),
            1,
            "{:?}",
            admin.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            sent[0].line.contains("POST /v2/CleanupIncompleteUploads "),
            "{}",
            sent[0].line
        );
        assert!(!sent[0].line.contains('?'), "{}", sent[0].line);
        let sent_body: Value = serde_json::from_str(&sent[0].body).unwrap();
        assert_eq!(
            sent_body,
            json!({ "bucketId": "bkt-1", "olderThanSecs": 3600 })
        );
        assert!(!sent[0].body.contains("uploadsDeleted"), "{}", sent[0].body);

        let empty = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/multipart",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(empty.status, StatusCode::OK, "{}", empty.body);
        assert_eq!(
            serde_json::from_str::<Value>(&empty.body).unwrap(),
            json!({ "uploads": [] })
        );
        assert!(!empty.body.contains("up-old"), "{}", empty.body);

        let viewer = viewer_session(&app, &session).await;
        let denied = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/cleanup-uploads",
                Some(r#"{"olderThanSecs":3600}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(cleanup_calls(&admin).len(), 1);
    }

    #[tokio::test]
    async fn abort_one_leaves_the_other_and_an_empty_body_aborts_the_rest() {
        let aborted = Arc::new(Mutex::new(Vec::<String>::new()));
        let recorded = Arc::clone(&aborted);
        let s3 = S3Mock::start(move |line| {
            if line.contains("uploadId=") {
                let id = query_value(request_target(line), "uploadId")
                    .map(percent_decode)
                    .unwrap_or_default();
                if id == "nope" {
                    return head_missing();
                }
                recorded.lock().expect("aborted uploads").push(id);
                return delete_ok();
            }
            if line.contains("uploads") {
                let gone = recorded.lock().expect("aborted uploads").clone();
                let pending: Vec<_> = [
                    ("old.bin", "up-old", "2000-01-01T00:00:00Z"),
                    ("new.bin", "up-new", "2000-01-02T00:00:00Z"),
                ]
                .into_iter()
                .filter(|(_, id, _)| !gone.iter().any(|seen| seen == id))
                .collect();
                return multipart_uploads_xml(&pending);
            }
            head_missing()
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &s3.url, true).await;
        let (session, _) = login(&app).await;
        let abort_lines = |mock: &S3Mock| {
            mock.requests()
                .into_iter()
                .filter(|line| line.contains("uploadId="))
                .collect::<Vec<_>>()
        };

        let missing = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/multipart",
                Some(r#"{"key":"missing","uploadId":"nope"}"#),
                Some(&session),
            ),
        )
        .await;
        assert_error(&missing, StatusCode::NOT_FOUND, "not_found", "Not found");
        assert!(
            s3.requests().iter().any(|line| line.contains("uploadId=nope")),
            "missing upload was not sent to S3: {:?}",
            s3.requests()
        );
        assert!(
            aborted.lock().expect("aborted uploads").is_empty(),
            "404 was recorded as a successful abort: {:?}",
            aborted.lock().expect("aborted uploads")
        );

        let one = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/multipart",
                Some(r#"{"key":"old.bin","uploadId":"up-old"}"#),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(one.status, StatusCode::OK, "{}", one.body);
        assert_eq!(
            serde_json::from_str::<Value>(&one.body).unwrap(),
            json!({ "aborted": 1 })
        );
        let lines = abort_lines(&s3);
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("up-old") && !line.contains("up-new"))
                .count(),
            1,
            "{lines:?}"
        );
        assert!(
            s3.requests().iter().all(|line| !line.contains("uploads")),
            "aborting one upload listed first: {:?}",
            s3.requests()
        );

        let listed = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/multipart", None, Some(&session)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "uploads": [{
                    "key": "new.bin",
                    "uploadId": "up-new",
                    "initiated": "2000-01-02T00:00:00Z"
                }]
            })
        );

        let before = abort_lines(&s3);
        let rest = exchange(
            &app,
            request("DELETE", "/api/buckets/bkt-1/multipart", None, Some(&session)),
        )
        .await;
        assert_eq!(rest.status, StatusCode::OK, "{}", rest.body);
        assert_eq!(
            serde_json::from_str::<Value>(&rest.body).unwrap(),
            json!({ "aborted": 1 })
        );
        let lines = abort_lines(&s3);
        assert_eq!(lines.len(), before.len() + 1, "{lines:?}");
        assert!(
            lines[before.len()].contains("up-new"),
            "{lines:?}"
        );

        let empty = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/multipart", None, Some(&session)),
        )
        .await;
        assert_eq!(empty.status, StatusCode::OK, "{}", empty.body);
        assert_eq!(
            serde_json::from_str::<Value>(&empty.body).unwrap(),
            json!({ "uploads": [] })
        );

        let viewer = viewer_session(&app, &session).await;
        let kept = abort_lines(&s3).len();
        let denied = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/multipart",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(abort_lines(&s3).len(), kept);
    }

    #[tokio::test]
    async fn bucket_write_denials_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/buckets",
                Some(&json!({ "globalAlias": "photos" }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&created, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets");
        assert_eq!(row.target, "photos");
        assert_eq!(row.status, 403);

        let removed = exchange(
            &app,
            request("DELETE", "/api/buckets/bkt-1", None, Some(&viewer)),
        )
        .await;
        assert_error(&removed, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);

        let quotas = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxSize":null,"maxObjects":null}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&quotas, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 3, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "PUT");
        assert_eq!(row.path, "/api/buckets/quotas");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn bucket_alias_denials_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let added = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"globalAlias":"photos"}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&added, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/aliases");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);

        let removed = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"globalAlias":"photos"}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&removed, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets/aliases");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn bucket_alias_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let empty = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/aliases",
                Some("{}"),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &empty,
            StatusCode::BAD_REQUEST,
            "invalid_alias",
            "Alias must be global or local",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_alias");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/aliases");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);

        let mismatch = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"bucketId":"other","globalAlias":"photos"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &mismatch,
            StatusCode::BAD_REQUEST,
            "bucket_id_mismatch",
            "Bucket id does not match",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "bucket_id_mismatch");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/aliases");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn bucket_permission_denials_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let body =
            r#"{"accessKeyId":"GK1","permissions":{"owner":false,"read":true,"write":false}}"#;

        let granted = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/permissions",
                Some(body),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&granted, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/permissions");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);

        let revoked = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/permissions",
                Some(body),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&revoked, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets/permissions");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn bucket_permission_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let empty = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/permissions",
                Some("{}"),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &empty,
            StatusCode::BAD_REQUEST,
            "invalid_permission",
            "accessKeyId and boolean permissions are required",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_permission");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/permissions");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);

        let mismatch = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/permissions",
                Some(
                    r#"{"bucketId":"other","accessKeyId":"GK1","permissions":{"owner":false,"read":true,"write":false}}"#,
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &mismatch,
            StatusCode::BAD_REQUEST,
            "bucket_id_mismatch",
            "Bucket id does not match",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "bucket_id_mismatch");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/permissions");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn quota_requires_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let anonymous = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxSize":1,"maxObjects":2}"#),
                None,
            ),
        )
        .await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxSize":1,"maxObjects":2}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not configured",
        );
    }

    #[tokio::test]
    async fn grant_and_revoke_forward_every_permission_bit() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"a&b=c"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let path = "/api/buckets/a%26b%3Dc/permissions";
        let granted = exchange(
            &app,
            request(
                "POST",
                path,
                Some(
                    r#"{"bucketId":"a&b=c","accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":true}}"#,
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(granted.status, StatusCode::OK, "{}", granted.body);
        assert_eq!(granted.body, r#"{"id":"a&b=c"}"#);
        let revoked = exchange(
            &app,
            request(
                "DELETE",
                path,
                Some(
                    r#"{"accessKeyId":"GK1","permissions":{"owner":false,"read":true,"write":false}}"#,
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(revoked.status, StatusCode::OK, "{}", revoked.body);
        let calls = mock.calls();
        let allows: Vec<_> = calls
            .iter()
            .filter(|call| call.line.contains("AllowBucketKey"))
            .collect();
        let denies: Vec<_> = calls
            .iter()
            .filter(|call| call.line.contains("DenyBucketKey"))
            .collect();
        assert_eq!(
            allows.len(),
            1,
            "{:?}",
            calls.iter().map(|call| &call.line).collect::<Vec<_>>()
        );
        assert_eq!(
            denies.len(),
            1,
            "{:?}",
            calls.iter().map(|call| &call.line).collect::<Vec<_>>()
        );
        assert!(
            allows[0].line.contains("POST /v2/AllowBucketKey "),
            "{}",
            allows[0].line
        );
        assert!(
            denies[0].line.contains("POST /v2/DenyBucketKey "),
            "{}",
            denies[0].line
        );
        assert!(!allows[0].line.contains('?'), "{}", allows[0].line);
        assert!(!denies[0].line.contains('?'), "{}", denies[0].line);
        assert_eq!(
            allows[0].body,
            r#"{"bucketId":"a&b=c","accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":true}}"#
        );
        assert_eq!(
            denies[0].body,
            r#"{"bucketId":"a&b=c","accessKeyId":"GK1","permissions":{"owner":false,"read":true,"write":false}}"#
        );
    }

    #[tokio::test]
    async fn rejected_permission_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let path = "/api/buckets/bkt-1/permissions";
        for method in ["POST", "DELETE"] {
            let none = exchange(
                &app,
                request(
                    method,
                    path,
                    Some(
                        r#"{"accessKeyId":"GK1","permissions":{"owner":false,"read":false,"write":false}}"#,
                    ),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &none,
                StatusCode::BAD_REQUEST,
                "invalid_permission",
                "Select at least one permission",
            );
            let mismatch = exchange(
                &app,
                request(
                    method,
                    path,
                    Some(
                        r#"{"bucketId":"other","accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":false}}"#,
                    ),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &mismatch,
                StatusCode::BAD_REQUEST,
                "bucket_id_mismatch",
                "Bucket id does not match",
            );
            for body in [
                r#"{"accessKeyId":"","permissions":{"owner":true,"read":false,"write":false}}"#,
                r#"{"permissions":{"owner":true,"read":true,"write":false}}"#,
                r#"{"accessKeyId":"GK1","permissions":{"owner":true,"write":false}}"#,
                r#"{"accessKeyId":"GK1","permissions":{"owner":true,"read":"yes","write":false}}"#,
                r#"{"accessKeyId":"GK1","websiteAccess":true,"permissions":{"owner":true,"read":true,"write":false}}"#,
                r#"{"accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":false,"websiteAccess":true}}"#,
            ] {
                let response =
                    exchange(&app, request(method, path, Some(body), Some(&admin))).await;
                assert_error(
                    &response,
                    StatusCode::BAD_REQUEST,
                    "invalid_permission",
                    "accessKeyId and boolean permissions are required",
                );
            }
        }
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn viewer_permission_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let body = r#"{"accessKeyId":"GK1","permissions":{"owner":true,"read":true,"write":true}}"#;
        for method in ["POST", "DELETE"] {
            let response = exchange(
                &app,
                request(
                    method,
                    "/api/buckets/bkt-1/permissions",
                    Some(body),
                    Some(&viewer),
                ),
            )
            .await;
            assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        }
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn permission_requires_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let body =
            r#"{"accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":false}}"#;
        for method in ["POST", "DELETE"] {
            let response = exchange(
                &app,
                request(method, "/api/buckets/bkt-1/permissions", Some(body), None),
            )
            .await;
            assert_error(
                &response,
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Login required",
            );
        }
        let (admin, _) = login(&app).await;
        for method in ["POST", "DELETE"] {
            let response = exchange(
                &app,
                request(
                    method,
                    "/api/buckets/bkt-1/permissions",
                    Some(body),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &response,
                StatusCode::BAD_GATEWAY,
                "garage_unavailable",
                "Garage admin API is not configured",
            );
        }
    }

    #[tokio::test]
    async fn old_garage_blocks_bucket_permission() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/permissions",
                Some(
                    r#"{"accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":false}}"#,
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::CONFLICT,
            "garage_too_old",
            "Garage v2.3.0 or newer is required",
        );
        assert!(
            mock.requests()
                .iter()
                .all(|line| !line.contains("AllowBucketKey")),
            "{:?}",
            mock.requests()
        );
    }

    #[tokio::test]
    async fn old_garage_blocks_bucket_create() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("POST", "/api/buckets", Some("{}"), Some(&admin)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::CONFLICT,
            "garage_too_old",
            "Garage v2.3.0 or newer is required",
        );
        assert!(
            mock.requests()
                .iter()
                .all(|line| !line.contains("CreateBucket"))
        );
    }

    struct ListStatus {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for ListStatus {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    #[derive(Clone, Copy)]
    enum ListReply {
        Fixed(&'static str, &'static str, &'static str),
        InfoThenPage,
    }

    impl ListStatus {
        async fn start(reply: ListReply) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&requests);
            let info_calls = Arc::new(AtomicUsize::new(0));
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let recorded = Arc::clone(&recorded);
                    let info_calls = Arc::clone(&info_calls);
                    tokio::spawn(async move {
                        let Ok(line) = read_request_line(&mut socket).await else {
                            return;
                        };
                        recorded.lock().expect("requests").push(line.clone());
                        let path = line.split_whitespace().nth(1).unwrap_or("");
                        let path = path.split('?').next().unwrap_or("");
                        let (status, content_type, body) = list_reply(path, &reply, &info_calls);
                        let _ = write_plain(&mut socket, status, content_type, body).await;
                    });
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                requests,
                task,
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("requests").clone()
        }
    }

    fn list_reply(
        path: &str,
        reply: &ListReply,
        info_calls: &AtomicUsize,
    ) -> (&'static str, &'static str, &'static str) {
        match path {
            "/v2/ListBucketsInfo" => match reply {
                ListReply::InfoThenPage => {
                    let call = info_calls.fetch_add(1, Ordering::SeqCst);
                    if call == 0 {
                        ("403 Forbidden", "text/plain", "denied by policy")
                    } else {
                        ("200 OK", "application/json", r#"[{"id":"b0"}]"#)
                    }
                }
                ListReply::Fixed(status, content_type, body) => (status, content_type, body),
            },
            "/v2/ListBuckets" => ("500 Internal Server Error", "text/plain", "id list"),
            _ => ("500 Internal Server Error", "text/plain", "unexpected"),
        }
    }

    async fn read_request_line(socket: &mut tokio::net::TcpStream) -> std::io::Result<String> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..read]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() > 65536 {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf);
        Ok(text.lines().next().unwrap_or("").to_string())
    }

    async fn write_plain(
        socket: &mut tokio::net::TcpStream,
        status: &str,
        content_type: &str,
        body: &str,
    ) -> std::io::Result<()> {
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await?;
        let _ = socket.shutdown().await;
        Ok(())
    }

    #[tokio::test]
    async fn bucket_list_keeps_upstream_status_and_404_stays_absent() {
        let denied = ListStatus::start(ListReply::InfoThenPage).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &denied.url).await;
        let (session, _) = login(&app).await;

        let blocked = exchange(&app, request("GET", "/api/buckets", None, Some(&session))).await;
        assert_eq!(blocked.status, StatusCode::FORBIDDEN, "{}", blocked.body);
        assert_eq!(
            serde_json::from_str::<Value>(&blocked.body).unwrap(),
            json!({
                "code": "upstream_error",
                "message": "denied by policy",
                "garageStatus": 403
            })
        );
        assert!(
            denied
                .requests()
                .iter()
                .any(|line| line.contains("ListBucketsInfo"))
        );
        assert!(
            denied
                .requests()
                .iter()
                .all(|line| !line.contains("ListBuckets "))
        );

        let page = exchange(&app, request("GET", "/api/buckets", None, Some(&session))).await;
        assert_page(&page, json!([{ "id": "b0" }]), false);
        assert_eq!(
            denied
                .requests()
                .iter()
                .filter(|line| line.contains("ListBucketsInfo"))
                .count(),
            2
        );
        assert!(
            denied
                .requests()
                .iter()
                .all(|line| !line.contains("ListBuckets "))
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(TOKEN));
        assert!(!sink.contains("denied by policy"));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let closed = crate::util::temp_dir();
        let refused = app_for(&closed, &format!("http://127.0.0.1:{port}")).await;
        let (refused_session, _) = login(&refused).await;
        let down = exchange(
            &refused,
            request("GET", "/api/buckets", None, Some(&refused_session)),
        )
        .await;
        assert_error(
            &down,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not reachable",
        );

        let ids = ListStatus::start(ListReply::Fixed(
            "404 Not Found",
            "application/json",
            r#"{"error":"not found"}"#,
        ))
        .await;
        let fallback = crate::util::temp_dir();
        let fallback_app = app_for(&fallback, &ids.url).await;
        let (fallback_session, _) = login(&fallback_app).await;
        let listed = exchange(
            &fallback_app,
            request("GET", "/api/buckets", None, Some(&fallback_session)),
        )
        .await;
        assert_eq!(
            listed.status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{}",
            listed.body
        );
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "code": "upstream_error",
                "message": "id list",
                "garageStatus": 500
            })
        );
        assert!(
            ids.requests()
                .iter()
                .any(|line| line.contains("ListBucketsInfo"))
        );
        assert!(
            ids.requests()
                .iter()
                .any(|line| line.contains("ListBuckets "))
        );
        assert!(
            ids.requests()
                .iter()
                .all(|line| !line.contains("GetBucketInfo"))
        );

        let json_error = ListStatus::start(ListReply::Fixed(
            "400 Bad Request",
            "application/json",
            r#"{"error":"nope"}"#,
        ))
        .await;
        let json_dir = crate::util::temp_dir();
        let json_app = app_for(&json_dir, &json_error.url).await;
        let (json_session, _) = login(&json_app).await;
        let passed = exchange(
            &json_app,
            request("GET", "/api/buckets", None, Some(&json_session)),
        )
        .await;
        assert_eq!(passed.status, StatusCode::BAD_REQUEST, "{}", passed.body);
        assert_eq!(passed.body, r#"{"error":"nope"}"#);
        assert!(
            json_error
                .requests()
                .iter()
                .all(|line| !line.contains("ListBuckets "))
        );
    }

    #[tokio::test]
    async fn rejected_key_name_does_not_call_garage() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"accessKeyId":"GK1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        for name in ["my key", "my.key", "名字", ""] {
            let response = exchange(
                &app,
                request(
                    "POST",
                    "/api/keys",
                    Some(&json!({ "name": name }).to_string()),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &response,
                StatusCode::BAD_REQUEST,
                "invalid_key_name",
                "Key name is invalid",
            );
        }
        assert_eq!(mock.hits(), 0);
    }

    #[tokio::test]
    async fn create_key_invalid_name_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let name = "my key";
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/keys",
                Some(&json!({ "name": name }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "invalid_key_name",
            "Key name is invalid",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_key_name");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/keys");
        assert_eq!(row.target, name);
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn patch_key_invalid_body_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request("PATCH", "/api/keys/GK1", Some("{}"), Some(&admin)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "invalid_key_patch",
            "Send a name or createBucket",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_key_patch");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/keys");
        assert_eq!(row.target, "GK1");
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn key_write_denials_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/keys",
                Some(&json!({ "name": "photos" }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&created, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/keys");
        assert_eq!(row.target, "photos");
        assert_eq!(row.status, 403);

        let patched = exchange(
            &app,
            request(
                "PATCH",
                "/api/keys/GK1",
                Some(&json!({ "name": "renamed" }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&patched, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/keys");
        assert_eq!(row.target, "GK1");
        assert_eq!(row.status, 403);

        let removed = exchange(
            &app,
            request("DELETE", "/api/keys/GK1", None, Some(&viewer)),
        )
        .await;
        assert_error(&removed, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 3, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/keys");
        assert_eq!(row.target, "GK1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn key_secret_denial_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request("POST", "/api/keys/GK1/secret", None, Some(&viewer)),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/keys/secret");
        assert_eq!(row.target, "GK1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn key_secret_unconfirmed_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request("POST", "/api/keys/GK1/secret", None, Some(&admin)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::FORBIDDEN,
            "confirmation_required",
            "Confirmation required",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "confirmation_required");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/keys/secret");
        assert_eq!(row.target, "GK1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn admin_create_hits_create_key_once() {
        let secret = "wJalrXUtnFEMI";
        let created = json!({
            "accessKeyId": "GK1",
            "name": "photo_roll-1",
            "secretAccessKey": secret,
            "expired": false,
            "permissions": { "createBucket": false },
            "buckets": []
        })
        .to_string();
        let mock = Upstream::start(UpstreamReply::Ok(created.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/keys",
                Some(&json!({ "name": "photo_roll-1" }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, created);
        assert_eq!(
            response
                .headers
                .get("cache-control")
                .and_then(|value| value.to_str().ok()),
            Some("private, no-store")
        );
        let creates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/CreateKey "))
            .collect();
        assert_eq!(
            creates.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&creates[0].body).unwrap(),
            json!({ "name": "photo_roll-1" })
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert!(rows.iter().any(|row| row.target == "GK1"));
        assert!(
            rows.iter()
                .all(|row| !row.target.contains(secret) && !row.path.contains(secret))
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
    }

    #[tokio::test]
    async fn viewer_create_key_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"accessKeyId":"GK1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/keys",
                Some(r#"{"name":"photos"}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(mock.hits(), 0);
    }

    #[tokio::test]
    async fn rename_forwards_the_name_body() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"accessKeyId":"GK1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "PATCH",
                "/api/keys/a%20b",
                Some(r#"{"name":"已有 名称"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let updates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/UpdateKey?"))
            .collect();
        assert_eq!(updates.len(), 1);
        assert!(updates[0].line.contains("id=a%20b"), "{}", updates[0].line);
        assert_eq!(
            serde_json::from_str::<Value>(&updates[0].body).unwrap(),
            json!({ "name": "已有 名称" })
        );
    }

    #[tokio::test]
    async fn create_bucket_switch_sends_allow_or_deny() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"accessKeyId":"GK1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        for (body, forwarded) in [
            (
                r#"{"createBucket":true}"#,
                json!({ "allow": { "createBucket": true } }),
            ),
            (
                r#"{"createBucket":false}"#,
                json!({ "deny": { "createBucket": true } }),
            ),
        ] {
            let response = exchange(
                &app,
                request("PATCH", "/api/keys/GK1", Some(body), Some(&admin)),
            )
            .await;
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            let updates: Vec<_> = mock
                .calls()
                .into_iter()
                .filter(|call| call.line.contains("POST /v2/UpdateKey?id=GK1 "))
                .collect();
            let sent =
                serde_json::from_str::<Value>(&updates.last().expect("update").body).unwrap();
            assert_eq!(sent, forwarded);
        }
    }

    #[tokio::test]
    async fn delete_key_puts_encoded_id_in_the_query() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"ok":true}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("DELETE", "/api/keys/a%20b%26c%3Dd", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let deletes: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("DeleteKey"))
            .collect();
        assert_eq!(deletes.len(), 1);
        assert!(
            deletes[0]
                .line
                .contains("POST /v2/DeleteKey?id=a%20b%26c%3Dd "),
            "{}",
            deletes[0].line
        );
        assert!(deletes[0].body.is_empty(), "{}", deletes[0].body);
    }

    #[tokio::test]
    async fn key_mutations_require_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        for (method, path, body) in [
            ("POST", "/api/keys", Some(r#"{"name":"photos"}"#)),
            ("PATCH", "/api/keys/GK1", Some(r#"{"name":"renamed"}"#)),
            ("DELETE", "/api/keys/GK1", None),
        ] {
            let response = exchange(&app, request(method, path, body, None)).await;
            assert_error(
                &response,
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Login required",
            );
        }
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/keys",
                Some(r#"{"name":"photos"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not configured",
        );
    }

    fn cluster_calls(mock: &Upstream, endpoint: &str) -> Vec<UpstreamCall> {
        mock.calls()
            .into_iter()
            .filter(|call| call.line.contains(endpoint))
            .collect()
    }

    fn assert_cluster_get(calls: &[UpstreamCall], path: &str) {
        let lines: Vec<_> = calls.iter().map(|call| call.line.as_str()).collect();
        assert_eq!(lines.len(), 1, "{lines:?}");
        let target = lines[0].split_whitespace().nth(1).unwrap_or("");
        assert_eq!(target, path, "{}", lines[0]);
        assert!(calls[0].body.is_empty(), "{}", calls[0].body);
    }

    #[tokio::test]
    async fn cluster_health_returns_the_garage_body() {
        let body = r#"{ "status" : "healthy" , "storageNodesUp" : 2 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/health", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetClusterHealth"),
            "/v2/GetClusterHealth",
        );
    }

    #[tokio::test]
    async fn cluster_status_returns_the_garage_body() {
        let body = r#"{ "layoutVersion" : 4 , "nodes" : [ "n1" ] }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/status", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetClusterStatus"),
            "/v2/GetClusterStatus",
        );
    }

    #[tokio::test]
    async fn viewer_can_read_cluster_health() {
        let body = r#"{ "status" : "healthy" , "knownNodes" : 3 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/health", None, Some(&viewer)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetClusterHealth"),
            "/v2/GetClusterHealth",
        );
    }

    #[tokio::test]
    async fn cluster_reads_require_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        for path in ["/api/cluster/health", "/api/cluster/status"] {
            let anonymous = exchange(&app, request("GET", path, None, None)).await;
            assert_error(
                &anonymous,
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Login required",
            );
        }
        let (admin, _) = login(&app).await;
        for path in ["/api/cluster/health", "/api/cluster/status"] {
            let response = exchange(&app, request("GET", path, None, Some(&admin))).await;
            assert_error(
                &response,
                StatusCode::BAD_GATEWAY,
                "garage_unavailable",
                "Garage admin API is not configured",
            );
        }
    }

    #[tokio::test]
    async fn cluster_statistics_returns_the_garage_body() {
        let body = r#"{ "freeform" : "nodes=3 bytes=9007199254740993" , "totalObjectBytes" : 9007199254740993 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/statistics", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetClusterStatistics"),
            "/v2/GetClusterStatistics",
        );
    }

    #[tokio::test]
    async fn viewer_can_read_cluster_statistics() {
        let body = r#"{ "freeform" : "ok" , "bucketCount" : 9007199254740993 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/statistics", None, Some(&viewer)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetClusterStatistics"),
            "/v2/GetClusterStatistics",
        );
    }

    #[tokio::test]
    async fn cluster_statistics_requires_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let anonymous = exchange(&app, request("GET", "/api/cluster/statistics", None, None)).await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/statistics", None, Some(&admin)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not configured",
        );
    }

    #[tokio::test]
    async fn node_statistics_returns_the_garage_body() {
        let body = r#"{ "freeform" : "node bytes=9007199254740993" , "totalObjectBytes" : 9007199254740993 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/a%26b%3Dc/statistics",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetNodeStatistics"),
            "/v2/GetNodeStatistics?node=a%26b%3Dc",
        );
    }

    #[tokio::test]
    async fn viewer_can_read_node_statistics() {
        let body = r#"{ "freeform" : "ok" , "bucketCount" : 9007199254740993 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/a%26b%3Dc/statistics",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetNodeStatistics"),
            "/v2/GetNodeStatistics?node=a%26b%3Dc",
        );
        let bare = crate::util::temp_dir();
        let garage_less = state::test_app(&bare).await;
        let anonymous = exchange(
            &garage_less,
            request("GET", "/api/nodes/a%26b%3Dc/statistics", None, None),
        )
        .await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
    }

    fn assert_worker_post(calls: &[UpstreamCall], path: &str, body: Value) {
        assert_eq!(
            calls.len(),
            1,
            "{:?}",
            calls
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(calls[0].line.starts_with("POST "), "{}", calls[0].line);
        let target = calls[0].line.split_whitespace().nth(1).unwrap_or("");
        assert_eq!(target, path, "{}", calls[0].line);
        assert_eq!(
            serde_json::from_str::<Value>(&calls[0].body).unwrap(),
            body
        );
    }

    #[tokio::test]
    async fn set_worker_variable_reads_back_the_new_value() {
        let mock = Upstream::start(UpstreamReply::WorkerVariables).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let sent = r#"{"variable":"scrub_tranquility","value":"3"}"#;
        let put = exchange(
            &app,
            with_confirm(request(
                "PUT",
                "/api/nodes/n1/worker-variables",
                Some(sent),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(put.status, StatusCode::OK, "{}", put.body);
        assert_eq!(
            serde_json::from_str::<Value>(&put.body).unwrap(),
            json!({ "variable": "scrub_tranquility", "value": "3" })
        );
        assert_worker_post(
            &cluster_calls(&mock, "SetWorkerVariable"),
            "/v2/SetWorkerVariable?node=n1",
            json!({ "variable": "scrub_tranquility", "value": "3" }),
        );

        let got = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/n1/worker-variables?variable=scrub_tranquility",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(got.status, StatusCode::OK, "{}", got.body);
        assert_eq!(
            serde_json::from_str::<Value>(&got.body).unwrap(),
            json!({ "scrub_tranquility": "3" })
        );
        assert_worker_post(
            &cluster_calls(&mock, "GetWorkerVariable"),
            "/v2/GetWorkerVariable?node=n1",
            json!({ "variable": "scrub_tranquility" }),
        );

        let listed = exchange(
            &app,
            request("GET", "/api/nodes/n1/worker-variables", None, Some(&admin)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let gets = cluster_calls(&mock, "GetWorkerVariable");
        assert_eq!(
            gets.len(),
            2,
            "{:?}",
            gets.iter().map(|call| call.line.clone()).collect::<Vec<_>>()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&gets[1].body).unwrap(),
            json!({ "variable": null })
        );

        let sets_before_reject = cluster_calls(&mock, "SetWorkerVariable").len();
        for body in [
            r#"{"variable":"scrub_tranquility"}"#,
            r#"{"variable":"scrub_tranquility","value":"3","extra":true}"#,
            r#"{"variable":"scrub_tranquility","value":3}"#,
            r#"["scrub_tranquility","3"]"#,
            "null",
            "[]",
            r#""scrub_tranquility""#,
        ] {
            let rejected = exchange(
                &app,
                request(
                    "PUT",
                    "/api/nodes/n1/worker-variables",
                    Some(body),
                    Some(&admin),
                ),
            )
            .await;
            assert_eq!(
                rejected.status,
                StatusCode::BAD_REQUEST,
                "{body} -> {}",
                rejected.body
            );
            assert_error(
                &rejected,
                StatusCode::BAD_REQUEST,
                "invalid_variable",
                "variable and value are required",
            );
        }
        assert_eq!(
            cluster_calls(&mock, "SetWorkerVariable").len(),
            sets_before_reject
        );

        let viewer = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            with_confirm(request(
                "PUT",
                "/api/nodes/n1/worker-variables",
                Some(sent),
                Some(&viewer),
            )),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            cluster_calls(&mock, "SetWorkerVariable").len(),
            sets_before_reject
        );
        let viewer_get = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/n1/worker-variables?variable=scrub_tranquility",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(
            &viewer_get,
            StatusCode::FORBIDDEN,
            "forbidden",
            "Not allowed",
        );
        assert_eq!(cluster_calls(&mock, "GetWorkerVariable").len(), 2);

        let gone = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/gone/worker-variables?variable=scrub_tranquility",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_error(&gone, StatusCode::BAD_GATEWAY, "garage_error", "down");
    }

    #[tokio::test]
    async fn repair_tables_writes_an_audit_row() {
        let mock = Upstream::start(UpstreamReply::Ok(
            r#"{"success":{"n1":null},"error":{}}"#.to_string(),
        ))
        .await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let posted = exchange(
            &app,
            with_confirm(request(
                "POST",
                "/api/nodes/n1/repair",
                Some(r#"{"repairType":"tables"}"#),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(posted.status, StatusCode::OK, "{}", posted.body);
        assert_eq!(posted.body, "null");
        assert_worker_post(
            &cluster_calls(&mock, "LaunchRepairOperation"),
            "/v2/LaunchRepairOperation?node=n1",
            json!({ "repairType": "tables" }),
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "v2/LaunchRepairOperation");
        assert_eq!(row.target, "LaunchRepairOperation");
        assert_eq!(row.status, 200);

        let scrub = exchange(
            &app,
            with_confirm(request(
                "POST",
                "/api/nodes/n1/repair",
                Some(r#"{"repairType":{"scrub":"start"}}"#),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(scrub.status, StatusCode::OK, "{}", scrub.body);
        assert_eq!(scrub.body, "null");
        let launches = cluster_calls(&mock, "LaunchRepairOperation");
        assert_eq!(
            launches.len(),
            2,
            "{:?}",
            launches
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&launches[1].body).unwrap(),
            json!({ "repairType": { "scrub": "start" } })
        );

        let calls_before_reject = launches.len();
        let rows_before_reject = crate::db::recent_audit(&app.db).await.unwrap();
        for body in [
            r#"{}"#,
            r#"{"repairType":"tables","extra":true}"#,
            r#""tables""#,
            r#"["tables"]"#,
            r#"{"repairType":"nope"}"#,
            r#"{"repairType":{"scrub":"nope"}}"#,
        ] {
            let rejected = exchange(
                &app,
                request(
                    "POST",
                    "/api/nodes/n1/repair",
                    Some(body),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &rejected,
                StatusCode::BAD_REQUEST,
                "invalid_repair",
                "repairType is required",
            );
        }
        assert_eq!(
            cluster_calls(&mock, "LaunchRepairOperation").len(),
            calls_before_reject
        );
        assert_eq!(
            crate::db::recent_audit(&app.db).await.unwrap().len(),
            rows_before_reject.len()
        );

        let viewer = viewer_session(&app, &admin).await;
        let rows_before_viewer = crate::db::recent_audit(&app.db).await.unwrap();
        let denied = exchange(
            &app,
            with_confirm(request(
                "POST",
                "/api/nodes/n1/repair",
                Some(r#"{"repairType":"tables"}"#),
                Some(&viewer),
            )),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            cluster_calls(&mock, "LaunchRepairOperation").len(),
            calls_before_reject
        );
        assert_eq!(
            crate::db::recent_audit(&app.db).await.unwrap().len(),
            rows_before_viewer.len()
        );
    }

    #[tokio::test]
    async fn inspect_object_returns_the_garage_body() {
        let body = r#"{ "blocks" : 2 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/a%26b%3Dc/inspect/photos/a%3Db",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "InspectObject"),
            "/v2/InspectObject?bucketId=a%26b%3Dc&key=photos%2Fa%3Db",
        );
    }

    #[tokio::test]
    async fn viewer_cannot_inspect_an_object() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{ "blocks" : 2 }"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/a%26b%3Dc/inspect/photos/a%3Db",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(mock.hits(), 0);
        let bare = crate::util::temp_dir();
        let garage_less = state::test_app(&bare).await;
        let anonymous = exchange(
            &garage_less,
            request(
                "GET",
                "/api/buckets/a%26b%3Dc/inspect/photos/a%3Db",
                None,
                None,
            ),
        )
        .await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
    }

    #[derive(Clone)]
    struct CapturedCall {
        line: String,
        body: Vec<u8>,
    }

    struct ConnectCapture {
        url: String,
        calls: Arc<Mutex<Vec<CapturedCall>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for ConnectCapture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl ConnectCapture {
        async fn start(reply: &'static [u8]) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let calls = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&calls);
            let reply = reply.to_vec();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let recorded = Arc::clone(&recorded);
                    let reply = reply.clone();
                    tokio::spawn(async move {
                        let Ok((line, body)) = read_upstream(&mut socket).await else {
                            return;
                        };
                        recorded.lock().expect("calls").push(CapturedCall {
                            line: line.clone(),
                            body: body.into_bytes(),
                        });
                        let body = if line.contains("/v2/GetNodeInfo?") {
                            br#"{"garageVersion":"v2.3.0"}"#.to_vec()
                        } else {
                            reply
                        };
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let mut response = header.into_bytes();
                        response.extend_from_slice(&body);
                        let _ = socket.write_all(&response).await;
                        let _ = socket.shutdown().await;
                    });
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                calls,
                task,
            }
        }

        fn calls(&self) -> Vec<CapturedCall> {
            self.calls.lock().expect("calls").clone()
        }
    }

    #[tokio::test]
    async fn admin_connect_forwards_the_node_list_unchanged() {
        let upstream = br#"[ "joined" , "abcd@127.0.0.1:3901" ]"#;
        let capture = ConnectCapture::start(upstream).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &capture.url).await;
        let (admin, _) = login(&app).await;
        let sent = r#"["abcd@127.0.0.1:3901"]"#;
        let response = exchange(
            &app,
            request("POST", "/api/cluster/connect", Some(sent), Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body.as_bytes(), upstream);
        let connects: Vec<_> = capture
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("ConnectClusterNodes"))
            .collect();
        assert_eq!(connects.len(), 1);
        let target = connects[0].line.split_whitespace().nth(1).unwrap_or("");
        assert_eq!(target, "/v2/ConnectClusterNodes", "{}", connects[0].line);
        assert!(
            connects[0].line.starts_with("POST "),
            "{}",
            connects[0].line
        );
        assert_eq!(connects[0].body, sent.as_bytes());
    }

    #[tokio::test]
    async fn viewer_connect_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"["joined"]"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/cluster/connect",
                Some(r#"["abcd@127.0.0.1:3901"]"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn connect_denial_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let sent = r#"["abcd@127.0.0.1:3901"]"#;
        let response = exchange(
            &app,
            request("POST", "/api/cluster/connect", Some(sent), Some(&viewer)),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/cluster/connect");
        assert_eq!(row.target, sent);
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn connect_requires_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let anonymous = exchange(
            &app,
            request(
                "POST",
                "/api/cluster/connect",
                Some(r#"["abcd@127.0.0.1:3901"]"#),
                None,
            ),
        )
        .await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/cluster/connect",
                Some(r#"["abcd@127.0.0.1:3901"]"#),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not configured",
        );
    }

    #[tokio::test]
    async fn old_garage_blocks_cluster_connect() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/cluster/connect",
                Some(r#"["abcd@127.0.0.1:3901"]"#),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::CONFLICT,
            "garage_too_old",
            "Garage v2.3.0 or newer is required",
        );
        assert!(
            mock.requests()
                .iter()
                .all(|line| !line.contains("ConnectClusterNodes"))
        );
    }

    #[tokio::test]
    async fn layout_stage_keeps_original_capacity_bytes() {
        let status = r#"{"layoutVersion":4,"nodes":[{"id":"keep-node","isUp":true,"draining":false,"role":{"zone":"dc1","capacity":1800000000000,"tags":["fast"]},"dataPartition":{"avail":7}},{"id":"edit-node","isUp":true,"draining":false,"role":{"zone":"dc2","capacity":2000000000000,"tags":["slow"]},"dataPartition":{"avail":1800000000000}}]}"#;
        let mock = Upstream::start(UpstreamReply::Ok(status.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let unchanged = exchange(
            &app,
            request(
                "POST",
                "/api/layout/stage",
                Some(r#"{"id":"keep-node","capacity":"1800000000000"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(unchanged.status, StatusCode::OK, "{}", unchanged.body);
        assert_eq!(unchanged.body, r#"{"updated":0}"#);
        assert!(
            mock.calls()
                .iter()
                .all(|call| !call.line.contains("UpdateClusterLayout")),
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        let changed = exchange(
            &app,
            request(
                "POST",
                "/api/layout/stage",
                Some(r#"{"id":"edit-node","capacity":"1900000000000"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
        let updates = cluster_calls(&mock, "UpdateClusterLayout");
        assert_eq!(
            updates.len(),
            1,
            "{:?}",
            updates.iter().map(|call| call.line.clone()).collect::<Vec<_>>()
        );
        let body = &updates[0].body;
        assert!(body.contains("1900000000000"), "{body}");
        assert!(body.contains("edit-node"), "{body}");
        assert!(!body.contains("1800000000000"), "{body}");
        assert!(!body.contains("keep-node"), "{body}");
    }

    struct InfoSocket {
        url: String,
        hits: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for InfoSocket {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl InfoSocket {
        async fn start(info_status: u16) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let hits = Arc::new(AtomicUsize::new(0));
            let hits_task = Arc::clone(&hits);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        break;
                    };
                    hits_task.fetch_add(1, Ordering::SeqCst);
                    let _ = answer_info(socket, info_status).await;
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                hits,
                task,
            }
        }

        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }
    }

    async fn answer_info(
        mut socket: tokio::net::TcpStream,
        info_status: u16,
    ) -> std::io::Result<()> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..read]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() > 65536 {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf);
        let line = text.lines().next().unwrap_or("");
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let path = target.split('?').next().unwrap_or("");
        let (status, body) = info_reply(path, info_status);
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await?;
        let _ = socket.shutdown().await;
        Ok(())
    }

    fn info_reply(path: &str, info_status: u16) -> (&'static str, String) {
        if path.ends_with("ListBucketsInfo") || path.ends_with("ListKeysInfo") {
            if info_status == 404 {
                return ("404 Not Found", r#"{"error":"missing"}"#.to_string());
            }
            return ("200 OK", r#"[{"id":"item-1"}]"#.to_string());
        }
        if path.ends_with("ListBuckets") || path.ends_with("ListKeys") {
            return ("200 OK", r#"[{"id":"item-1"}]"#.to_string());
        }
        if path.ends_with("GetBucketInfo") || path.ends_with("GetKeyInfo") {
            return ("200 OK", r#"{"id":"item-1"}"#.to_string());
        }
        ("404 Not Found", r#"{"error":"missing"}"#.to_string())
    }

    fn capability_body(version: &Value, buckets: &str, keys: &str) -> Value {
        json!({
            "version": version,
            "listBucketsInfo": buckets,
            "listKeysInfo": keys,
        })
    }

    #[tokio::test]
    async fn capabilities_are_unknown_before_any_list_and_a_viewer_can_read_them() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_task = Arc::clone(&hits);
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                hits_task.fetch_add(1, Ordering::SeqCst);
                drop(socket);
            }
        });
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &format!("http://127.0.0.1:{port}")).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let missing = exchange(&app, request("GET", "/api/capabilities", None, None)).await;
        assert_error(
            &missing,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
        let health = exchange(&app, request("GET", "/healthz", None, None)).await;
        assert_eq!(health.status, StatusCode::OK, "{}", health.body);
        let health_body: Value = serde_json::from_str(&health.body).unwrap();
        let response = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&viewer)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            capability_body(&health_body["version"], "unknown", "unknown")
        );
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        let bare = crate::util::temp_dir();
        let plain = state::test_app(&bare).await;
        let (plain_admin, _) = login(&plain).await;
        let plain_caps = exchange(
            &plain,
            request("GET", "/api/capabilities", None, Some(&plain_admin)),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&plain_caps.body).unwrap(),
            capability_body(&health_body["version"], "unknown", "unknown")
        );
        task.abort();
    }

    #[tokio::test]
    async fn capabilities_follow_info_404_and_info_200() {
        let absent = InfoSocket::start(404).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &absent.url).await;
        let (admin, _) = login(&app).await;
        let health = exchange(&app, request("GET", "/healthz", None, None)).await;
        let health_body: Value = serde_json::from_str(&health.body).unwrap();
        let before = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&admin)),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&before.body).unwrap(),
            capability_body(&health_body["version"], "unknown", "unknown")
        );
        assert_eq!(absent.hits(), 0);
        let buckets = exchange(
            &app,
            request("GET", "/api/buckets?limit=1", None, Some(&admin)),
        )
        .await;
        assert_eq!(buckets.status, StatusCode::OK, "{}", buckets.body);
        let after_buckets = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&admin)),
        )
        .await;
        let after_buckets_hits = absent.hits();
        assert_eq!(
            serde_json::from_str::<Value>(&after_buckets.body).unwrap(),
            capability_body(&health_body["version"], "absent", "unknown")
        );
        let again = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&admin)),
        )
        .await;
        assert_eq!(again.body, after_buckets.body);
        assert_eq!(absent.hits(), after_buckets_hits);
        let keys = exchange(
            &app,
            request("GET", "/api/keys?limit=1", None, Some(&admin)),
        )
        .await;
        assert_eq!(keys.status, StatusCode::OK, "{}", keys.body);
        let after_keys = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&admin)),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&after_keys.body).unwrap(),
            capability_body(&health_body["version"], "absent", "absent")
        );

        let present = InfoSocket::start(200).await;
        let other = crate::util::temp_dir();
        let app2 = app_for(&other, &present.url).await;
        let (admin2, _) = login(&app2).await;
        let listed = exchange(
            &app2,
            request("GET", "/api/buckets?limit=1", None, Some(&admin2)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let shown = exchange(
            &app2,
            request("GET", "/api/capabilities", None, Some(&admin2)),
        )
        .await;
        let shown_hits = present.hits();
        assert_eq!(
            serde_json::from_str::<Value>(&shown.body).unwrap(),
            capability_body(&health_body["version"], "present", "unknown")
        );
        let shown_again = exchange(
            &app2,
            request("GET", "/api/capabilities", None, Some(&admin2)),
        )
        .await;
        assert_eq!(shown_again.body, shown.body);
        assert_eq!(present.hits(), shown_hits);
        let listed_keys = exchange(
            &app2,
            request("GET", "/api/keys?limit=1", None, Some(&admin2)),
        )
        .await;
        assert_eq!(listed_keys.status, StatusCode::OK, "{}", listed_keys.body);
        let both = exchange(
            &app2,
            request("GET", "/api/capabilities", None, Some(&admin2)),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&both.body).unwrap(),
            capability_body(&health_body["version"], "present", "present")
        );
    }

    #[tokio::test]
    async fn connection_failure_leaves_capabilities_unknown() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_task = Arc::clone(&hits);
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                hits_task.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0_u8; 1024];
                let _ = socket.read(&mut buf).await;
                let _ = socket.shutdown().await;
            }
        });
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &format!("http://127.0.0.1:{port}")).await;
        let (admin, _) = login(&app).await;
        let failed = exchange(
            &app,
            request("GET", "/api/buckets?limit=1", None, Some(&admin)),
        )
        .await;
        assert_error(
            &failed,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not reachable",
        );
        let tried = hits.load(Ordering::SeqCst);
        assert!(tried > 0, "the list did not reach the upstream");
        let health = exchange(&app, request("GET", "/healthz", None, None)).await;
        let health_body: Value = serde_json::from_str(&health.body).unwrap();
        let response = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&admin)),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            capability_body(&health_body["version"], "unknown", "unknown")
        );
        assert_eq!(hits.load(Ordering::SeqCst), tried);
        task.abort();
    }

    struct PartHold {
        released: AtomicBool,
        notify: tokio::sync::Notify,
    }

    struct GetHold {
        key: String,
        release: AtomicBool,
        early: AtomicBool,
        notify: tokio::sync::Notify,
    }

    struct S3Mock {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        content_types: Arc<Mutex<Vec<Option<String>>>>,
        bodies: Arc<Mutex<Vec<String>>>,
        hold: Option<Arc<PartHold>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for S3Mock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl S3Mock {
        async fn start(reply: impl Fn(&str) -> String + Send + Sync + 'static) -> Self {
            Self::serve(reply, None, None).await
        }

        async fn start_holding_parts(
            reply: impl Fn(&str) -> String + Send + Sync + 'static,
        ) -> Self {
            let hold = Arc::new(PartHold {
                released: AtomicBool::new(false),
                notify: tokio::sync::Notify::new(),
            });
            Self::serve(reply, Some(hold), None).await
        }

        async fn start_holding_get(
            reply: impl Fn(&str) -> String + Send + Sync + 'static,
            hold: Arc<GetHold>,
        ) -> Self {
            Self::serve(reply, None, Some(hold)).await
        }

        fn release_parts(&self) {
            let Some(hold) = &self.hold else {
                return;
            };
            hold.released.store(true, Ordering::SeqCst);
            hold.notify.notify_waiters();
        }

        async fn serve(
            reply: impl Fn(&str) -> String + Send + Sync + 'static,
            hold: Option<Arc<PartHold>>,
            get_hold: Option<Arc<GetHold>>,
        ) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let content_types = Arc::new(Mutex::new(Vec::new()));
            let bodies = Arc::new(Mutex::new(Vec::new()));
            let requests_task = Arc::clone(&requests);
            let content_types_task = Arc::clone(&content_types);
            let bodies_task = Arc::clone(&bodies);
            let reply = Arc::new(reply);
            let hold_task = hold.clone();
            let get_hold_task = get_hold.clone();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let requests_task = Arc::clone(&requests_task);
                    let content_types_task = Arc::clone(&content_types_task);
                    let bodies_task = Arc::clone(&bodies_task);
                    let reply = Arc::clone(&reply);
                    let hold = hold_task.clone();
                    let get_hold = get_hold_task.clone();
                    tokio::spawn(async move {
                        let mut buf = Vec::new();
                        let mut tmp = [0_u8; 4096];
                        let header_end = loop {
                            let Ok(Ok(read)) =
                                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut tmp))
                                    .await
                            else {
                                return;
                            };
                            if read == 0 {
                                return;
                            }
                            buf.extend_from_slice(&tmp[..read]);
                            if let Some(pos) =
                                buf.windows(4).position(|window| window == b"\r\n\r\n")
                            {
                                break pos;
                            }
                            if buf.len() > 64 * 1024 {
                                return;
                            }
                        };
                        let text = String::from_utf8_lossy(&buf[..header_end]);
                        let line = text.lines().next().unwrap_or("").to_string();
                        let content_type = header_value(&text, "content-type").map(str::to_string);
                        let length = header_value(&text, "content-length")
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(0);
                        let mut body = buf[header_end + 4..].to_vec();
                        while body.len() < length {
                            let Ok(Ok(read)) =
                                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut tmp))
                                    .await
                            else {
                                return;
                            };
                            if read == 0 {
                                break;
                            }
                            body.extend_from_slice(&tmp[..read]);
                        }
                        body.truncate(length);
                        requests_task
                            .lock()
                            .expect("s3 requests")
                            .push(line.clone());
                        content_types_task
                            .lock()
                            .expect("s3 content types")
                            .push(content_type);
                        bodies_task
                            .lock()
                            .expect("s3 bodies")
                            .push(String::from_utf8_lossy(&body).into_owned());
                        if s3_operation(&line) == "part"
                            && let Some(hold) = &hold
                            && !part_reply_ready(hold).await
                        {
                            let _ = socket
                                .write_all(
                                    b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                )
                                .await;
                            let _ = socket.shutdown().await;
                            return;
                        }
                        // The socket read above uses this same two-second bound. Giving up still sends the object.
                        if line.starts_with("GET ")
                            && let Some(hold) = &get_hold
                            && object_key_of(&line) == hold.key
                            && !get_reply_ready(hold).await
                        {
                            hold.early.store(true, Ordering::SeqCst);
                        }
                        let response = reply(&line);
                        let _ = socket.write_all(response.as_bytes()).await;
                        let _ = socket.shutdown().await;
                    });
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                requests,
                content_types,
                bodies,
                hold,
                task,
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("s3 requests").clone()
        }

        fn content_types(&self) -> Vec<Option<String>> {
            self.content_types.lock().expect("s3 content types").clone()
        }

        fn bodies(&self) -> Vec<String> {
            self.bodies.lock().expect("s3 bodies").clone()
        }
    }

    async fn part_reply_ready(hold: &PartHold) -> bool {
        let notified = hold.notify.notified();
        hold.released.load(Ordering::SeqCst)
            || tokio::time::timeout(Duration::from_secs(20), notified)
                .await
                .is_ok()
            || hold.released.load(Ordering::SeqCst)
    }

    async fn get_reply_ready(hold: &GetHold) -> bool {
        let notified = hold.notify.notified();
        hold.release.load(Ordering::SeqCst)
            || tokio::time::timeout(Duration::from_secs(2), notified)
                .await
                .is_ok()
            || hold.release.load(Ordering::SeqCst)
    }

    async fn object_app(dir: &std::path::Path, endpoint: &str, with_key: bool) -> App {
        if with_key {
            state::test_app_with(
                dir,
                &[
                    ("S3_ENDPOINT_URL", endpoint),
                    ("S3_REGION", "garage"),
                    ("S3_ACCESS_KEY_ID", "PROJECT"),
                    ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
                ],
                test_quota(),
            )
            .await
        } else {
            state::test_app_with(
                dir,
                &[("S3_ENDPOINT_URL", endpoint), ("S3_REGION", "garage")],
                test_quota(),
            )
            .await
        }
    }

    fn http_xml(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn list_xml(
        truncated: bool,
        token: Option<&str>,
        objects: &[(&str, i64, &str)],
        prefixes: &[&str],
    ) -> String {
        let mut xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">"#,
        );
        xml.push_str(&format!(
            "<KeyCount>{}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>{}</IsTruncated>",
            objects.len() + prefixes.len(),
            if truncated { "true" } else { "false" }
        ));
        if let Some(token) = token {
            xml.push_str(&format!(
                "<NextContinuationToken>{token}</NextContinuationToken>"
            ));
        }
        for (key, size, etag) in objects {
            xml.push_str(&format!(
                "<Contents><Key>{key}</Key><LastModified>2026-10-11T00:00:00.000Z</LastModified><ETag>\"{etag}\"</ETag><Size>{size}</Size><StorageClass>STANDARD</StorageClass></Contents>"
            ));
        }
        for prefix in prefixes {
            xml.push_str(&format!(
                "<CommonPrefixes><Prefix>{prefix}</Prefix></CommonPrefixes>"
            ));
        }
        xml.push_str("</ListBucketResult>");
        http_xml(&xml)
    }

    fn head_ok() -> String {
        "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nETag: \"abc\"\r\nLast-Modified: Sun, 11 Oct 2026 00:00:00 GMT\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n"
            .to_string()
    }

    fn head_missing() -> String {
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nContent-Type: application/xml\r\nConnection: close\r\n\r\n"
            .to_string()
    }

    fn request_target(line: &str) -> &str {
        line.split_whitespace().nth(1).unwrap_or("")
    }

    fn percent_decode(value: &str) -> String {
        let bytes = value.as_bytes();
        let mut out = Vec::new();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%' && index + 2 < bytes.len() {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    index += 3;
                    continue;
                }
            }
            out.push(bytes[index]);
            index += 1;
        }
        String::from_utf8(out).expect("decoded path")
    }

    fn encode_key(key: &str) -> String {
        const PLAIN: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/";
        let mut out = String::new();
        for byte in key.as_bytes() {
            if PLAIN.contains(byte) {
                out.push(char::from(*byte));
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    }

    fn bucket_of(line: &str) -> String {
        let path = request_target(line).split('?').next().unwrap_or("");
        let trimmed = path.trim_start_matches('/');
        percent_decode(trimmed.split('/').next().unwrap_or(""))
    }

    fn object_key_of(line: &str) -> String {
        let path = request_target(line).split('?').next().unwrap_or("");
        let trimmed = path.trim_start_matches('/');
        let Some((_, key)) = trimmed.split_once('/') else {
            return String::new();
        };
        percent_decode(key)
    }

    fn header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
        headers.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    fn put_ok(etag: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nETag: \"{etag}\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    fn put_bytes(
        uri: &str,
        body: &[u8],
        content_length: Option<&str>,
        session: &Session,
    ) -> Request<Body> {
        let mut builder = Request::builder()
            .method("PUT")
            .uri(uri)
            .header("cookie", cookie_header(session))
            .header("x-csrf-token", &session.csrf);
        if let Some(length) = content_length {
            builder = builder.header("content-length", length);
        }
        builder.body(Body::from(body.to_vec())).unwrap()
    }

    fn node_info_hits(mock: &GarageMock) -> usize {
        mock.requests()
            .iter()
            .filter(|line| line.contains("/v2/GetNodeInfo?"))
            .count()
    }

    #[tokio::test]
    async fn startup_config_configured_endpoint_beats_connection_parameters() {
        let kept =
            S3Mock::start(|_line| list_xml(false, None, &[("kept.txt", 1, "abc")], &[])).await;
        let other =
            S3Mock::start(|_line| list_xml(false, None, &[("stolen.txt", 1, "def")], &[])).await;
        let node = format!(
            r#"{{"garageVersion":"v2.4.1","connectionParameters":{{"s3Endpoint":"{}","s3Region":"from-node"}}}}"#,
            other.url
        );
        let admin = GarageMock::start(&node).await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", admin.url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("S3_ENDPOINT_URL", kept.url.as_str()),
                ("S3_REGION", "eu-kept"),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
            ],
            test_quota(),
        )
        .await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(response.body.contains("kept.txt"), "{}", response.body);
        assert!(!response.body.contains("stolen.txt"), "{}", response.body);
        assert!(!kept.requests().is_empty());
        assert!(other.requests().is_empty(), "{:?}", other.requests());
        assert_eq!(admin.hits(), 0);
        assert_eq!(node_info_hits(&admin), 0);
    }

    #[tokio::test]
    async fn startup_config_missing_endpoint_comes_from_node_info() {
        let s3 =
            S3Mock::start(|_line| list_xml(false, None, &[("from-node.txt", 2, "abc")], &[])).await;
        let node = format!(
            r#"{{"success":{{"node-a":{{"garageVersion":"v2.4.1","connectionParameters":{{"s3Endpoint":"{}","s3Region":"garage"}}}}}}}}"#,
            s3.url
        );
        let admin = GarageMock::start(&node).await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", admin.url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
            ],
            test_quota(),
        )
        .await;
        let (session, _) = login(&app).await;
        let first = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(first.status, StatusCode::OK, "{}", first.body);
        assert!(first.body.contains("from-node.txt"), "{}", first.body);
        let second = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(second.status, StatusCode::OK, "{}", second.body);
        assert!(!s3.requests().is_empty());
        assert_eq!(node_info_hits(&admin), 1, "{:?}", admin.requests());
    }

    #[tokio::test]
    async fn object_list_pages_and_clamps_max_keys() {
        let mock = S3Mock::start(|line| {
            let target = request_target(line);
            if query_value(target, "continuation-token") == Some("page-2") {
                return list_xml(false, None, &[("photos/b.txt", 4, "def")], &[]);
            }
            if query_value(target, "max-keys") == Some("1000") {
                return list_xml(false, None, &[], &[]);
            }
            list_xml(
                true,
                Some("page-2"),
                &[("photos/a.txt", 12, "abc")],
                &["photos/"],
            )
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;

        let first = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(first.status, StatusCode::OK, "{}", first.body);
        assert_eq!(
            serde_json::from_str::<Value>(&first.body).unwrap(),
            json!({
                "prefix": "",
                "entries": [
                    {"kind": "prefix", "prefix": "photos/"},
                    {"kind": "object", "key": "photos/a.txt", "size": 12, "etag": "abc", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "next": "page-2"
            })
        );
        let seen = mock.requests();
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(
            query_value(request_target(&seen[0]), "max-keys"),
            Some("100")
        );
        assert!(
            request_target(&seen[0]).contains("delimiter=%2F")
                || request_target(&seen[0]).contains("delimiter=/")
        );

        let second = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects?next=page-2",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&second.body).unwrap(),
            json!({
                "prefix": "",
                "entries": [
                    {"kind": "object", "key": "photos/b.txt", "size": 4, "etag": "def", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "next": null
            })
        );
        let seen = mock.requests();
        assert_eq!(
            query_value(request_target(&seen[1]), "continuation-token"),
            Some("page-2")
        );
        assert_eq!(bucket_of(&seen[1]), "bkt-1");

        let clamped = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects?limit=5000",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(clamped.status, StatusCode::OK, "{}", clamped.body);
        let seen = mock.requests();
        assert_eq!(
            query_value(request_target(&seen[2]), "max-keys"),
            Some("1000")
        );
        assert_eq!(bucket_of(&seen[2]), "bkt-1");
    }

    #[tokio::test]
    async fn object_list_walks_5000_objects_page_by_page() {
        let pages: Vec<Vec<String>> = (0..5)
            .map(|page| {
                (0..1000)
                    .map(|index| format!("k{:04}", page * 1000 + index))
                    .collect()
            })
            .collect();
        let mock = S3Mock::start(move |line| {
            let token = query_value(request_target(line), "continuation-token");
            let index = match token {
                None => 0,
                Some("t2") => 1,
                Some("t3") => 2,
                Some("t4") => 3,
                Some("t5") => 4,
                other => panic!("unexpected continuation token {other:?}"),
            };
            let next = match index {
                0 => Some("t2"),
                1 => Some("t3"),
                2 => Some("t4"),
                3 => Some("t5"),
                _ => None,
            };
            list_page_xml(&pages[index], next)
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;

        let mut path = "/api/buckets/bkt-1/objects?limit=1000".to_string();
        let mut total = 0;
        let mut page_count = 0;
        loop {
            let response = exchange(&app, request("GET", &path, None, Some(&session))).await;
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            let body: Value = serde_json::from_str(&response.body).unwrap();
            let entries = body["entries"].as_array().expect("entries");
            let objects = entries
                .iter()
                .filter(|entry| entry["kind"] == "object")
                .count();
            assert_eq!(objects, 1000, "{}", response.body);
            total += objects;
            page_count += 1;
            assert!(page_count <= 5, "{}", response.body);
            if page_count == 1 {
                assert_eq!(entries[0]["key"], "k0000");
            }
            match body["next"].as_str() {
                None => {
                    assert_eq!(entries[999]["key"], "k4999");
                    break;
                }
                Some(token) => {
                    path = format!("/api/buckets/bkt-1/objects?limit=1000&next={token}");
                }
            }
        }
        assert_eq!(total, 5000);
        assert_eq!(page_count, 5);

        let seen = mock.requests();
        assert_eq!(seen.len(), 5, "{seen:?}");
        let tokens = [None, Some("t2"), Some("t3"), Some("t4"), Some("t5")];
        for (line, token) in seen.iter().zip(tokens) {
            let target = request_target(line);
            assert_eq!(query_value(target, "max-keys"), Some("1000"), "{target}");
            assert_eq!(query_value(target, "continuation-token"), token, "{target}");
            assert_eq!(bucket_of(line), "bkt-1");
        }
    }

    #[tokio::test]
    async fn object_list_without_a_project_key_does_not_call_s3() {
        let mock = S3Mock::start(|_| head_missing()).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, false).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PRECONDITION_FAILED,
            "no_usable_key",
            "This bucket has no usable read-write key",
        );
        assert!(mock.requests().is_empty());
    }

    fn s3_denied() -> String {
        let body = r#"<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>denied by policy</Message></Error>"#;
        format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn object_list_retries_once_when_s3_returns_403() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        let mock = S3Mock::start(move |line| {
            assert!(request_target(line).contains("list-type=2"), "{line}");
            let call = counted.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                s3_denied()
            } else {
                list_xml(false, None, &[("a.txt", 3, "abc")], &[])
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({
                "prefix": "",
                "entries": [
                    {"kind": "object", "key": "a.txt", "size": 3, "etag": "abc", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "next": null
            })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        for line in &seen {
            assert_eq!(bucket_of(line), "bkt-1");
            assert!(request_target(line).contains("list-type=2"), "{line}");
        }
    }

    #[tokio::test]
    async fn object_list_stays_403_when_s3_denies_twice() {
        let mock = S3Mock::start(|line| {
            assert!(request_target(line).contains("list-type=2"), "{line}");
            s3_denied()
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(response.status, StatusCode::FORBIDDEN, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "code": "s3_error", "message": "service error" })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        for line in &seen {
            assert_eq!(bucket_of(line), "bkt-1");
            assert!(request_target(line).contains("list-type=2"), "{line}");
        }
    }

    #[tokio::test]
    async fn object_put_returns_key_etag_and_size() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("PUT "), "{line}");
            put_ok("abc123")
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let body = b"hello";
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                body,
                Some("5"),
                &session,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::CREATED, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "abc123", "size": 5 })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("PUT "), "{}", seen[0]);
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(object_key_of(&seen[0]), "photos/a.txt");
        assert_eq!(mock.content_types(), vec![None]);
    }

    #[tokio::test]
    async fn object_put_forwards_text_plain_and_omits_an_empty_type() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("PUT "), "{line}");
            put_ok("abc123")
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let uri = "/api/buckets/bkt-1/objects/photos/a.txt";
        let mut typed = put_bytes(uri, b"hello", Some("5"), &session);
        typed
            .headers_mut()
            .insert("content-type", HeaderValue::from_static("text/plain"));
        let typed_response = exchange(&app, typed).await;
        assert_eq!(
            typed_response.status,
            StatusCode::CREATED,
            "{}",
            typed_response.body
        );
        assert_eq!(
            serde_json::from_str::<Value>(&typed_response.body).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "abc123", "size": 5 })
        );
        let mut empty = put_bytes(uri, b"hello", Some("5"), &session);
        empty
            .headers_mut()
            .insert("content-type", HeaderValue::from_static(""));
        let empty_response = exchange(&app, empty).await;
        assert_eq!(
            empty_response.status,
            StatusCode::CREATED,
            "{}",
            empty_response.body
        );
        assert_eq!(
            serde_json::from_str::<Value>(&empty_response.body).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "abc123", "size": 5 })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        for line in &seen {
            assert!(line.starts_with("PUT "), "{line}");
            assert_eq!(bucket_of(line), "bkt-1");
            assert_eq!(object_key_of(line), "photos/a.txt");
        }
        assert_eq!(
            mock.bodies(),
            vec!["hello".to_string(), "hello".to_string()]
        );
        assert_eq!(
            mock.content_types(),
            vec![Some("text/plain".to_string()), None]
        );
    }

    #[tokio::test]
    async fn object_put_rejects_bad_length_without_calling_s3() {
        let mock = S3Mock::start(|_| put_ok("abc")).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let uri = "/api/buckets/bkt-1/objects/photos/a.txt";
        let missing = exchange(&app, put_bytes(uri, b"hello", None, &session)).await;
        assert_error(
            &missing,
            StatusCode::BAD_REQUEST,
            "length_required",
            "Content-Length is required",
        );
        let invalid = exchange(&app, put_bytes(uri, b"hello", Some("nope"), &session)).await;
        assert_error(
            &invalid,
            StatusCode::BAD_REQUEST,
            "length_required",
            "Content-Length is required",
        );
        let too_big = exchange(&app, put_bytes(uri, b"hello", Some("9999999999"), &session)).await;
        assert_error(
            &too_big,
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Upload is too large",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_put_without_a_project_key_does_not_call_s3() {
        let mock = S3Mock::start(|_| put_ok("abc")).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, false).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                b"hello",
                Some("5"),
                &session,
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PRECONDITION_FAILED,
            "no_usable_key",
            "This bucket has no usable read-write key",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_put_without_an_endpoint_is_unavailable() {
        let mock = S3Mock::start(|_| put_ok("abc")).await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("S3_REGION", "garage"),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
            ],
            test_quota(),
        )
        .await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                b"hello",
                Some("5"),
                &session,
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage is unavailable",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_put_retries_once_when_s3_returns_403() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        let mock = S3Mock::start(move |line| {
            assert!(line.starts_with("PUT "), "{line}");
            let call = counted.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                s3_denied()
            } else {
                put_ok("abc123")
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                b"hello",
                Some("5"),
                &session,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::CREATED, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "abc123", "size": 5 })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        for line in &seen {
            assert!(line.starts_with("PUT "), "{line}");
            assert_eq!(bucket_of(line), "bkt-1");
            assert_eq!(object_key_of(line), "photos/a.txt");
        }
    }

    #[tokio::test]
    async fn failed_upload_leaves_no_spool_file() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("PUT "), "{line}");
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string()
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/note.txt",
                b"note",
                Some("4"),
                &session,
            ),
        )
        .await;
        assert_ne!(response.status, StatusCode::CREATED);
        let seen = mock.requests();
        assert!(
            seen.iter().any(|line| line.starts_with("PUT ")),
            "mock saw no PUT"
        );
        let mut leftovers = Vec::new();
        let mut pending = vec![dir.clone()];
        while let Some(current) = pending.pop() {
            for entry in std::fs::read_dir(&current).expect("read data dir") {
                let entry = entry.expect("data dir entry");
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with(".put-") {
                    leftovers.push(name.into_owned());
                }
                if path.is_dir() {
                    pending.push(path);
                }
            }
        }
        assert!(leftovers.is_empty(), "spool files remain: {leftovers:?}");
    }

    fn s3_operation(line: &str) -> &'static str {
        let target = request_target(line);
        if line.starts_with("POST ") && target.contains("uploads") {
            "create"
        } else if line.starts_with("PUT ") && query_value(target, "partNumber").is_some() {
            "part"
        } else if line.starts_with("POST ") && query_value(target, "uploadId").is_some() {
            "complete"
        } else if line.starts_with("DELETE ") && query_value(target, "uploadId").is_some() {
            "abort"
        } else if line.starts_with("PUT ") {
            "put"
        } else {
            "other"
        }
    }

    fn initiate_xml() -> String {
        http_xml(
            r#"<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>bkt-1</Bucket><Key>photos/a.txt</Key><UploadId>up-1</UploadId></InitiateMultipartUploadResult>"#,
        )
    }

    fn complete_xml() -> String {
        http_xml(
            r#"<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>bkt-1</Bucket><Key>photos/a.txt</Key><ETag>"final-etag"</ETag></CompleteMultipartUploadResult>"#,
        )
    }

    fn multipart_reply(line: &str) -> String {
        match s3_operation(line) {
            "create" => initiate_xml(),
            "part" => {
                let number = query_value(request_target(line), "partNumber").unwrap_or("0");
                put_ok(&format!("part-{number}"))
            }
            "complete" => complete_xml(),
            "abort" => delete_ok(),
            _ => put_ok("single-etag"),
        }
    }

    async fn decided_put(
        app: &App,
        body: &[u8],
        size: u64,
        content_type: Option<&str>,
        threshold: u64,
        part_bytes: u64,
    ) -> Result<(StatusCode, objects::PutResult), ApiError> {
        let (status, stored) = super::put_object(
            app,
            "bkt-1",
            "photos/a.txt",
            size,
            content_type.map(str::to_string),
            Body::from(body.to_vec()),
            objects::PartPlan {
                threshold,
                part_bytes,
            },
        )
        .await?;
        Ok((status, stored.0))
    }

    #[tokio::test]
    async fn object_put_above_threshold_completes_multipart() {
        let mock = S3Mock::start(multipart_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (status, stored) = decided_put(&app, b"abcde", 5, Some("text/plain"), 2, 2)
            .await
            .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(
            serde_json::to_value(&stored).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "final-etag", "size": 5 })
        );
        let seen = mock.requests();
        let ops: Vec<_> = seen.iter().map(|line| s3_operation(line)).collect();
        assert_eq!(ops.first().copied(), Some("create"), "{seen:?}");
        assert_eq!(ops.last().copied(), Some("complete"), "{seen:?}");
        assert_eq!(ops.iter().filter(|op| **op == "part").count(), 3, "{ops:?}");
        assert!(ops.iter().all(|op| *op != "put"), "{ops:?}");
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(object_key_of(&seen[0]), "photos/a.txt");
        assert_eq!(mock.content_types()[0], Some("text/plain".to_string()));
        let mut part_bodies = std::collections::BTreeMap::new();
        let mut complete_body = String::new();
        for (line, body) in seen.iter().zip(mock.bodies()) {
            match s3_operation(line) {
                "part" => {
                    let number = query_value(request_target(line), "partNumber").unwrap();
                    part_bodies.insert(number.to_string(), body);
                }
                "complete" => complete_body = body,
                _ => {}
            }
        }
        assert_eq!(part_bodies.get("1").map(String::as_str), Some("ab"));
        assert_eq!(part_bodies.get("2").map(String::as_str), Some("cd"));
        assert_eq!(part_bodies.get("3").map(String::as_str), Some("e"));
        assert!(complete_body.contains("part-1"), "{complete_body}");
        assert!(complete_body.contains("part-2"), "{complete_body}");
        assert!(complete_body.contains("part-3"), "{complete_body}");
        assert!(
            complete_body.contains("<PartNumber>1</PartNumber>"),
            "{complete_body}"
        );
        assert!(
            complete_body.contains("<PartNumber>3</PartNumber>"),
            "{complete_body}"
        );
    }

    #[tokio::test]
    async fn object_put_aborts_when_a_part_fails() {
        let mock = S3Mock::start(|line| match s3_operation(line) {
            "create" => initiate_xml(),
            "part" => {
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string()
            }
            "abort" => delete_ok(),
            _ => complete_xml(),
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let Err(error) = decided_put(&app, b"abcde", 5, None, 2, 2).await else {
            panic!("part failure returned 201");
        };
        let response = error.into_response();
        assert_ne!(response.status(), StatusCode::CREATED);
        let ops: Vec<_> = mock
            .requests()
            .iter()
            .map(|line| s3_operation(line))
            .collect();
        assert!(ops.contains(&"abort"), "{ops:?}");
        assert!(!ops.contains(&"complete"), "{ops:?}");
        assert!(!ops.contains(&"put"), "{ops:?}");
    }

    #[tokio::test]
    async fn object_put_at_threshold_stays_one_put_object() {
        let mock = S3Mock::start(multipart_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (status, stored) = decided_put(&app, b"hello", 5, None, 5, 2).await.unwrap();
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(
            serde_json::to_value(&stored).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "single-etag", "size": 5 })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert_eq!(s3_operation(&seen[0]), "put");
        let (status, stored) = decided_put(&app, b"hey", 3, None, 5, 2).await.unwrap();
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(stored.size, 3);
        let ops: Vec<_> = mock
            .requests()
            .iter()
            .map(|line| s3_operation(line))
            .collect();
        assert_eq!(ops, vec!["put", "put"]);
    }

    #[tokio::test]
    async fn object_put_aborts_when_the_body_is_short() {
        let mock = S3Mock::start(multipart_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let Err(error) = decided_put(&app, b"ab", 5, None, 2, 2).await else {
            panic!("short body returned 201");
        };
        assert_ne!(error.into_response().status(), StatusCode::CREATED);
        let ops: Vec<_> = mock
            .requests()
            .iter()
            .map(|line| s3_operation(line))
            .collect();
        assert_eq!(ops.first().copied(), Some("create"), "{ops:?}");
        assert!(ops.contains(&"abort"), "{ops:?}");
        assert!(!ops.contains(&"complete"), "{ops:?}");
    }

    fn part_request_count(mock: &S3Mock) -> usize {
        mock.requests()
            .iter()
            .filter(|line| s3_operation(line) == "part")
            .count()
    }

    #[tokio::test]
    async fn object_put_waits_when_the_process_buffer_is_full() {
        let mock = S3Mock::start_holding_parts(multipart_reply).await;
        let dir = crate::util::temp_dir();
        let mut app = object_app(&dir, &mock.url, true).await;
        app.upload_buffer = Arc::new(tokio::sync::Semaphore::new(4));
        let left = app.clone();
        let right = app.clone();
        let first = tokio::spawn(async move {
            super::put_object(
                &left,
                "bkt-1",
                "a.bin",
                8,
                None,
                Body::from(b"abcdefgh".to_vec()),
                objects::PartPlan {
                    threshold: 3,
                    part_bytes: 4,
                },
            )
            .await
        });
        let second = tokio::spawn(async move {
            super::put_object(
                &right,
                "bkt-1",
                "b.bin",
                8,
                None,
                Body::from(b"ijklmnop".to_vec()),
                objects::PartPlan {
                    threshold: 3,
                    part_bytes: 4,
                },
            )
            .await
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if part_request_count(&mock) >= 1 {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no part request: {:?}",
                mock.requests()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(part_request_count(&mock), 1, "{:?}", mock.requests());
        mock.release_parts();
        let (first, second) = tokio::time::timeout(Duration::from_secs(15), async {
            tokio::join!(first, second)
        })
        .await
        .expect("puts finished after release");
        let first = first.expect("a.bin task").expect("a.bin put");
        let second = second.expect("b.bin task").expect("b.bin put");
        assert_eq!(first.0, StatusCode::CREATED);
        assert_eq!(second.0, StatusCode::CREATED);
        assert!(!first.0.is_client_error());
        assert!(!second.0.is_client_error());
        assert_eq!(first.1.0.key, "a.bin");
        assert_eq!(second.1.0.key, "b.bin");
        assert_eq!(first.1.0.size, 8);
        assert_eq!(second.1.0.size, 8);
        assert_eq!(first.1.0.etag, "final-etag");
        assert_eq!(second.1.0.etag, "final-etag");
    }

    fn delete_ok() -> String {
        "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
    }

    #[tokio::test]
    async fn object_delete_returns_204_for_one_key_and_a_missing_key() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("DELETE "), "{line}");
            if object_key_of(line) == "missing" {
                head_missing()
            } else {
                delete_ok()
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let removed = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/photos/a.txt",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
        assert_eq!(removed.body, "");
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("DELETE "), "{}", seen[0]);
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(object_key_of(&seen[0]), "photos/a.txt");

        let missing = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/missing",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(missing.status, StatusCode::NO_CONTENT, "{}", missing.body);
        assert_eq!(missing.body, "");
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!(bucket_of(&seen[1]), "bkt-1");
        assert_eq!(object_key_of(&seen[1]), "missing");
        assert!(seen[1].starts_with("DELETE "), "{}", seen[1]);
    }

    #[tokio::test]
    async fn alias_with_ampersand_and_equals_still_browses_uploads_and_deletes() {
        let admin_body = r#"{"id":"bkt-1","globalAliases":[],"localAliases":[{"accessKeyId":"GK-list","alias":"a&b=c"}]}"#;
        let admin = Upstream::start(UpstreamReply::Ok(admin_body.to_string())).await;
        let s3 = S3Mock::start(|line| {
            if line.starts_with("PUT ") {
                return put_ok("etag-1");
            }
            if line.starts_with("DELETE ") {
                return delete_ok();
            }
            list_xml(false, None, &[("note.txt", 5, "abc")], &[])
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", admin.url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("S3_ENDPOINT_URL", s3.url.as_str()),
                ("S3_REGION", "garage"),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
            ],
            test_quota(),
        )
        .await;
        let (session, _) = login(&app).await;

        let detail = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1", None, Some(&session)),
        )
        .await;
        assert_eq!(detail.status, StatusCode::OK, "{}", detail.body);
        assert_eq!(detail.body, admin_body);
        let details = bucket_info_calls(&admin);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            details
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            details[0]
                .line
                .contains("GET /v2/GetBucketInfo?id=bkt-1 "),
            "{}",
            details[0].line
        );

        let listed = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "prefix": "",
                "entries": [
                    {"kind": "object", "key": "note.txt", "size": 5, "etag": "abc", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "next": null
            })
        );

        let uploaded = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/note.txt",
                b"hello",
                Some("5"),
                &session,
            ),
        )
        .await;
        assert_eq!(uploaded.status, StatusCode::CREATED, "{}", uploaded.body);
        assert_eq!(
            serde_json::from_str::<Value>(&uploaded.body).unwrap(),
            json!({ "key": "note.txt", "etag": "etag-1", "size": 5 })
        );

        let removed = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/note.txt",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
        assert_eq!(removed.body, "");

        let seen = s3.requests();
        assert_eq!(seen.len(), 3, "{seen:?}");
        assert!(seen[0].starts_with("GET "), "{}", seen[0]);
        assert!(seen[1].starts_with("PUT "), "{}", seen[1]);
        assert!(seen[2].starts_with("DELETE "), "{}", seen[2]);
        for line in &seen {
            assert_eq!(bucket_of(line), "bkt-1", "{line}");
            assert!(!line.contains("a&b=c"), "{line}");
            assert!(!line.contains("a%26b%3Dc"), "{line}");
        }
        assert_eq!(object_key_of(&seen[1]), "note.txt");
        assert_eq!(object_key_of(&seen[2]), "note.txt");
    }

    fn recursive_pages(prefix: &str) -> Vec<Vec<String>> {
        let keys: Vec<String> = (0..2500)
            .map(|index| format!("{prefix}/k{index:04}"))
            .collect();
        vec![
            keys[..1000].to_vec(),
            keys[1000..2000].to_vec(),
            keys[2000..].to_vec(),
        ]
    }

    fn list_page_xml(page: &[String], next: Option<&str>) -> String {
        let objects: Vec<(&str, i64, &str)> =
            page.iter().map(|key| (key.as_str(), 1, "abc")).collect();
        list_xml(next.is_some(), next, &objects, &[])
    }

    fn delete_page_xml(page: &[String], fail: Option<(&str, &str)>) -> String {
        let deleted: Vec<&str> = page
            .iter()
            .map(String::as_str)
            .filter(|key| fail.is_none_or(|(bad, _)| *key != bad))
            .collect();
        let failed: Vec<(&str, &str)> = fail.into_iter().collect();
        delete_result(&deleted, &failed)
    }

    struct RecursiveRun {
        response: Exchange,
        requests: Vec<String>,
        bodies: Vec<String>,
        pages: Vec<Vec<String>>,
    }

    async fn run_recursive_delete(
        failures: [Option<(&'static str, &'static str)>; 3],
    ) -> RecursiveRun {
        let prefix = "docs/2024";
        let pages = recursive_pages(prefix);
        let pages_for_mock = pages.clone();
        let posts = Arc::new(AtomicUsize::new(0));
        let mock = S3Mock::start(move |line| {
            if line.starts_with("POST ") {
                let index = posts.fetch_add(1, Ordering::SeqCst);
                assert!(index < pages_for_mock.len(), "{line}");
                return delete_page_xml(&pages_for_mock[index], failures[index]);
            }
            assert!(line.starts_with("GET "), "{line}");
            let token = query_value(request_target(line), "continuation-token");
            let index = match token {
                None => 0,
                Some("page-2") => 1,
                Some("page-3") => 2,
                other => panic!("unexpected continuation token {other:?}"),
            };
            let next = match index {
                0 => Some("page-2"),
                1 => Some("page-3"),
                _ => None,
            };
            list_page_xml(&pages_for_mock[index], next)
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/docs/2024?recursive=true",
                None,
                Some(&session),
            ),
        )
        .await;
        let requests = mock.requests();
        let bodies = mock.bodies();
        RecursiveRun {
            response,
            requests,
            bodies,
            pages,
        }
    }

    fn assert_recursive_traffic(run: &RecursiveRun, prefix: &str) {
        assert_eq!(run.requests.len(), 6, "{:?}", run.requests);
        let mut lists = Vec::new();
        let mut deletes = Vec::new();
        for (line, body) in run.requests.iter().zip(run.bodies.iter()) {
            if line.starts_with("GET ") {
                lists.push((line, body));
            } else if line.starts_with("POST ") {
                deletes.push((line, body));
            } else {
                panic!("unexpected s3 request {line}");
            }
        }
        assert_eq!(lists.len(), 3, "{:?}", run.requests);
        assert_eq!(deletes.len(), 3, "{:?}", run.requests);
        let tokens = [None, Some("page-2"), Some("page-3")];
        for ((line, _), token) in lists.iter().zip(tokens) {
            let target = request_target(line);
            assert!(target.contains("list-type=2"), "{target}");
            let raw = query_value(target, "prefix").unwrap_or("");
            assert_eq!(percent_decode(raw), prefix, "{target}");
            assert_eq!(query_value(target, "max-keys"), Some("1000"), "{target}");
            assert_eq!(query_value(target, "delimiter"), None, "{target}");
            assert_eq!(query_value(target, "continuation-token"), token, "{target}");
            assert_eq!(bucket_of(line), "bkt-1");
        }
        for ((line, body), page) in deletes.iter().zip(run.pages.iter()) {
            assert!(request_target(line).contains("delete"), "{line}");
            assert_eq!(bucket_of(line), "bkt-1");
            assert!(body.contains(&format!("<Key>{}</Key>", page[0])), "{body}");
            assert!(
                body.contains(&format!("<Key>{}</Key>", page[page.len() - 1])),
                "{body}"
            );
            assert!(!body.contains("<Quiet>true</Quiet>"), "{body}");
        }
    }

    #[tokio::test]
    async fn object_delete_recursive_lists_three_pages_and_deletes_2500() {
        let run = run_recursive_delete([None, None, None]).await;
        assert_eq!(run.response.status, StatusCode::OK, "{}", run.response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&run.response.body).unwrap(),
            json!({ "deleted": 2500, "errors": [] })
        );
        assert_recursive_traffic(&run, "docs/2024");
    }

    #[tokio::test]
    async fn object_delete_recursive_keeps_three_key_errors() {
        let failures = [
            Some(("docs/2024/k0000", "injected-0")),
            Some(("docs/2024/k1000", "injected-1")),
            Some(("docs/2024/k2499", "injected-2")),
        ];
        let run = run_recursive_delete(failures).await;
        assert_eq!(run.response.status, StatusCode::OK, "{}", run.response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&run.response.body).unwrap(),
            json!({
                "deleted": 2497,
                "errors": [
                    {"key": "docs/2024/k0000", "message": "injected-0"},
                    {"key": "docs/2024/k1000", "message": "injected-1"},
                    {"key": "docs/2024/k2499", "message": "injected-2"}
                ]
            })
        );
        assert_recursive_traffic(&run, "docs/2024");
    }

    #[tokio::test]
    async fn object_delete_recursive_without_a_project_key_does_not_call_s3() {
        let mock = S3Mock::start(|_| delete_ok()).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, false).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/docs/2024?recursive=true",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PRECONDITION_FAILED,
            "no_usable_key",
            "This bucket has no usable read-write key",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_delete_without_a_project_key_does_not_call_s3() {
        let mock = S3Mock::start(|_| delete_ok()).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, false).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/photos/a.txt",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PRECONDITION_FAILED,
            "no_usable_key",
            "This bucket has no usable read-write key",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_delete_recursive_empty_prefix_returns_zero() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("GET "), "{line}");
            assert_eq!(
                percent_decode(query_value(request_target(line), "prefix").unwrap_or("")),
                "docs/2024"
            );
            list_xml(false, None, &[], &[])
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/docs/2024?recursive=true",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "deleted": 0, "errors": [] })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(
            mock.bodies().iter().all(|body| body.is_empty()),
            "{:?}",
            mock.bodies()
        );
    }

    #[tokio::test]
    async fn object_delete_recursive_false_stays_one_object() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("DELETE "), "{line}");
            delete_ok()
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/photos/a.txt?recursive=false",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::NO_CONTENT, "{}", response.body);
        assert_eq!(response.body, "");
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("DELETE "), "{}", seen[0]);
        assert_eq!(object_key_of(&seen[0]), "photos/a.txt");
    }

    fn delete_result(deleted: &[&str], failed: &[(&str, &str)]) -> String {
        let mut xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">"#,
        );
        for key in deleted {
            xml.push_str(&format!("<Deleted><Key>{key}</Key></Deleted>"));
        }
        for (key, message) in failed {
            xml.push_str(&format!(
                "<Error><Key>{key}</Key><Code>AccessDenied</Code><Message>{message}</Message></Error>"
            ));
        }
        xml.push_str("</DeleteResult>");
        http_xml(&xml)
    }

    fn audit_text(row: &crate::db::AuditRow) -> String {
        format!(
            "{} {} {} {} {} {} {} {}",
            row.username,
            row.ip,
            row.result,
            row.reason,
            row.method,
            row.path,
            row.target,
            row.status
        )
    }

    #[tokio::test]
    async fn csrf_rejection_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let rejected = exchange(
            &app,
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header("cookie", cookie_header(&admin))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_error(
            &rejected,
            StatusCode::FORBIDDEN,
            "csrf_rejected",
            "CSRF token missing or mismatched",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "csrf_rejected");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/logout");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 403);
        assert_eq!(row.username, "Ada");
        assert!(!audit_text(row).contains(&admin.csrf));
        let status = exchange(
            &app,
            request("GET", "/api/auth/status", None, Some(&admin)),
        )
        .await;
        assert_eq!(status.status, StatusCode::OK, "{}", status.body);
        assert_eq!(
            serde_json::from_str::<Value>(&status.body).unwrap()["authenticated"],
            true
        );
    }

    #[tokio::test]
    async fn setup_invalid_username_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let username = "bad name";
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": username, "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{}", response.body);
        assert_eq!(code_of(&response.body), "invalid_username");
        assert!(!response.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, username);
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_username");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/setup");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));
    }

    #[tokio::test]
    async fn setup_invalid_password_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let submitted = "badpass";
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": "Ada", "password": submitted }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{}", response.body);
        assert_eq!(code_of(&response.body), "password_invalid");
        assert!(!response.body.contains(submitted));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "password_invalid");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/setup");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(submitted));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(submitted));
    }

    #[tokio::test]
    async fn setup_already_initialized_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let username = "Other";
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": username, "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
        assert_eq!(code_of(&response.body), "already_initialized");
        assert!(!response.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, username);
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "already_initialized");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/setup");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 409);
        assert!(!audit_text(row).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));
    }

    #[tokio::test]
    async fn change_password_invalid_new_password_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let submitted = "badpass";
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/auth/change-password",
                Some(
                    &json!({
                        "current_password": PASSWORD,
                        "new_password": submitted
                    })
                    .to_string(),
                ),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{}", response.body);
        assert_eq!(code_of(&response.body), "password_invalid");
        assert!(!response.body.contains(submitted));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "password_invalid");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/change-password");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(submitted));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(submitted));
    }

    #[tokio::test]
    async fn password_change_drops_the_other_session() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session_a, _) = login(&app).await;
        let logged_in = exchange(
            &app,
            request(
                "POST",
                "/api/auth/login",
                Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(logged_in.status, StatusCode::OK, "{}", logged_in.body);
        let session_b = session_from(&logged_in.headers);
        let changed = exchange(
            &app,
            request(
                "POST",
                "/api/auth/change-password",
                Some(
                    &json!({
                        "current_password": PASSWORD,
                        "new_password": "updated horse"
                    })
                    .to_string(),
                ),
                Some(&session_a),
            ),
        )
        .await;
        assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
        let replacement = session_from(&changed.headers);
        assert_ne!(replacement.id, session_a.id);

        let other = exchange(&app, request("GET", "/api/config", None, Some(&session_b))).await;
        assert_eq!(other.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&other.body), "unauthenticated");

        let stale = exchange(&app, request("GET", "/api/config", None, Some(&session_a))).await;
        assert_eq!(stale.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&stale.body), "unauthenticated");

        let current =
            exchange(&app, request("GET", "/api/config", None, Some(&replacement))).await;
        assert_eq!(current.status, StatusCode::OK, "{}", current.body);
    }

    #[tokio::test]
    async fn user_list_pages_like_buckets() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let ada_created: i64 = sqlx::query_scalar(
            "SELECT created_at FROM users WHERE username = 'Ada' COLLATE NOCASE",
        )
        .fetch_one(&app.db)
        .await
        .unwrap();
        let mut tx = app.db.begin().await.unwrap();
        for index in 0..1000 {
            sqlx::query(
                "INSERT INTO users (
                    username, password_hash, role, can_download, can_share, disabled, created_at
                 ) VALUES (?, 'stored-hash', 'viewer', 0, 0, 0, ?)",
            )
            .bind(format!("n{index:04}"))
            .bind(1_700_000_000 + i64::from(index))
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();

        let listed = exchange(&app, request("GET", "/api/users", None, Some(&session))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let page: Value = serde_json::from_str(&listed.body).unwrap();
        let items = page["items"].as_array().expect("items");
        assert_eq!(items.len(), 100);
        assert_eq!(page["hasMore"], true);
        assert!(!listed.body.contains("password_hash"));
        assert!(!listed.body.contains("stored-hash"));
        let ada = items
            .iter()
            .find(|user| user["username"] == "Ada")
            .expect("Ada");
        assert_eq!(ada["created_at"].as_i64(), Some(ada_created));

        let capped = exchange(
            &app,
            request("GET", "/api/users?limit=1001", None, Some(&session)),
        )
        .await;
        assert_eq!(capped.status, StatusCode::OK, "{}", capped.body);
        let capped_page: Value = serde_json::from_str(&capped.body).unwrap();
        assert_eq!(capped_page["items"].as_array().expect("items").len(), 1000);
        assert_eq!(capped_page["hasMore"], true);
        assert!(!capped.body.contains("password_hash"));

        let last = exchange(
            &app,
            request(
                "GET",
                "/api/users?offset=1000&limit=1000",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(last.status, StatusCode::OK, "{}", last.body);
        let last_page: Value = serde_json::from_str(&last.body).unwrap();
        let last_items = last_page["items"].as_array().expect("items");
        assert_eq!(last_items.len(), 1);
        assert_eq!(last_page["hasMore"], false);
        assert!(!last.body.contains("password_hash"));
        assert!(!last.body.contains("stored-hash"));
        let last_user = &last_items[0];
        assert_eq!(last_user["username"], "n0999");
        let last_id = last_user["id"].as_i64().expect("id");
        let stored_last: Option<i64> =
            sqlx::query_scalar("SELECT created_at FROM users WHERE id = ?")
                .bind(last_id)
                .fetch_one(&app.db)
                .await
                .unwrap();
        match stored_last {
            Some(created_at) => assert_eq!(last_user["created_at"].as_i64(), Some(created_at)),
            None => assert!(last_user.get("created_at").is_none()),
        }

        let rejected = exchange(
            &app,
            request("GET", "/api/users?limit=nope", None, Some(&session)),
        )
        .await;
        assert_error(
            &rejected,
            StatusCode::BAD_REQUEST,
            "invalid_limit",
            "Limit must be a non-negative integer",
        );
    }

    #[tokio::test]
    async fn user_list_reports_created_at() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let stored: i64 = sqlx::query_scalar(
            "SELECT created_at FROM users WHERE username = 'Ada' COLLATE NOCASE",
        )
        .fetch_one(&app.db)
        .await
        .unwrap();
        let response = exchange(&app, request("GET", "/api/users", None, Some(&session))).await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let users = user_items(&response.body);
        let ada = users
            .iter()
            .find(|user| user["username"] == "Ada")
            .expect("user");
        assert_eq!(ada["created_at"].as_i64(), Some(stored));
        assert!(ada.get("password_hash").is_none());
    }

    #[tokio::test]
    async fn admin_reset_drops_the_user_session() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let other_id = users
            .iter()
            .find(|user| user["username"] == "Bea")
            .expect("user")["id"]
            .as_i64()
            .expect("id");
        let submitted = "rotated horse";
        let reset = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{other_id}/reset-password"),
                Some(&json!({ "password": submitted }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert!(!reset.body.contains(submitted));
        assert_eq!(reset.status, StatusCode::NO_CONTENT);

        let other = exchange(&app, request("GET", "/api/config", None, Some(&viewer))).await;
        assert_eq!(other.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&other.body), "unauthenticated");

        let kept = exchange(&app, request("GET", "/api/config", None, Some(&admin))).await;
        assert_eq!(kept.status, StatusCode::OK, "{}", kept.body);
    }

    #[tokio::test]
    async fn disable_drops_the_user_session_after_reenable() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let other_id = users
            .iter()
            .find(|user| user["username"] != "Ada")
            .expect("other user")["id"]
            .as_i64()
            .expect("id");

        let disabled = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{other_id}"),
                Some(&json!({ "disabled": true }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(disabled.status, StatusCode::OK, "{}", disabled.body);

        let enabled = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{other_id}"),
                Some(&json!({ "disabled": false }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(enabled.status, StatusCode::OK, "{}", enabled.body);

        let other = exchange(&app, request("GET", "/api/config", None, Some(&viewer))).await;
        assert_eq!(other.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&other.body), "unauthenticated");

        let kept = exchange(&app, request("GET", "/api/config", None, Some(&admin))).await;
        assert_eq!(kept.status, StatusCode::OK, "{}", kept.body);
    }

    #[tokio::test]
    async fn demote_drops_the_user_session() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cam",
                        "password": PASSWORD,
                        "role": "admin"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let second = sign_in(&app, "Cam", PASSWORD).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let other_id = users
            .iter()
            .find(|user| user["username"] == "Cam")
            .expect("user")["id"]
            .as_i64()
            .expect("id");
        let demoted = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{other_id}"),
                Some(&json!({ "role": "viewer" }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(demoted.status, StatusCode::OK, "{}", demoted.body);

        let stale = exchange(&app, request("GET", "/api/config", None, Some(&second))).await;
        assert_eq!(stale.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&stale.body), "unauthenticated");

        let kept = exchange(&app, request("GET", "/api/config", None, Some(&admin))).await;
        assert_eq!(kept.status, StatusCode::OK, "{}", kept.body);
    }

    #[tokio::test]
    async fn delete_user_drops_the_session() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let other_id = users
            .iter()
            .find(|user| user["username"] == "Bea")
            .expect("user")["id"]
            .as_i64()
            .expect("id");
        let deleted = exchange(
            &app,
            request(
                "DELETE",
                &format!("/api/users/{other_id}"),
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.body);

        let other = exchange(&app, request("GET", "/api/config", None, Some(&viewer))).await;
        assert_eq!(other.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&other.body), "unauthenticated");

        let kept = exchange(&app, request("GET", "/api/config", None, Some(&admin))).await;
        assert_eq!(kept.status, StatusCode::OK, "{}", kept.body);
    }

    #[tokio::test]
    async fn create_user_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let bad_name = "bad name";
        let submitted = "shortpw";

        let name = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": bad_name,
                        "password": PASSWORD,
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(name.status, StatusCode::BAD_REQUEST, "{}", name.body);
        assert_eq!(code_of(&name.body), "invalid_username");
        assert!(!name.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_username");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, bad_name);
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(PASSWORD));

        let valid_name = "Cara";
        let invalid = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": valid_name,
                        "password": submitted,
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(invalid.status, StatusCode::BAD_REQUEST, "{}", invalid.body);
        assert_eq!(code_of(&invalid.body), "password_invalid");
        assert!(!invalid.body.contains(submitted));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "password_invalid");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, valid_name);
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(submitted));
        assert!(!audit_text(&rows[1]).contains(submitted));
        assert!(!audit_text(&rows[1]).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(submitted));
        assert!(!sink.contains(PASSWORD));
    }

    #[tokio::test]
    async fn create_user_role_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let invalid_role = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": PASSWORD,
                        "role": "editor"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(
            invalid_role.status,
            StatusCode::BAD_REQUEST,
            "{}",
            invalid_role.body
        );
        assert_eq!(code_of(&invalid_role.body), "invalid_role");
        assert!(!invalid_role.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_role");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Cara");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(PASSWORD));

        let share = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Dana",
                        "password": PASSWORD,
                        "role": "viewer",
                        "can_download": false,
                        "can_share": true
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(share.status, StatusCode::BAD_REQUEST, "{}", share.body);
        assert_eq!(code_of(&share.body), "share_requires_download");
        assert!(!share.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let newest = &rows[0];
        assert_eq!(newest.username, "Ada");
        assert_eq!(newest.result, "error");
        assert_eq!(newest.reason, "share_requires_download");
        assert_eq!(newest.method, "POST");
        assert_eq!(newest.path, "/api/users");
        assert_eq!(newest.target, "Dana");
        assert_eq!(newest.status, 400);
        let earlier = &rows[1];
        assert_eq!(earlier.username, "Ada");
        assert_eq!(earlier.result, "error");
        assert_eq!(earlier.reason, "invalid_role");
        assert_eq!(earlier.method, "POST");
        assert_eq!(earlier.path, "/api/users");
        assert_eq!(earlier.target, "Cara");
        assert_eq!(earlier.status, 400);
        assert!(!audit_text(newest).contains(PASSWORD));
        assert!(!audit_text(earlier).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        assert_eq!(users.len(), 1, "{users:?}");
        assert_eq!(users[0]["username"], "Ada");
    }

    #[tokio::test]
    async fn patch_user_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Bea",
                        "password": PASSWORD,
                        "role": "viewer",
                        "can_download": false,
                        "can_share": false
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let created_body: Value = serde_json::from_str(&created.body).unwrap();
        let bea_id = created_body["id"].as_i64().expect("id");
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let invalid_role = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{bea_id}"),
                Some(&json!({ "role": "editor" }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(
            invalid_role.status,
            StatusCode::BAD_REQUEST,
            "{}",
            invalid_role.body
        );
        assert_eq!(code_of(&invalid_role.body), "invalid_role");
        assert!(!invalid_role.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_role");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Bea");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(PASSWORD));

        let share = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{bea_id}"),
                Some(&json!({ "can_share": true }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(share.status, StatusCode::BAD_REQUEST, "{}", share.body);
        assert_eq!(code_of(&share.body), "share_requires_download");
        assert!(!share.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let newest = &rows[0];
        assert_eq!(newest.username, "Ada");
        assert_eq!(newest.result, "error");
        assert_eq!(newest.reason, "share_requires_download");
        assert_eq!(newest.method, "PATCH");
        assert_eq!(newest.path, "/api/users");
        assert_eq!(newest.target, "Bea");
        assert_eq!(newest.status, 400);
        let earlier = &rows[1];
        assert_eq!(earlier.username, "Ada");
        assert_eq!(earlier.result, "error");
        assert_eq!(earlier.reason, "invalid_role");
        assert_eq!(earlier.method, "PATCH");
        assert_eq!(earlier.path, "/api/users");
        assert_eq!(earlier.target, "Bea");
        assert_eq!(earlier.status, 400);
        assert!(!audit_text(newest).contains(PASSWORD));
        assert!(!audit_text(earlier).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));

        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let bea = users
            .iter()
            .find(|user| user["username"] == "Bea")
            .expect("user");
        assert_eq!(bea["role"], "viewer");
        assert_eq!(bea["can_share"], false);
        assert_eq!(bea["disabled"], false);
    }

    #[tokio::test]
    async fn create_user_duplicate_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Ada",
                        "password": PASSWORD,
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
        assert_eq!(code_of(&response.body), "username_taken");
        assert!(!response.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "username_taken");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Ada");
        assert_eq!(row.status, 409);
        assert!(!audit_text(row).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        assert_eq!(users.len(), 1, "{users:?}");
        assert_eq!(users[0]["username"], "Ada");
    }

    #[tokio::test]
    async fn reset_password_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        viewer_session(&app, &admin).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let id_of = |name: &str| {
            users
                .iter()
                .find(|user| user["username"] == name)
                .expect("user")["id"]
                .as_i64()
                .expect("id")
        };
        let admin_id = id_of("Ada");
        let other_id = id_of("Bea");
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let submitted = "shortpw";

        let self_reset = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{admin_id}/reset-password"),
                Some(&json!({ "password": submitted }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(
            self_reset.status,
            StatusCode::BAD_REQUEST,
            "{}",
            self_reset.body
        );
        assert_eq!(code_of(&self_reset.body), "cannot_reset_self");
        assert!(!self_reset.body.contains(submitted));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "cannot_reset_self");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users/reset-password");
        assert_eq!(row.target, "Ada");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(submitted));

        let invalid = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{other_id}/reset-password"),
                Some(&json!({ "password": submitted }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(invalid.status, StatusCode::BAD_REQUEST, "{}", invalid.body);
        assert_eq!(code_of(&invalid.body), "password_invalid");
        assert!(!invalid.body.contains(submitted));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "password_invalid");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users/reset-password");
        assert_eq!(row.target, "Bea");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(submitted));
        assert!(!audit_text(&rows[1]).contains(submitted));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(submitted));
    }

    #[tokio::test]
    async fn missing_user_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        assert_eq!(users.len(), 1, "{users:?}");
        assert_eq!(users[0]["username"], "Ada");
        let admin_id = users[0]["id"].as_i64().expect("id");
        let missing = admin_id.wrapping_add(1);
        let missing_target = missing.to_string();
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let patched = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{missing}"),
                Some(&json!({}).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(patched.status, StatusCode::NOT_FOUND, "{}", patched.body);
        assert_eq!(code_of(&patched.body), "not_found");
        assert!(!patched.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "not_found");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, missing_target);
        assert_eq!(row.status, 404);
        assert!(!audit_text(row).contains(PASSWORD));

        let removed = exchange(
            &app,
            request(
                "DELETE",
                &format!("/api/users/{missing}"),
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::NOT_FOUND, "{}", removed.body);
        assert_eq!(code_of(&removed.body), "not_found");
        assert!(!removed.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "not_found");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, missing_target);
        assert_eq!(row.status, 404);
        assert!(!audit_text(row).contains(PASSWORD));

        let reset = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{missing}/reset-password"),
                Some(&json!({ "password": PASSWORD }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(reset.status, StatusCode::NOT_FOUND, "{}", reset.body);
        assert_eq!(code_of(&reset.body), "not_found");
        assert!(!reset.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 3, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "not_found");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users/reset-password");
        assert_eq!(row.target, missing_target);
        assert_eq!(row.status, 404);
        assert!(!audit_text(row).contains(PASSWORD));
        assert!(!audit_text(&rows[1]).contains(PASSWORD));
        assert!(!audit_text(&rows[2]).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));

        let after = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(after.status, StatusCode::OK, "{}", after.body);
        let users = user_items(&after.body);
        assert_eq!(users.len(), 1, "{users:?}");
        assert_eq!(users[0]["username"], "Ada");
    }

    #[tokio::test]
    async fn self_lock_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let id_of = |name: &str| {
            users
                .iter()
                .find(|user| user["username"] == name)
                .expect("user")["id"]
                .as_i64()
                .expect("id")
        };
        let admin_id = id_of("Ada");
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let disable = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{admin_id}"),
                Some(&json!({ "disabled": true }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(disable.status, StatusCode::BAD_REQUEST, "{}", disable.body);
        assert_eq!(code_of(&disable.body), "cannot_lock_self");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "cannot_lock_self");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Ada");
        assert_eq!(row.status, 400);

        let demote = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{admin_id}"),
                Some(&json!({ "role": "viewer" }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(demote.status, StatusCode::BAD_REQUEST, "{}", demote.body);
        assert_eq!(code_of(&demote.body), "cannot_lock_self");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "cannot_lock_self");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Ada");
        assert_eq!(row.status, 400);

        let removed = exchange(
            &app,
            request(
                "DELETE",
                &format!("/api/users/{admin_id}"),
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::BAD_REQUEST, "{}", removed.body);
        assert_eq!(code_of(&removed.body), "cannot_lock_self");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 3, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "cannot_lock_self");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Ada");
        assert_eq!(row.status, 400);

        let after = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(after.status, StatusCode::OK, "{}", after.body);
        let users = user_items(&after.body);
        let admin_user = users
            .iter()
            .find(|user| user["username"] == "Ada")
            .expect("user");
        assert_eq!(admin_user["role"], "admin");
        assert_eq!(admin_user["disabled"], false);
    }

    #[tokio::test]
    async fn user_write_denials_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let admin_id = users
            .iter()
            .find(|user| user["username"] == "Ada")
            .expect("admin")["id"]
            .as_i64()
            .expect("id");
        let admin_target = admin_id.to_string();
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": PASSWORD,
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&created, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Cara");
        assert_eq!(row.status, 403);
        assert!(!audit_text(row).contains(PASSWORD));

        let patched = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{admin_id}"),
                Some(&json!({}).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&patched, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, admin_target);
        assert_eq!(row.status, 403);
        assert!(!audit_text(row).contains(PASSWORD));

        let removed = exchange(
            &app,
            request(
                "DELETE",
                &format!("/api/users/{admin_id}"),
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&removed, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 3, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, admin_target);
        assert_eq!(row.status, 403);
        assert!(!audit_text(row).contains(PASSWORD));

        let reset = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{admin_id}/reset-password"),
                Some(&json!({ "password": PASSWORD }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&reset, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 4, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users/reset-password");
        assert_eq!(row.target, admin_target);
        assert_eq!(row.status, 403);
        assert!(!audit_text(row).contains(PASSWORD));
        assert!(!audit_text(&rows[1]).contains(PASSWORD));
        assert!(!audit_text(&rows[2]).contains(PASSWORD));
        assert!(!audit_text(&rows[3]).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));

        let after = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(after.status, StatusCode::OK, "{}", after.body);
        let users = user_items(&after.body);
        let names: Vec<_> = users
            .iter()
            .map(|user| user["username"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["Ada", "Bea"]);
    }

    #[tokio::test]
    async fn object_writes_leave_an_audit_row() {
        let mock = S3Mock::start(|line| {
            if line.starts_with("PUT ") {
                return put_ok("abc123");
            }
            if line.starts_with("DELETE ") {
                return delete_ok();
            }
            if line.starts_with("POST ") {
                return delete_result(&["left-photo", "right-photo", "docs/2024/notes.txt"], &[]);
            }
            if line.starts_with("GET ") {
                return list_xml(false, None, &[("docs/2024/notes.txt", 4, "abc")], &[]);
            }
            head_ok()
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before_viewer = crate::db::recent_audit(&app.db).await.unwrap();

        let denied = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/photos/a.txt",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_eq!(denied.status, StatusCode::FORBIDDEN, "{}", denied.body);
        assert!(mock.requests().is_empty());
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_viewer.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects/photos/a.txt");
        assert_eq!(row.target, "bkt-1/photos/a.txt");
        assert_eq!(row.status, 403);

        let body = b"hello";
        let before_put = rows.len();
        let put = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                body,
                Some("5"),
                &admin,
            ),
        )
        .await;
        assert_eq!(put.status, StatusCode::CREATED, "{}", put.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_put + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "PUT");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects/photos/a.txt");
        assert_eq!(row.target, "bkt-1/photos/a.txt");
        assert_eq!(row.status, 201);
        assert!(!audit_text(row).contains("hello"), "{}", audit_text(row));

        let before_delete = rows.len();
        let removed = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/photos/a.txt",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_delete + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects/photos/a.txt");
        assert_eq!(row.target, "bkt-1/photos/a.txt");
        assert_eq!(row.status, 204);

        let before_batch = rows.len();
        let s3_before_batch = mock.requests().len();
        let batch = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": ["left-photo", "right-photo"] }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(batch.status, StatusCode::OK, "{}", batch.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_batch + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects:delete");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 200);
        let text = audit_text(row);
        assert!(!text.contains("left-photo"), "{text}");
        assert!(!text.contains("right-photo"), "{text}");
        assert!(mock.requests().len() > s3_before_batch);

        let before_many = rows.len();
        let s3_before_many = mock.requests().len();
        let keys: Vec<_> = (0..1001).map(|index| format!("k{index}")).collect();
        let too_many = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": keys }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(
            too_many.status,
            StatusCode::BAD_REQUEST,
            "{}",
            too_many.body
        );
        assert_eq!(code_of(&too_many.body), "too_many_keys");
        assert_eq!(mock.requests().len(), s3_before_many);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_many + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "too_many_keys");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects:delete");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);
        let text = audit_text(row);
        assert!(!text.contains("k1000"), "{text}");
        assert!(!text.contains("k0"), "{text}");

        let before_recursive = rows.len();
        let recursive = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/docs/2024?recursive=true",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(recursive.status, StatusCode::OK, "{}", recursive.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_recursive + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects/docs/2024");
        assert_eq!(row.target, "bkt-1/docs/2024");
        assert_eq!(row.status, 200);
        assert!(
            !audit_text(row).contains("notes.txt"),
            "{}",
            audit_text(row)
        );

        let before_get = rows.len();
        let fetched = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/photos/a.txt",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(fetched.status, StatusCode::OK, "{}", fetched.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_get);
    }

    #[tokio::test]
    async fn object_delete_many_rejects_1001_keys_without_an_s3_call() {
        let mock = S3Mock::start(|_| delete_result(&["a"], &[])).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let keys: Vec<_> = (0..1001).map(|index| format!("k{index}")).collect();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": keys }).to_string()),
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "too_many_keys",
            "At most 1000 keys can be deleted at once",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_delete_many_deletes_two_keys_in_one_call() {
        let mock = S3Mock::start(|_| delete_result(&["a", "b"], &[])).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": ["a", "b"] }).to_string()),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "deleted": ["a", "b"], "failed": [] })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("POST "), "{}", seen[0]);
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert!(request_target(&seen[0]).contains("delete"), "{}", seen[0]);
        let bodies = mock.bodies();
        assert_eq!(bodies.len(), 1, "{bodies:?}");
        assert!(bodies[0].contains("<Key>a</Key>"), "{}", bodies[0]);
        assert!(bodies[0].contains("<Key>b</Key>"), "{}", bodies[0]);
    }

    #[tokio::test]
    async fn object_delete_many_keeps_a_partial_error_in_failed() {
        let mock = S3Mock::start(|_| delete_result(&["a"], &[("b", "denied by policy")])).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": ["a", "b"] }).to_string()),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({
                "deleted": ["a"],
                "failed": [{ "key": "b", "message": "denied by policy" }]
            })
        );
        assert_eq!(mock.requests().len(), 1, "{:?}", mock.requests());
    }

    fn object_bytes(content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nETag: \"abc\"\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn object_get_reply(line: &str) -> String {
        let key = object_key_of(line);
        if key == "missing" {
            return head_missing();
        }
        if line.starts_with("HEAD ") {
            return head_ok();
        }
        if key.ends_with(".html") {
            object_bytes("text/html", "<p>hi</p>")
        } else {
            object_bytes("text/plain", "hello plain")
        }
    }

    fn header_text<'a>(response: &'a Exchange, name: &str) -> Option<&'a str> {
        response
            .headers
            .get(name)
            .and_then(|value| value.to_str().ok())
    }

    #[tokio::test]
    async fn object_get_without_a_query_stays_metadata_json() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_ne!(response.body, "hello plain");
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({
                "key": "note.txt",
                "size": 1,
                "etag": "abc",
                "lastModified": "2026-10-11T00:00:00Z",
                "contentType": "text/plain"
            })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("HEAD "), "{}", seen[0]);
    }

    #[tokio::test]
    async fn object_get_preview_of_html_is_an_attachment() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/page.html?preview=1",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, "<p>hi</p>");
        assert_eq!(
            header_text(&response, "content-type"),
            Some("application/octet-stream")
        );
        assert_eq!(
            header_text(&response, "content-disposition"),
            Some("attachment; filename*=UTF-8''page.html")
        );
        assert_eq!(
            header_text(&response, "x-content-type-options"),
            Some("nosniff")
        );
        assert_eq!(
            header_text(&response, "content-security-policy"),
            Some("sandbox; frame-ancestors 'self'")
        );
        assert_eq!(
            header_text(&response, "x-frame-options"),
            Some("SAMEORIGIN")
        );
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("GET "), "{}", seen[0]);
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(object_key_of(&seen[0]), "page.html");
    }

    #[tokio::test]
    async fn object_get_preview_of_plain_stays_inline() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, "hello plain");
        assert_eq!(header_text(&response, "content-type"), Some("text/plain"));
        assert!(response.headers.get("content-disposition").is_none());
        assert_eq!(
            header_text(&response, "x-content-type-options"),
            Some("nosniff")
        );
    }

    #[tokio::test]
    async fn object_get_download_of_plain_is_an_attachment() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/photos/note.txt?download=1",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, "hello plain");
        assert_eq!(header_text(&response, "content-type"), Some("text/plain"));
        assert_eq!(
            header_text(&response, "content-disposition"),
            Some("attachment; filename*=UTF-8''note.txt")
        );
        assert_eq!(
            header_text(&response, "x-content-type-options"),
            Some("nosniff")
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("GET "), "{}", seen[0]);
        assert_eq!(object_key_of(&seen[0]), "photos/note.txt");
    }

    struct DownloadLog(Arc<Mutex<Vec<u8>>>);

    impl Write for DownloadLog {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("download log").extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn download_drop_cancels_the_s3_get_within_one_second() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let closed = Arc::new(AtomicBool::new(false));
        let wake = Arc::new(tokio::sync::Notify::new());
        let closed_task = Arc::clone(&closed);
        let wake_task = Arc::clone(&wake);
        let mock = tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buf = Vec::new();
            let mut tmp = [0_u8; 4096];
            let header_end = loop {
                let Ok(read) = socket.read(&mut tmp).await else {
                    return;
                };
                if read == 0 {
                    return;
                }
                buf.extend_from_slice(&tmp[..read]);
                if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                    break pos;
                }
                if buf.len() > 64 * 1024 {
                    return;
                }
            };
            let text = String::from_utf8_lossy(&buf[..header_end]);
            let length = header_value(&text, "content-length")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let mut request_body = buf[header_end + 4..].to_vec();
            while request_body.len() < length {
                let Ok(read) = socket.read(&mut tmp).await else {
                    return;
                };
                if read == 0 {
                    return;
                }
                request_body.extend_from_slice(&tmp[..read]);
            }
            drop(request_body);
            let response = concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: text/plain\r\n",
                "Content-Length: 1048576\r\n",
                "ETag: \"abc\"\r\n",
                "\r\n",
                "partial"
            );
            if socket.write_all(response.as_bytes()).await.is_err() {
                return;
            }
            let _ = socket.flush().await;
            loop {
                match socket.read(&mut tmp).await {
                    Ok(0) | Err(_) => {
                        closed_task.store(true, Ordering::SeqCst);
                        wake_task.notify_waiters();
                        return;
                    }
                    Ok(_) => {}
                }
            }
        });
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &format!("http://127.0.0.1:{port}"), true).await;
        let (session, _) = login(&app).await;
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            router(app).oneshot(request(
                "GET",
                "/api/buckets/bkt-1/objects/photos/note.txt?download=1",
                None,
                Some(&session),
            )),
        )
        .await
        .expect("download headers")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            !closed.load(Ordering::SeqCst),
            "s3 socket closed before the download body was dropped"
        );
        let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&logs);
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_ansi(false)
            .with_writer(move || DownloadLog(Arc::clone(&sink)))
            .finish();
        tracing::subscriber::with_default(subscriber, || drop(response));
        let observed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let notified = wake.notified();
                if closed.load(Ordering::SeqCst) {
                    return;
                }
                notified.await;
            }
        })
        .await;
        mock.abort();
        assert!(
            observed.is_ok(),
            "s3 socket still open one second after the download body was dropped"
        );
        let text = String::from_utf8(logs.lock().expect("download log").clone()).unwrap();
        assert_eq!(text.matches("download cancelled").count(), 1);
        assert!(!text.contains("partial"));
    }

    #[tokio::test]
    async fn object_get_missing_key_is_404() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/missing?preview=1",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_error(&response, StatusCode::NOT_FOUND, "not_found", "Not found");
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("GET "), "{}", seen[0]);
        assert_eq!(object_key_of(&seen[0]), "missing");
    }

    #[tokio::test]
    async fn object_get_without_a_project_key_does_not_call_s3() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, false).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?download=1",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PRECONDITION_FAILED,
            "no_usable_key",
            "This bucket has no usable read-write key",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_get_viewer_without_download_does_not_call_s3() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_get_rejects_an_invalid_view_without_calling_s3() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        for uri in [
            "/api/buckets/bkt-1/objects/note.txt?preview=1&download=1",
            "/api/buckets/bkt-1/objects/note.txt?preview=2",
            "/api/buckets/bkt-1/objects/note.txt?download=0",
        ] {
            let response = exchange(&app, request("GET", uri, None, Some(&session))).await;
            assert_error(
                &response,
                StatusCode::BAD_REQUEST,
                "invalid_view",
                "Choose preview or download",
            );
        }
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_routes_require_a_session_and_a_viewer_can_list() {
        let mock = S3Mock::start(|_| list_xml(false, None, &[("a.txt", 1, "abc")], &[])).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let anon = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, None),
        )
        .await;
        assert_eq!(anon.status, StatusCode::UNAUTHORIZED, "{}", anon.body);
        assert!(mock.requests().is_empty());

        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let listed_by_viewer = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&viewer)),
        )
        .await;
        assert_eq!(
            listed_by_viewer.status,
            StatusCode::OK,
            "{}",
            listed_by_viewer.body
        );
        assert_eq!(
            serde_json::from_str::<Value>(&listed_by_viewer.body).unwrap()["entries"][0]["key"],
            "a.txt"
        );
        assert_eq!(mock.requests().len(), 1);
        assert!(request_target(&mock.requests()[0]).contains("delimiter="));

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": "viewer horse",
                        "role": "viewer",
                        "can_download": true
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let allowed = sign_in(&app, "Cara", "viewer horse").await;
        let listed = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/search?q=txt",
                None,
                Some(&allowed),
            ),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap()["matches"][0]["key"],
            "a.txt"
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!(bucket_of(&seen[1]), "bkt-1");
        assert!(!request_target(&seen[1]).contains("delimiter="));
    }

    fn browse_reply(line: &str) -> String {
        if request_target(line).contains("list-type=") {
            return list_xml(false, None, &[("note.txt", 11, "abc")], &[]);
        }
        object_get_reply(line)
    }

    #[tokio::test]
    async fn object_viewer_without_download_lists_metadata_and_blocks_transfer() {
        let mock = S3Mock::start(browse_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;

        let listed = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&viewer)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "prefix": "",
                "entries": [
                    {"kind": "object", "key": "note.txt", "size": 11, "etag": "abc", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "next": null
            })
        );

        let found = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/search?q=txt",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_eq!(found.status, StatusCode::OK, "{}", found.body);
        assert_eq!(
            serde_json::from_str::<Value>(&found.body).unwrap(),
            json!({
                "matches": [
                    {"key": "note.txt", "size": 11, "etag": "abc", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "truncated": false,
                "reason": null
            })
        );

        let meta = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_eq!(meta.status, StatusCode::OK, "{}", meta.body);
        assert_eq!(
            serde_json::from_str::<Value>(&meta.body).unwrap(),
            json!({
                "key": "note.txt",
                "size": 1,
                "etag": "abc",
                "lastModified": "2026-10-11T00:00:00Z",
                "contentType": "text/plain"
            })
        );
        let calls_before_transfer = mock.requests().len();

        let preview = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&preview, StatusCode::FORBIDDEN, "forbidden", "Not allowed");

        let download = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?download=1",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&download, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(mock.requests().len(), calls_before_transfer);
    }

    #[tokio::test]
    async fn object_viewer_preview_succeeds_after_download_is_granted() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Bea",
                        "password": "viewer horse",
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let user_id = serde_json::from_str::<Value>(&created.body).unwrap()["id"]
            .as_i64()
            .unwrap();
        let viewer = sign_in(&app, "Bea", "viewer horse").await;
        let denied = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert!(mock.requests().is_empty());

        let patched = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{user_id}"),
                Some(&json!({ "can_download": true }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(patched.status, StatusCode::OK, "{}", patched.body);
        assert_eq!(
            serde_json::from_str::<Value>(&patched.body).unwrap()["can_download"],
            true
        );

        let preview = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_eq!(preview.status, StatusCode::OK, "{}", preview.body);
        assert_eq!(preview.body, "hello plain");
    }

    #[tokio::test]
    async fn object_search_rejects_a_short_query_and_stops_at_two_hundred() {
        let mock = S3Mock::start(|_| {
            let mut objects = String::new();
            for index in 0..250 {
                objects.push_str(&format!(
                    "<Contents><Key>m-{index:03}</Key><LastModified>2026-10-11T00:00:00.000Z</LastModified><ETag>\"abc\"</ETag><Size>12</Size></Contents>"
                ));
            }
            http_xml(&format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>more</NextContinuationToken><KeyCount>250</KeyCount>{objects}</ListBucketResult>"#
            ))
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let short = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/search?q=a", None, Some(&session)),
        )
        .await;
        assert_error(
            &short,
            StatusCode::BAD_REQUEST,
            "query_too_short",
            "Search needs at least 2 characters",
        );
        assert!(mock.requests().is_empty(), "a 1-character search called S3");

        let found = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/search?q=m-",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(found.status, StatusCode::OK, "{}", found.body);
        let body: Value = serde_json::from_str(&found.body).unwrap();
        assert_eq!(body["truncated"], true);
        assert_eq!(body["reason"], "result_limit");
        assert_eq!(body["matches"].as_array().unwrap().len(), 200);
        assert_eq!(body["matches"][0]["key"], "m-000");
        assert_eq!(body["matches"][199]["key"], "m-199");
        assert_eq!(body["matches"][199]["size"], 12);
        assert_eq!(body["matches"][199]["etag"], "abc");
        assert_eq!(body["matches"][199]["lastModified"], "2026-10-11T00:00:00Z");
        assert_eq!(mock.requests().len(), 1);
        assert_eq!(bucket_of(&mock.requests()[0]), "bkt-1");
    }

    #[tokio::test]
    async fn object_search_stops_after_twenty_pages() {
        let mock = S3Mock::start(|_| {
            list_xml(true, Some("more"), &[("note.txt", 1, "abc")], &[])
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let found = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/search?q=qx",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(found.status, StatusCode::OK, "{}", found.body);
        assert_eq!(
            serde_json::from_str::<Value>(&found.body).unwrap(),
            json!({
                "matches": [],
                "truncated": true,
                "reason": "page_limit"
            })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 20, "{seen:?}");
        for (index, line) in seen.iter().enumerate() {
            let target = request_target(line);
            assert!(target.contains("list-type=2"), "{target}");
            assert_eq!(query_value(target, "max-keys"), Some("1000"), "{target}");
            assert_eq!(bucket_of(line), "bkt-1");
            let token = query_value(target, "continuation-token");
            if index == 0 {
                assert_eq!(token, None, "{target}");
            } else {
                assert_eq!(token, Some("more"), "{target}");
            }
        }
    }

    #[tokio::test]
    async fn object_search_stays_inside_the_prefix() {
        let mock = S3Mock::start(|line| {
            let raw = query_value(request_target(line), "prefix").unwrap_or("");
            if percent_decode(raw) == "photos/" {
                list_xml(false, None, &[("photos/ab.txt", 1, "abc")], &[])
            } else {
                list_xml(false, None, &[("other/ab.txt", 1, "abc")], &[])
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let found = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/search?q=ab&prefix=photos/",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(found.status, StatusCode::OK);
        let body: Value = serde_json::from_str(&found.body).unwrap();
        let matches = body["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["key"], "photos/ab.txt");
        assert_eq!(body["truncated"], false);
        assert_eq!(body["reason"], Value::Null);
        let seen = mock.requests();
        assert_eq!(seen.len(), 1);
        let target = request_target(&seen[0]);
        assert!(target.contains("list-type=2"), "{target}");
        assert_eq!(query_value(target, "max-keys"), Some("1000"), "{target}");
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(
            percent_decode(query_value(target, "prefix").unwrap_or("")),
            "photos/"
        );
        assert!(query_value(target, "delimiter").is_none(), "{target}");
    }

    #[tokio::test]
    async fn object_metadata_round_trips_odd_keys_and_a_missing_object_is_404() {
        let mock = S3Mock::start(|line| {
            if request_target(line).contains("missing") {
                head_missing()
            } else {
                head_ok()
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        for key in ["a?b#c%20d=e", "照片.txt"] {
            let response = exchange(
                &app,
                request(
                    "GET",
                    &format!("/api/buckets/bkt-1/objects/{}", encode_key(key)),
                    None,
                    Some(&session),
                ),
            )
            .await;
            assert_eq!(response.status, StatusCode::OK, "{key} {}", response.body);
            assert_eq!(
                serde_json::from_str::<Value>(&response.body).unwrap(),
                json!({
                    "key": key,
                    "size": 1,
                    "etag": "abc",
                    "lastModified": "2026-10-11T00:00:00Z",
                    "contentType": "text/plain"
                })
            );
        }
        let seen = mock.requests();
        assert_eq!(seen.len(), 2);
        for (line, key) in seen.iter().zip(["a?b#c%20d=e", "照片.txt"]) {
            let path = request_target(line).split('?').next().unwrap_or("");
            let decoded = percent_decode(path.trim_start_matches('/'));
            let (bucket, object_key) = decoded.split_once('/').unwrap();
            assert_eq!(bucket, "bkt-1");
            assert_eq!(object_key, key);
            assert!(line.starts_with("HEAD "), "{line}");
        }
        let missing = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/missing",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_error(&missing, StatusCode::NOT_FOUND, "not_found", "Not found");
    }

    #[tokio::test]
    async fn object_metadata_is_private_no_store() {
        let mock = S3Mock::start(|_| head_ok()).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        let body: Value = serde_json::from_str(&response.body).expect("metadata json");
        assert_eq!(body["key"], "note.txt");
    }

    #[tokio::test]
    async fn thumbnail_response_write_once_after_head_object_fails() {
        let mock = S3Mock::start(|_| head_missing()).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/photo.png/thumbnail",
                None,
                Some(&session),
            ),
        )
        .await;
        let seen = mock.requests();
        assert!(
            seen.iter().any(|line| line.starts_with("HEAD ")),
            "HeadObject was not called: {seen:?}"
        );
        assert_eq!(object_key_of(&seen[0]), "photo.png");
        assert_eq!(response.status, StatusCode::NOT_FOUND);
        assert_eq!(
            response.body,
            r#"{"code":"not_found","message":"Not found"}"#
        );
    }

    #[tokio::test]
    async fn admin_token_list_hides_the_secret_and_marks_a_null_id() {
        let secret = "fixture-not-a-token";
        let garage = json!([
            {
                "id": null,
                "name": "admin_token",
                "created": null,
                "expiration": null,
                "expired": false,
                "scope": ["*"],
                "secretToken": secret
            },
            {
                "id": "gk-admin-1",
                "name": "reader",
                "created": "2026-03-01T00:00:00Z",
                "expiration": null,
                "expired": false,
                "scope": ["GetClusterStatus", "Metrics"],
                "secretToken": secret
            }
        ])
        .to_string();
        let mock = Upstream::start(UpstreamReply::Ok(garage)).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let listed = exchange(
            &app,
            request("GET", "/api/admin-tokens", None, Some(&admin)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "items": [
                    {
                        "id": null,
                        "name": "admin_token",
                        "created": null,
                        "expiration": null,
                        "expired": false,
                        "scope": ["*"],
                        "fromConfig": true
                    },
                    {
                        "id": "gk-admin-1",
                        "name": "reader",
                        "created": "2026-03-01T00:00:00Z",
                        "expiration": null,
                        "expired": false,
                        "scope": ["GetClusterStatus", "Metrics"],
                        "fromConfig": false
                    }
                ],
                "hasMore": false
            })
        );
        assert!(!listed.body.contains("secretToken"));
        assert!(!listed.body.contains(secret));
        let admin_calls = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("ListAdminTokens"))
            .count();
        assert_eq!(admin_calls, 1);

        let viewer = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            request("GET", "/api/admin-tokens", None, Some(&viewer)),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        let denied_rows: Vec<_> = rows
            .iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        let viewer_calls = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("ListAdminTokens"))
            .count();
        assert_eq!(viewer_calls, 1);
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));
    }

    #[tokio::test]
    async fn admin_token_get_drops_the_secret() {
        let token_id = "fixture-get-1";
        let secret = "fixture-get-secret";
        let path = format!("/api/admin-tokens/{token_id}?search=nope");
        let upstream = json!({
            "secretToken": secret,
            "id": token_id,
            "name": "reader",
            "created": "2026-03-01T00:00:00Z",
            "expiration": null,
            "expired": false,
            "scope": ["GetClusterStatus"],
            "neverExpires": false
        });
        let mock = Upstream::start(UpstreamReply::Ok(upstream.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap().len();
        let response = exchange(&app, request("GET", &path, None, Some(&admin))).await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({
                "id": token_id,
                "name": "reader",
                "created": "2026-03-01T00:00:00Z",
                "expiration": null,
                "expired": false,
                "scope": ["GetClusterStatus"],
                "fromConfig": false
            })
        );
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        assert!(!response.body.contains(secret));
        assert!(!response.body.contains("secretToken"));
        let gets: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("GET /v2/GetAdminTokenInfo"))
            .collect();
        assert_eq!(
            gets.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            gets[0].line.contains(&format!("id={token_id}")),
            "{}",
            gets[0].line
        );
        assert!(!gets[0].line.contains("search"), "{}", gets[0].line);
        assert_eq!(
            crate::db::recent_audit(&app.db).await.unwrap().len(),
            before
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));

        let blocked = Upstream::start(UpstreamReply::Ok(upstream.to_string())).await;
        let blocked_dir = crate::util::temp_dir();
        let blocked_app = app_for(&blocked_dir, &blocked.url).await;
        let (blocked_admin, _) = login(&blocked_app).await;
        let viewer = viewer_session(&blocked_app, &blocked_admin).await;
        let denied = exchange(&blocked_app, request("GET", &path, None, Some(&viewer))).await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let denied_rows: Vec<_> = crate::db::recent_audit(&blocked_app.db)
            .await
            .unwrap()
            .into_iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        assert!(
            blocked
                .calls()
                .iter()
                .all(|call| !call.line.contains("GetAdminTokenInfo"))
        );
        let blocked_sink = blocked_app.log_sink.lock().expect("logs").join("\n");
        assert!(!blocked_sink.contains(secret));
        assert!(!blocked_sink.contains("secretToken"));
    }

    #[tokio::test]
    async fn current_admin_token_hides_the_server_token() {
        let token_id = "fixture-current-id";
        let secret = "fixture-current-secret";
        let upstream = json!({
            "secretToken": secret,
            "id": token_id,
            "name": "server",
            "created": "2026-03-01T00:00:00Z",
            "expiration": "2026-12-01T00:00:00Z",
            "expired": false,
            "scope": ["GetClusterStatus", "Metrics"],
            "neverExpires": false
        });
        let mock = Upstream::start(UpstreamReply::Ok(upstream.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap().len();
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/admin-tokens/current?search=nope",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        let body = serde_json::from_str::<Value>(&response.body).unwrap();
        assert!(body.get("id").is_none(), "{}", response.body);
        assert_eq!(
            body,
            json!({
                "name": "server",
                "created": "2026-03-01T00:00:00Z",
                "expiration": "2026-12-01T00:00:00Z",
                "expired": false,
                "scope": ["GetClusterStatus", "Metrics"],
                "fromConfig": false
            })
        );
        assert!(!response.body.contains(secret));
        assert!(!response.body.contains("secretToken"));
        assert!(!response.body.contains(token_id));
        let gets: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("GET /v2/GetCurrentAdminTokenInfo"))
            .collect();
        assert_eq!(
            gets.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(!gets[0].line.contains('?'), "{}", gets[0].line);
        assert!(!gets[0].line.contains("search"), "{}", gets[0].line);
        assert!(gets[0].body.is_empty(), "{}", gets[0].body);
        assert_eq!(
            crate::db::recent_audit(&app.db).await.unwrap().len(),
            before
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));
        assert!(!sink.contains(token_id));

        let null_upstream = json!({
            "secretToken": secret,
            "id": null,
            "name": "admin_token",
            "created": null,
            "expiration": null,
            "expired": false,
            "scope": ["*"]
        });
        let null_mock = Upstream::start(UpstreamReply::Ok(null_upstream.to_string())).await;
        let null_dir = crate::util::temp_dir();
        let null_app = app_for(&null_dir, &null_mock.url).await;
        let (null_admin, _) = login(&null_app).await;
        let null_response = exchange(
            &null_app,
            request(
                "GET",
                "/api/admin-tokens/current?search=nope",
                None,
                Some(&null_admin),
            ),
        )
        .await;
        assert_eq!(
            null_response.status,
            StatusCode::OK,
            "{}",
            null_response.body
        );
        let null_body = serde_json::from_str::<Value>(&null_response.body).unwrap();
        assert!(null_body.get("id").is_none(), "{}", null_response.body);
        assert_eq!(
            null_body,
            json!({
                "name": "admin_token",
                "created": null,
                "expiration": null,
                "expired": false,
                "scope": ["*"],
                "fromConfig": true
            })
        );
        assert!(!null_response.body.contains(secret));
        assert!(!null_response.body.contains("secretToken"));
        let null_sink = null_app.log_sink.lock().expect("logs").join("\n");
        assert!(!null_sink.contains(secret));
        assert!(!null_sink.contains("secretToken"));

        let blocked = Upstream::start(UpstreamReply::Ok(upstream.to_string())).await;
        let blocked_dir = crate::util::temp_dir();
        let blocked_app = app_for(&blocked_dir, &blocked.url).await;
        let (blocked_admin, _) = login(&blocked_app).await;
        let viewer = viewer_session(&blocked_app, &blocked_admin).await;
        let denied = exchange(
            &blocked_app,
            request(
                "GET",
                "/api/admin-tokens/current?search=nope",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let denied_rows: Vec<_> = crate::db::recent_audit(&blocked_app.db)
            .await
            .unwrap()
            .into_iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        assert!(
            blocked
                .calls()
                .iter()
                .all(|call| !call.line.contains("GetCurrentAdminTokenInfo"))
        );
        let blocked_sink = blocked_app.log_sink.lock().expect("logs").join("\n");
        assert!(!blocked_sink.contains(secret));
        assert!(!blocked_sink.contains("secretToken"));
        assert!(!blocked_sink.contains(token_id));
    }

    fn with_confirm(mut call: Request<Body>) -> Request<Body> {
        call.headers_mut()
            .insert("x-confirm", HeaderValue::from_static("yes"));
        call
    }

    #[tokio::test]
    async fn admin_token_create_returns_the_secret_once() {
        let secret = "shown-once-fixture";
        let created =
            format!(r#"{{"secretToken":"{secret}","id":"tok-1","name":"reader","expired":false}}"#);
        let sent = json!({
            "name": "reader",
            "expiration": "2026-12-01T00:00:00Z",
            "scope": ["GetClusterStatus", "Metrics"]
        });
        let mock = Upstream::start(UpstreamReply::Ok(created.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            with_confirm(request(
                "POST",
                "/api/admin-tokens",
                Some(&sent.to_string()),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, created);
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        let creates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/CreateAdminToken "))
            .collect();
        assert_eq!(
            creates.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&creates[0].body).unwrap(),
            sent
        );
        assert!(!creates[0].body.contains("secretToken"));
        assert!(!creates[0].body.contains(secret));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        let listed = rows
            .iter()
            .map(|row| {
                format!(
                    "{} {} {} {} {} {} {}",
                    row.username, row.ip, row.result, row.reason, row.method, row.path, row.target
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!listed.contains(secret), "{listed}");
        assert!(rows.iter().any(|row| {
            row.result == "success"
                && row.reason == "ok"
                && row.method == "POST"
                && row.path == "/api/admin-tokens"
                && row.target == "tok-1"
        }));
        assert!(
            rows.iter()
                .any(|row| row.result == "success" && row.target == "CreateAdminToken")
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));

        let bare = Upstream::start(UpstreamReply::Ok(created.clone())).await;
        let bare_dir = crate::util::temp_dir();
        let bare_app = app_for(&bare_dir, &bare.url).await;
        let (bare_admin, _) = login(&bare_app).await;
        let before = crate::db::recent_audit(&bare_app.db).await.unwrap().len();
        let unconfirmed = exchange(
            &bare_app,
            request(
                "POST",
                "/api/admin-tokens",
                Some(&sent.to_string()),
                Some(&bare_admin),
            ),
        )
        .await;
        assert_error(
            &unconfirmed,
            StatusCode::FORBIDDEN,
            "confirmation_required",
            "Confirmation required",
        );
        assert!(
            bare.calls()
                .iter()
                .all(|call| !call.line.contains("CreateAdminToken"))
        );
        assert_eq!(
            crate::db::recent_audit(&bare_app.db).await.unwrap().len(),
            before
        );

        let blocked = Upstream::start(UpstreamReply::Ok(created)).await;
        let blocked_dir = crate::util::temp_dir();
        let blocked_app = app_for(&blocked_dir, &blocked.url).await;
        let (blocked_admin, _) = login(&blocked_app).await;
        let viewer = viewer_session(&blocked_app, &blocked_admin).await;
        let denied = exchange(
            &blocked_app,
            with_confirm(request(
                "POST",
                "/api/admin-tokens",
                Some(&sent.to_string()),
                Some(&viewer),
            )),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let denied_rows: Vec<_> = crate::db::recent_audit(&blocked_app.db)
            .await
            .unwrap()
            .into_iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        assert!(
            blocked
                .calls()
                .iter()
                .all(|call| !call.line.contains("CreateAdminToken"))
        );
    }

    #[tokio::test]
    async fn admin_token_update_drops_the_secret() {
        let token_id = "tok-upd-1";
        let secret = "upd-fixture-secret";
        let path = format!("/api/admin-tokens/{token_id}");
        let upstream = json!({
            "secretToken": secret,
            "id": token_id,
            "name": "renamed",
            "created": "2026-03-01T00:00:00Z",
            "expiration": "2027-01-01T00:00:00Z",
            "expired": false,
            "scope": ["GetClusterStatus"],
            "neverExpires": false
        });
        let sent = json!({
            "name": "renamed",
            "expiration": "2027-01-01T00:00:00Z",
            "scope": ["GetClusterStatus"],
            "neverExpires": false
        });
        let upstream_body = upstream.to_string();
        let mock = Upstream::start(UpstreamReply::Ok(upstream_body.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            with_confirm(request(
                "PATCH",
                &path,
                Some(&sent.to_string()),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let mut expected = upstream;
        expected.as_object_mut().unwrap().remove("secretToken");
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            expected
        );
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        assert!(!response.body.contains(secret));
        assert!(!response.body.contains("secretToken"));
        let updates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/UpdateAdminToken?"))
            .collect();
        assert_eq!(
            updates.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            updates[0].line.contains(&format!("id={token_id}")),
            "{}",
            updates[0].line
        );
        assert_eq!(
            serde_json::from_str::<Value>(&updates[0].body).unwrap(),
            sent
        );
        assert!(!updates[0].body.contains(secret));
        assert!(!updates[0].body.contains("secretToken"));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        let listed = rows
            .iter()
            .map(|row| {
                format!(
                    "{} {} {} {} {} {} {} {}",
                    row.username,
                    row.ip,
                    row.result,
                    row.reason,
                    row.method,
                    row.path,
                    row.target,
                    row.status
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!listed.contains(secret), "{listed}");
        assert!(rows.iter().any(|row| {
            row.result == "success"
                && row.reason == "ok"
                && row.method == "PATCH"
                && row.path == path
                && row.target == token_id
        }));
        assert!(
            rows.iter()
                .any(|row| row.result == "success" && row.target == "UpdateAdminToken")
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));

        let bare = Upstream::start(UpstreamReply::Ok(upstream_body.clone())).await;
        let bare_dir = crate::util::temp_dir();
        let bare_app = app_for(&bare_dir, &bare.url).await;
        let (bare_admin, _) = login(&bare_app).await;
        let before = crate::db::recent_audit(&bare_app.db).await.unwrap().len();
        let unconfirmed = exchange(
            &bare_app,
            request("PATCH", &path, Some(&sent.to_string()), Some(&bare_admin)),
        )
        .await;
        assert_error(
            &unconfirmed,
            StatusCode::FORBIDDEN,
            "confirmation_required",
            "Confirmation required",
        );
        assert!(
            bare.calls()
                .iter()
                .all(|call| !call.line.contains("UpdateAdminToken"))
        );
        assert_eq!(
            crate::db::recent_audit(&bare_app.db).await.unwrap().len(),
            before
        );

        let blocked = Upstream::start(UpstreamReply::Ok(upstream_body)).await;
        let blocked_dir = crate::util::temp_dir();
        let blocked_app = app_for(&blocked_dir, &blocked.url).await;
        let (blocked_admin, _) = login(&blocked_app).await;
        let viewer = viewer_session(&blocked_app, &blocked_admin).await;
        let denied = exchange(
            &blocked_app,
            with_confirm(request(
                "PATCH",
                &path,
                Some(&sent.to_string()),
                Some(&viewer),
            )),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let denied_rows: Vec<_> = crate::db::recent_audit(&blocked_app.db)
            .await
            .unwrap()
            .into_iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        assert!(
            blocked
                .calls()
                .iter()
                .all(|call| !call.line.contains("UpdateAdminToken"))
        );
    }

    #[tokio::test]
    async fn admin_token_delete_drops_the_secret() {
        let token_id = "tok-del-1";
        let secret = "del-fixture-secret";
        let path = format!("/api/admin-tokens/{token_id}");
        let upstream = json!({
            "secretToken": secret,
            "id": token_id,
            "name": "gone",
            "created": "2026-03-01T00:00:00Z",
            "expiration": null,
            "expired": false,
            "scope": ["GetClusterStatus"]
        });
        let upstream_body = upstream.to_string();
        let mock = Upstream::start(UpstreamReply::Ok(upstream_body.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(&app, request("DELETE", &path, None, Some(&admin))).await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let mut expected = upstream;
        expected.as_object_mut().unwrap().remove("secretToken");
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            expected
        );
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        assert!(!response.body.contains(secret));
        assert!(!response.body.contains("secretToken"));
        let deletes: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/DeleteAdminToken?"))
            .collect();
        assert_eq!(
            deletes.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            deletes[0].line.contains(&format!("id={token_id}")),
            "{}",
            deletes[0].line
        );
        assert!(deletes[0].body.is_empty(), "{}", deletes[0].body);
        assert!(!deletes[0].body.contains(secret));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        let listed = rows
            .iter()
            .map(|row| {
                format!(
                    "{} {} {} {} {} {} {} {}",
                    row.username,
                    row.ip,
                    row.result,
                    row.reason,
                    row.method,
                    row.path,
                    row.target,
                    row.status
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!listed.contains(secret), "{listed}");
        assert!(rows.iter().any(|row| {
            row.result == "success"
                && row.reason == "ok"
                && row.method == "DELETE"
                && row.path == path
                && row.target == token_id
        }));
        assert!(
            rows.iter()
                .any(|row| row.result == "success" && row.target == "DeleteAdminToken")
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));

        let blocked = Upstream::start(UpstreamReply::Ok(upstream_body)).await;
        let blocked_dir = crate::util::temp_dir();
        let blocked_app = app_for(&blocked_dir, &blocked.url).await;
        let (blocked_admin, _) = login(&blocked_app).await;
        let viewer = viewer_session(&blocked_app, &blocked_admin).await;
        let denied = exchange(&blocked_app, request("DELETE", &path, None, Some(&viewer))).await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let denied_rows: Vec<_> = crate::db::recent_audit(&blocked_app.db)
            .await
            .unwrap()
            .into_iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        assert!(
            blocked
                .calls()
                .iter()
                .all(|call| !call.line.contains("DeleteAdminToken"))
        );
    }

    #[tokio::test]
    async fn admin_timeout_is_504_and_refusal_stays_502() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stall_port = listener.local_addr().unwrap().port();
        let stall = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let _hold = socket;
                std::future::pending::<()>().await;
            }
        });
        let stall_url = format!("http://127.0.0.1:{stall_port}");
        let stall_dir = crate::util::temp_dir();
        let stalled = state::test_app_with(
            &stall_dir,
            &[
                ("GARAGE_ADMIN_URL", stall_url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("GARAGE_ADMIN_CONNECT_TIMEOUT_SECS", "1"),
                ("GARAGE_ADMIN_TIMEOUT_SECS", "1"),
            ],
            test_quota(),
        )
        .await;
        let (admin, _) = login(&stalled).await;
        let timed_out =
            exchange(&stalled, request("GET", "/api/buckets", None, Some(&admin))).await;
        stall.abort();
        assert_eq!(timed_out.status, StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(code_of(&timed_out.body), "garage_timeout");
        assert!(!timed_out.body.contains(TOKEN));

        let refused = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let refused_port = refused.local_addr().unwrap().port();
        drop(refused);
        let refused_url = format!("http://127.0.0.1:{refused_port}");
        let refused_dir = crate::util::temp_dir();
        let down = state::test_app_with(
            &refused_dir,
            &[
                ("GARAGE_ADMIN_URL", refused_url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("GARAGE_ADMIN_CONNECT_TIMEOUT_SECS", "1"),
                ("GARAGE_ADMIN_TIMEOUT_SECS", "1"),
            ],
            test_quota(),
        )
        .await;
        let (admin, _) = login(&down).await;
        let refused_response =
            exchange(&down, request("GET", "/api/buckets", None, Some(&admin))).await;
        assert_eq!(refused_response.status, StatusCode::BAD_GATEWAY);
        assert_eq!(code_of(&refused_response.body), "garage_unavailable");
        assert!(!refused_response.body.contains(TOKEN));
    }

    async fn exchange_bytes(app: &App, request: Request<Body>) -> (StatusCode, Vec<u8>) {
        let response = router(app.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        (status, bytes.to_vec())
    }

    fn drive_letter_prefix(name: &str) -> bool {
        name.split(['/', '\\']).any(|segment| {
            let bytes = segment.as_bytes();
            bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
        })
    }

    fn collision_suffix(name: &str) -> bool {
        let file = name.rsplit('/').next().unwrap_or(name);
        if file.ends_with("-2") {
            return true;
        }
        file.rsplit_once('.')
            .is_some_and(|(stem, _)| stem.ends_with("-2"))
    }

    #[tokio::test]
    async fn archive_token_rejects_empty_or_missing_keys() {
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, "http://127.0.0.1:9", true).await;
        let (admin, _) = login(&app).await;
        for (body, code, message) in [
            ("{}", "invalid_keys", "keys must be an array of strings"),
            (
                r#"{"keys":[]}"#,
                "keys_required",
                "At least one key is required",
            ),
            (
                r#"{"keys":[1]}"#,
                "invalid_keys",
                "keys must be an array of strings",
            ),
        ] {
            let response = exchange(
                &app,
                request(
                    "POST",
                    "/api/buckets/bkt-1/archive-token",
                    Some(body),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(&response, StatusCode::BAD_REQUEST, code, message);
            assert!(!response.body.contains("\"token\""), "{}", response.body);
        }
    }

    #[tokio::test]
    async fn archive_token_rejects_reuse_and_cleans_parent_segments() {
        let mock = S3Mock::start(|line| {
            let key = object_key_of(line);
            if key.contains("missing") {
                return head_missing();
            }
            if key.contains("..") {
                return object_bytes("application/octet-stream", "parent-secret");
            }
            object_bytes("application/octet-stream", "drive-secret")
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let blocked = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/archive-token",
                Some(&json!({ "keys": ["../secret.txt"] }).to_string()),
                Some(&blocked),
            ),
        )
        .await;
        assert_eq!(denied.status, StatusCode::FORBIDDEN, "{}", denied.body);

        let created_user = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": "viewer horse",
                        "role": "viewer",
                        "can_download": true
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created_user.status, StatusCode::CREATED, "{}", created_user.body);
        let owner = sign_in(&app, "Cara", "viewer horse").await;
        let issued = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/archive-token",
                Some(
                    &json!({
                        "keys": ["../secret.txt", "C:/secret.txt", "missing.txt"]
                    })
                    .to_string(),
                ),
                Some(&owner),
            ),
        )
        .await;
        assert_eq!(issued.status, StatusCode::OK, "{}", issued.body);
        let token = serde_json::from_str::<Value>(&issued.body).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let archive_path = format!("/api/buckets/bkt-1/archive?token={token}");
        let other = exchange(&app, request("GET", &archive_path, None, Some(&admin))).await;
        assert_eq!(other.status, StatusCode::FORBIDDEN, "{}", other.body);

        let (status, bytes) = exchange_bytes(
            &app,
            request("GET", &archive_path, None, Some(&owner)),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("zip");
        let mut names = Vec::new();
        let mut errors = String::new();
        for index in 0..archive.len() {
            let mut file = archive.by_index(index).unwrap();
            let name = file.name().unwrap().into_owned();
            if name == "_errors.txt" {
                file.read_to_string(&mut errors).unwrap();
            }
            names.push(name);
        }
        let mut secret = archive.by_name("secret.txt").unwrap();
        let mut secret_body = String::new();
        secret.read_to_string(&mut secret_body).unwrap();
        assert_eq!(secret_body, "parent-secret");
        assert!(names.iter().any(|name| name == "secret.txt"), "{names:?}");
        assert!(names.iter().any(|name| collision_suffix(name)), "{names:?}");
        assert!(
            names
                .iter()
                .all(|name| !name.contains("..") && !drive_letter_prefix(name)),
            "{names:?}"
        );
        assert!(errors.contains("missing.txt"), "{errors}");
        assert!(
            names
                .iter()
                .filter(|name| name.as_str() != "_errors.txt")
                .all(|name| !name.contains("missing")),
            "{names:?}"
        );

        let again = exchange(&app, request("GET", &archive_path, None, Some(&owner))).await;
        assert_eq!(again.status, StatusCode::NOT_FOUND, "{}", again.body);
        assert!(!crate::zip::token_is_fresh(60));
        assert!(crate::zip::token_is_fresh(59));
    }

    #[tokio::test]
    async fn archive_starts_the_zip_before_the_second_object_is_fully_read() {
        let hold = Arc::new(GetHold {
            key: "a/two.txt".to_string(),
            release: AtomicBool::new(false),
            early: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        });
        let mock = S3Mock::start_holding_get(
            |line| {
                let body = if object_key_of(line) == "a/two.txt" {
                    "two-body"
                } else {
                    "one-body"
                };
                object_bytes("text/plain", body)
            },
            Arc::clone(&hold),
        )
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let issued = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/archive-token",
                Some(&json!({ "keys": ["a/one.txt", "a/two.txt"] }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(issued.status, StatusCode::OK, "{}", issued.body);
        let token = serde_json::from_str::<Value>(&issued.body).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let archive_path = format!("/api/buckets/bkt-1/archive?token={token}");
        let response = router(app.clone())
            .oneshot(request("GET", &archive_path, None, Some(&admin)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let disposition = response
            .headers()
            .get("content-disposition")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let had_length = response.headers().get("content-length").is_some();
        let mut body = std::pin::pin!(response.into_body());
        let mut bytes = Vec::new();
        let mut released = false;
        while let Some(frame) =
            std::future::poll_fn(|cx| HttpBody::poll_frame(body.as_mut(), cx)).await
        {
            let frame = frame.expect("archive frame");
            let Ok(chunk) = frame.into_data() else {
                continue;
            };
            if !released && !chunk.is_empty() {
                released = true;
                hold.release.store(true, Ordering::SeqCst);
                hold.notify.notify_waiters();
            }
            bytes.extend_from_slice(&chunk);
        }
        assert!(released, "archive body had no data");
        assert!(
            !hold.early.load(Ordering::SeqCst),
            "two.txt was released before any archive body byte"
        );
        assert!(!had_length, "archive response buffered a content-length");
        assert_eq!(content_type, "application/zip");
        assert!(
            disposition.contains("archive.zip"),
            "{disposition}"
        );
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("zip");
        assert_eq!(archive.len(), 2);
        assert!(archive.by_name("_errors.txt").is_err());
        {
            let mut file = archive.by_name("one.txt").unwrap();
            assert_eq!(file.compression(), zip::CompressionMethod::Stored);
            let mut text = String::new();
            file.read_to_string(&mut text).unwrap();
            assert_eq!(text, "one-body");
        }
        let mut file = archive.by_name("two.txt").unwrap();
        assert_eq!(file.compression(), zip::CompressionMethod::Stored);
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(text, "two-body");
    }
}
