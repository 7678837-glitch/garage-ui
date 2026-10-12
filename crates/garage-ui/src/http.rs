use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::get;
use serde::Serialize;

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
        .route("/readyz", get(readyz));
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
    response
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
}
