use std::time::Duration;

use axum::Router;
use axum::extract::Request;
use axum::http::HeaderValue;
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

pub fn router(app: App) -> Router {
    let base = app.settings.base_path.clone();
    let logged = app.clone();
    let site = Router::<App>::new()
        .fallback(get(assets::asset))
        .merge(api::routes(app.clone()));
    let root = if base.is_empty() {
        Router::new().route("/healthz", get(healthz)).merge(site)
    } else {
        Router::new()
            .route("/healthz", get(healthz))
            .nest(&base, site)
    };
    root.layer(middleware::from_fn_with_state(logged, request_log))
        .layer(middleware::from_fn(security_headers))
        .with_state(app)
}

async fn healthz() -> axum::Json<HealthBody<'static>> {
    axum::Json(HealthBody {
        status: "ok",
        version: version(),
        commit: commit(),
        build_time: build_time(),
    })
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
    async fn root_serves_index_and_missing_asset_is_404() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let app_for_missing = app.clone();
        let response = router(app)
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response
                .headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
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

    #[test]
    fn shutdown_wait_is_thirty_seconds() {
        assert_eq!(shutdown_wait(), Duration::from_secs(30));
    }
}
