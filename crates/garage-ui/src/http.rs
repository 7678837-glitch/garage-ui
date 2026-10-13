use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::watch;

use crate::api;
use crate::assets;
use crate::redact::redact;
use crate::state::App;
use crate::{build_time, commit, version};

#[derive(Serialize)]
struct HealthBody<'a> {
    status: &'static str,
    version: &'a str,
    commit: &'a str,
    build_time: &'a str,
}

#[derive(Serialize)]
struct ReadyBody {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

pub fn router(app: App) -> Router {
    crate::config::maybe_check_updates(app.settings.update_url.as_deref());
    let base = app.settings.base_path.clone();
    let logged = app.clone();
    let site = Router::<App>::new()
        .fallback(get(assets::asset))
        .merge(api::routes(app.clone()));
    let root = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics));
    let root = if base.is_empty() {
        root.merge(site)
    } else {
        root.route("/", get(redirect_to_base)).nest(&base, site)
    };
    root.layer(middleware::from_fn_with_state(logged, request_log))
        .layer(middleware::from_fn(security_headers))
        .with_state(app)
}

async fn redirect_to_base(axum::extract::State(app): axum::extract::State<App>) -> Response {
    Response::builder()
        .status(StatusCode::MOVED_PERMANENTLY)
        .header(header::LOCATION, app.settings.base_path.as_str())
        .body(Body::empty())
        .unwrap()
}

async fn healthz() -> axum::Json<HealthBody<'static>> {
    axum::Json(HealthBody {
        status: "ok",
        version: version(),
        commit: commit(),
        build_time: build_time(),
    })
}

async fn readyz(
    axum::extract::State(app): axum::extract::State<App>,
) -> (StatusCode, axum::Json<ReadyBody>) {
    if sqlx::query("SELECT 1").execute(&app.db).await.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(ReadyBody {
                status: "unavailable",
                reason: Some("database"),
            }),
        );
    }
    if crate::proxy::garage_answered(&app).await {
        return (
            StatusCode::OK,
            axum::Json(ReadyBody {
                status: "ready",
                reason: None,
            }),
        );
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        axum::Json(ReadyBody {
            status: "unavailable",
            reason: Some("garage"),
        }),
    )
}

async fn request_log(
    axum::extract::State(app): axum::extract::State<App>,
    request: Request,
    next: Next,
) -> Response {
    let id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(new_request_id);
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let started = std::time::Instant::now();
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&id) {
        response.headers_mut().insert("x-request-id", value);
    }
    let status = response.status();
    let line = redact(
        &format!("method={method} path={path} status={status} request_id={id}"),
        &app.settings.redact_secrets,
    );
    app.record_access(&line);
    let path = redact(&path, &app.settings.redact_secrets);
    tracing::info!(request_id = %id, method = %method, path = %path, %status, "request");
    app.observe_http(started.elapsed().as_secs_f64());
    response
}

async fn metrics(
    axum::extract::State(app): axum::extract::State<App>,
    headers: HeaderMap,
) -> Response {
    if !metrics_allowed(&app, &headers).await {
        return crate::error::ApiError::unauthorized().into_response();
    }
    Response::builder()
        .header(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )
        .body(Body::from(app.metrics_text()))
        .unwrap()
}

async fn metrics_allowed(app: &App, headers: &HeaderMap) -> bool {
    if let Some(expected) = app.settings.metrics_token.as_deref()
        && let Some(presented) = bearer(headers)
        && crate::util::ct_eq(presented, expected)
    {
        return true;
    }
    crate::session::authenticate(app, headers, "127.0.0.1")
        .await
        .is_ok()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if !headers.contains_key("content-security-policy") {
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static(
                "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
            ),
        );
    }
    if !headers.contains_key("x-frame-options") {
        headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    }
    if !headers.contains_key("referrer-policy") {
        headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    }
    if !headers.contains_key("x-content-type-options") {
        headers.insert(
            "x-content-type-options",
            HeaderValue::from_static("nosniff"),
        );
    }
    response
}

fn new_request_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

const DEFAULT_HEADER_READ_SECS: u64 = 10;
const DEFAULT_IDLE_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 365 * 24 * 60 * 60;

pub(crate) struct Server {
    pub(crate) header_read_timeout: Duration,
    pub(crate) idle_timeout: Duration,
    pub(crate) builder: Builder<TokioExecutor>,
}

impl Server {
    pub(crate) fn from_env() -> Self {
        let mut server = Self {
            header_read_timeout: timeout_from_env(
                "GARAGE_HEADER_READ_TIMEOUT_SECS",
                DEFAULT_HEADER_READ_SECS,
            ),
            idle_timeout: timeout_from_env("GARAGE_IDLE_TIMEOUT_SECS", DEFAULT_IDLE_SECS),
            builder: Builder::new(TokioExecutor::new()),
        };
        let header_read_timeout = server.header_read_timeout;
        // A total request timeout would abort an upload or download that is still moving bytes.
        server
            .builder
            .http1()
            .timer(TokioTimer::new())
            .header_read_timeout(Some(header_read_timeout));
        server
    }
}

fn timeout_from_env(name: &str, default_secs: u64) -> Duration {
    let secs = std::env::var(name)
        .ok()
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|secs| (1..=MAX_TIMEOUT_SECS).contains(secs))
        .unwrap_or(default_secs);
    Duration::from_secs(secs)
}

pub async fn serve_http(
    listener: tokio::net::TcpListener,
    app: App,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    let server = Server::from_env();
    let routes = router(app);
    let (signal_tx, signal_rx) = watch::channel(());
    tokio::spawn(async move {
        shutdown.await;
        drop(signal_rx);
    });
    let (close_tx, close_rx) = watch::channel(());

    loop {
        let accepted = tokio::select! {
            result = listener.accept() => result,
            _ = signal_tx.closed() => break,
        };
        let (stream, remote) = match accepted {
            Ok(pair) => pair,
            Err(error) => {
                if is_connection_error(&error) {
                    continue;
                }
                tracing::error!(%error, "accept failed");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        let io = TokioIo::new(IdleIo::new(stream, server.idle_timeout));
        let service =
            TowerToHyperService::new(routes.clone().layer(axum::Extension(ConnectInfo(remote))));
        let builder = server.builder.clone();
        let signal_tx = signal_tx.clone();
        let close_rx = close_rx.clone();
        tokio::spawn(async move {
            let mut connection =
                std::pin::pin!(builder.serve_connection_with_upgrades(io, service));
            let mut shutting_down = false;
            loop {
                tokio::select! {
                    result = connection.as_mut() => {
                        if let Err(error) = result {
                            tracing::debug!(%error, "connection closed");
                        }
                        break;
                    }
                    _ = signal_tx.closed(), if !shutting_down => {
                        shutting_down = true;
                        connection.as_mut().graceful_shutdown();
                    }
                }
            }
            drop(close_rx);
        });
    }

    drop(close_rx);
    drop(listener);
    close_tx.closed().await;
    Ok(())
}

fn is_connection_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    )
}

struct IdleIo<T> {
    inner: T,
    idle: Duration,
    sleep: Pin<Box<tokio::time::Sleep>>,
}

impl<T> IdleIo<T> {
    fn new(inner: T, idle: Duration) -> Self {
        Self {
            inner,
            idle,
            sleep: Box::pin(tokio::time::sleep(idle)),
        }
    }

    fn arm(&mut self) {
        self.sleep
            .as_mut()
            .reset(tokio::time::Instant::now() + self.idle);
    }

    fn timed_out(&mut self, cx: &mut Context<'_>) -> bool {
        self.sleep.as_mut().poll(cx).is_ready()
    }
}

fn idle_expired() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "connection idle timeout")
}

impl<T: AsyncRead + Unpin> AsyncRead for IdleIo<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Pending => {
                if this.timed_out(cx) {
                    Poll::Ready(Err(idle_expired()))
                } else {
                    Poll::Pending
                }
            }
            Poll::Ready(Ok(())) => {
                if buf.filled().len() > before {
                    this.arm();
                }
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for IdleIo<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_write(cx, buf) {
            Poll::Pending => {
                if this.timed_out(cx) {
                    Poll::Ready(Err(idle_expired()))
                } else {
                    Poll::Pending
                }
            }
            Poll::Ready(Ok(0)) => Poll::Ready(Ok(0)),
            Poll::Ready(Ok(n)) => {
                this.arm();
                Poll::Ready(Ok(n))
            }
            other => other,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_flush(cx) {
            Poll::Pending => {
                if this.timed_out(cx) {
                    Poll::Ready(Err(idle_expired()))
                } else {
                    Poll::Pending
                }
            }
            other => other,
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_shutdown(cx) {
            Poll::Pending => {
                if this.timed_out(cx) {
                    Poll::Ready(Err(idle_expired()))
                } else {
                    Poll::Pending
                }
            }
            other => other,
        }
    }
}

pub fn shutdown_wait() -> Duration {
    Duration::from_secs(30)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn healthz_is_ok_and_carries_request_id() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let response = router(app)
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .header("x-request-id", "req-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get("x-request-id").unwrap(), "req-1");
        assert!(
            response
                .headers()
                .get("content-security-policy")
                .unwrap()
                .to_str()
                .unwrap()
                .contains("default-src 'self'")
        );
        assert_eq!(
            response.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["version"], version());
        assert_eq!(body["commit"], commit());
        assert_eq!(body["build_time"], build_time());
    }

    #[tokio::test]
    async fn readyz_requires_database_and_garage() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let (status, body) = readyz(&app).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            serde_json::json!({"status": "unavailable", "reason": "garage"})
        );

        let down_dir = crate::util::temp_dir();
        let down = crate::state::test_app_with(
            &down_dir,
            &[
                ("GARAGE_ADMIN_URL", "http://127.0.0.1:9"),
                ("GARAGE_ADMIN_TOKEN", "test-token-value1"),
            ],
            crate::limit::test_quota(),
        )
        .await;
        let (status, body) = readyz(&down).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            serde_json::json!({"status": "unavailable", "reason": "garage"})
        );

        down.db.close().await;
        let (status, body) = readyz(&down).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            serde_json::json!({"status": "unavailable", "reason": "database"})
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0_u8; 1024];
            loop {
                let read = socket.read(&mut tmp).await.unwrap();
                if read == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..read]);
                if buf.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let payload = b"nope";
            let response = format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.write_all(payload).await.unwrap();
        });
        let url = format!("http://127.0.0.1:{port}");
        let live_dir = crate::util::temp_dir();
        let live = crate::state::test_app_with(
            &live_dir,
            &[
                ("GARAGE_ADMIN_URL", url.as_str()),
                ("GARAGE_ADMIN_TOKEN", "test-token-value1"),
            ],
            crate::limit::test_quota(),
        )
        .await;
        let (status, body) = readyz(&live).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!({"status": "ready"}));
    }

    async fn readyz(app: &App) -> (StatusCode, serde_json::Value) {
        let response = router(app.clone())
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, body)
    }

    #[tokio::test]
    async fn root_serves_index_and_missing_asset_is_404() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let app_for_missing = app.clone();
        let response = router(app)
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get("location").is_none());
        assert!(
            response
                .headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let html = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(html.contains("<base href=\"/\">"));
        let reference = first_asset_reference(&html);
        assert!(!reference.starts_with('/'), "{reference}");
        let asset_path = asset_request_path("", &reference);
        let asset = router(app_for_missing.clone())
            .oneshot(
                Request::builder()
                    .uri(&asset_path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(asset.status(), StatusCode::OK, "{asset_path}");
        let missing = router(app_for_missing)
            .oneshot(
                Request::builder()
                    .uri("/missing-asset.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn base_path_serves_a_deep_route_and_redirects_the_root() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app_with(
            &dir,
            &[("BASE_PATH", "/admin")],
            crate::limit::test_quota(),
        )
        .await;
        let root = router(app.clone())
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(root.status(), StatusCode::MOVED_PERMANENTLY);
        assert_eq!(root.headers().get("location").unwrap(), "/admin");
        let health = router(app.clone())
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        let deep = router(app.clone())
            .oneshot(
                Request::builder()
                    .uri("/admin/buckets/photos")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deep.status(), StatusCode::OK);
        assert!(
            deep.headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
        let bytes = axum::body::to_bytes(deep.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let html = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(html.matches("<base ").count(), 1);
        assert!(html.contains("<base href=\"/admin/\">"));
        let reference = first_asset_reference(&html);
        assert!(
            reference.starts_with("./") || reference.starts_with("assets/"),
            "{reference}"
        );
        let asset_path = asset_request_path("/admin", &reference);
        let asset = router(app)
            .oneshot(
                Request::builder()
                    .uri(&asset_path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(asset.status(), StatusCode::OK, "{asset_path}");
        let content_type = asset
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            content_type.starts_with("text/javascript") || content_type.starts_with("text/css"),
            "{content_type}"
        );
    }

    fn first_asset_reference(html: &str) -> String {
        let start = html.find("assets/").expect("index references an asset");
        let prefix = html[..start].rfind('"').expect("asset quote");
        let value = &html[prefix + 1..];
        let end = value.find('"').expect("asset end");
        value[..end].to_string()
    }

    fn asset_request_path(base: &str, reference: &str) -> String {
        let relative = reference
            .strip_prefix("./")
            .unwrap_or(reference)
            .trim_start_matches('/');
        format!("{base}/{relative}")
    }

    #[test]
    fn shutdown_wait_is_thirty_seconds() {
        assert_eq!(shutdown_wait(), Duration::from_secs(30));
    }

    #[tokio::test]
    async fn metrics_requires_a_session_or_the_token() {
        let mut env = std::collections::HashMap::new();
        env.insert(
            "GARAGE_METRICS_TOKEN".to_string(),
            "short-token".to_string(),
        );
        let Err(err) = crate::config::load_map(&env) else {
            panic!("short metrics token must not boot");
        };
        let text = format!("{err:#}");
        assert!(text.contains("拒绝启动"), "{text}");

        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let anonymous = hit(&app, "GET", "/metrics", None, None, None).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            anonymous.json,
            serde_json::json!({"code": "unauthenticated", "message": "Login required"})
        );
        let wrong = hit(
            &app,
            "GET",
            "/metrics",
            None,
            Some("Bearer wrong-metrics-token"),
            None,
        )
        .await;
        assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            wrong.json,
            serde_json::json!({"code": "unauthenticated", "message": "Login required"})
        );

        let setup = hit(
            &app,
            "POST",
            "/api/setup",
            None,
            None,
            Some(r#"{"username":"Ada","password":"correct horse"}"#),
        )
        .await;
        assert_eq!(setup.status, StatusCode::OK, "{}", setup.body);
        let cookie = session_cookie(&setup.set_cookies);
        let metrics = hit(&app, "GET", "/metrics", Some(&cookie), None, None).await;
        assert_eq!(metrics.status, StatusCode::OK, "{}", metrics.body);
        assert_eq!(
            metrics.content_type.as_deref(),
            Some("text/plain; version=0.0.4; charset=utf-8")
        );
        for name in [
            "garage_ui_http_requests_total",
            "garage_ui_http_request_duration_seconds",
            "garage_ui_garage_errors_total",
            "garage_ui_uploads_in_flight",
        ] {
            assert!(
                metrics.body.contains(name),
                "{name} missing\n{}",
                metrics.body
            );
        }
        let requests = sample(&metrics.body, "garage_ui_http_requests_total");
        assert!(requests >= 1, "{}", metrics.body);
        assert_eq!(
            sample(
                &metrics.body,
                "garage_ui_http_request_duration_seconds_bucket{le=\"+Inf\"}"
            ),
            requests,
            "{}",
            metrics.body
        );
        assert_eq!(
            sample(&metrics.body, "garage_ui_uploads_in_flight"),
            0,
            "{}",
            metrics.body
        );

        let token = "metrics-token-ok16";
        let token_dir = crate::util::temp_dir();
        let token_app = crate::state::test_app_with(
            &token_dir,
            &[("GARAGE_METRICS_TOKEN", token)],
            crate::limit::test_quota(),
        )
        .await;
        let by_token = hit(
            &token_app,
            "GET",
            "/metrics",
            None,
            Some(&format!("Bearer {token}")),
            None,
        )
        .await;
        assert_eq!(by_token.status, StatusCode::OK, "{}", by_token.body);
        assert_eq!(
            by_token.content_type.as_deref(),
            Some("text/plain; version=0.0.4; charset=utf-8")
        );

        let down_dir = crate::util::temp_dir();
        let down = crate::state::test_app_with(
            &down_dir,
            &[
                ("GARAGE_ADMIN_URL", "http://127.0.0.1:9"),
                ("GARAGE_ADMIN_TOKEN", "test-token-value1"),
                ("GARAGE_METRICS_TOKEN", token),
            ],
            crate::limit::test_quota(),
        )
        .await;
        let ready = hit(&down, "GET", "/readyz", None, None, None).await;
        assert_eq!(
            ready.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{}",
            ready.body
        );
        let scraped = hit(
            &down,
            "GET",
            "/metrics",
            None,
            Some(&format!("Bearer {token}")),
            None,
        )
        .await;
        assert_eq!(scraped.status, StatusCode::OK, "{}", scraped.body);
        assert!(
            sample(&scraped.body, "garage_ui_garage_errors_total") >= 1,
            "{}",
            scraped.body
        );
    }

    struct Hit {
        status: StatusCode,
        content_type: Option<String>,
        set_cookies: Vec<String>,
        body: String,
        json: serde_json::Value,
    }

    async fn hit(
        app: &App,
        method: &str,
        uri: &str,
        cookie: Option<&str>,
        authorization: Option<&str>,
        body: Option<&str>,
    ) -> Hit {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        if let Some(authorization) = authorization {
            builder = builder.header(header::AUTHORIZATION, authorization);
        }
        if body.is_some() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        let response = router(app.clone())
            .oneshot(
                builder
                    .body(Body::from(body.unwrap_or("").to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let set_cookies = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_string))
            .collect();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        let json = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
        Hit {
            status,
            content_type,
            set_cookies,
            body,
            json,
        }
    }

    fn session_cookie(set_cookies: &[String]) -> String {
        set_cookies
            .iter()
            .find_map(|line| {
                let pair = line.split(';').next()?.trim();
                let (name, value) = pair.split_once('=')?;
                (name == "garage_session").then(|| format!("garage_session={value}"))
            })
            .expect("setup set garage_session")
    }

    fn sample(body: &str, name: &str) -> u64 {
        body.lines()
            .find_map(|line| {
                let rest = line.strip_prefix(name)?;
                if rest.starts_with('_') || rest.starts_with('{') {
                    return None;
                }
                rest.trim().parse().ok()
            })
            .unwrap_or_else(|| panic!("missing {name}\n{body}"))
    }
}
