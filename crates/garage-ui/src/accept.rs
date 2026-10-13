use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::http::{HeaderMap, Request, StatusCode};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tower::ServiceExt;

use crate::limit::test_quota;
use crate::router;
use crate::state::{self, App, Fixture};

const PASSWORD: &str = "correct horse";
const OTHER_PASSWORD: &str = "viewer horse";
const NEW_PASSWORD: &str = "updated horse";

struct Session {
    id: String,
    csrf: String,
    raw: Vec<String>,
}

struct Exchange {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
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
    let mut raw = Vec::new();
    for value in headers.get_all("set-cookie") {
        let text = value.to_str().expect("cookie").to_string();
        let pair = text.split(';').next().expect("pair");
        let (name, val) = pair.split_once('=').expect("equals");
        if name == "garage_session" {
            id = Some(val.to_string());
        }
        if name == "garage_csrf" {
            csrf = Some(val.to_string());
        }
        raw.push(text);
    }
    Session {
        id: id.expect("session cookie"),
        csrf: csrf.expect("csrf cookie"),
        raw,
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

fn with_peer(mut request: Request<Body>, ip: [u8; 4]) -> Request<Body> {
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from((ip, 9))));
    request
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

fn code_of(body: &str) -> String {
    serde_json::from_str::<Value>(body).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_string()
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

async fn assert_open(app: &App, session: &Session) {
    let response = exchange(app, request("GET", "/api/config", None, Some(session))).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.body);
}

async fn assert_closed(app: &App, session: &Session) {
    let response = exchange(app, request("GET", "/api/config", None, Some(session))).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&response.body), "unauthenticated");
}

fn logs(app: &App) -> String {
    app.log_sink.lock().expect("logs").join("\n")
}

async fn audit_text(app: &App) -> String {
    let mut rows = crate::db::recent_audit(&app.db).await.unwrap();
    rows.reverse();
    rows.iter()
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
                row.status,
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_clean(label: &str, text: &str) {
    assert!(!text.contains(PASSWORD), "{label} leaked the password");
    assert!(!text.contains(OTHER_PASSWORD), "{label} leaked a password");
    assert!(!text.contains(NEW_PASSWORD), "{label} leaked a password");
    assert!(
        !text.contains("$2a$") && !text.contains("$2b$") && !text.contains("$2y$"),
        "{label} leaked a hash"
    );
}

async fn setup_admin(app: &App) -> Session {
    let response = exchange(
        app,
        request(
            "POST",
            "/api/setup",
            Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
            None,
        ),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.body);
    let session = session_from(&response.headers);
    assert!(!response.body.contains(&session.id));
    assert_clean("setup", &response.body);
    session
}

async fn login(
    app: &App,
    username: &str,
    password: &str,
    presented: Option<&Session>,
    peer: Option<[u8; 4]>,
) -> Exchange {
    let mut request = request(
        "POST",
        "/api/auth/login",
        Some(&json!({ "username": username, "password": password }).to_string()),
        presented,
    );
    if let Some(peer) = peer {
        request = with_peer(request, peer);
    }
    exchange(app, request).await
}

async fn login_ok(app: &App, username: &str, password: &str) -> Session {
    let response = login(app, username, password, None, None).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.body);
    session_from(&response.headers)
}

async fn setup_from(app: &App, peer: [u8; 4]) -> Exchange {
    exchange(
        app,
        with_peer(
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                None,
            ),
            peer,
        ),
    )
    .await
}

async fn failed_password_change(app: &App, session: &Session) -> Exchange {
    exchange(
        app,
        request(
            "POST",
            "/api/auth/change-password",
            Some(
                &json!({
                    "current_password": "wrong horse",
                    "new_password": NEW_PASSWORD
                })
                .to_string(),
            ),
            Some(session),
        ),
    )
    .await
}

async fn user_id(app: &App, session: &Session, username: &str) -> i64 {
    let response = exchange(app, request("GET", "/api/users", None, Some(session))).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.body);
    assert_clean("users", &response.body);
    let page: Value = serde_json::from_str(&response.body).unwrap();
    let users = page["items"].as_array().unwrap();
    users
        .iter()
        .find(|user| user["username"] == username)
        .unwrap()[&"id"]
        .as_i64()
        .unwrap()
}

fn cookie_line<'a>(session: &'a Session, name: &str) -> &'a str {
    session
        .raw
        .iter()
        .find(|line| line.starts_with(&format!("{name}=")))
        .map(String::as_str)
        .expect(name)
}

#[tokio::test]
async fn setup_is_once_and_keys_require_a_session() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let status = exchange(&app, request("GET", "/api/auth/status", None, None)).await;
    assert_eq!(status.status, StatusCode::OK);
    assert!(!status.body.contains("\"authenticated\":true"));
    let value: Value = serde_json::from_str(&status.body).unwrap();
    assert_eq!(value["initialized"], false);
    assert_eq!(value["authenticated"], false);

    let keys = exchange(&app, request("GET", "/api/keys", None, None)).await;
    assert_eq!(keys.status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&keys.body), "unauthenticated");

    let bad_name = exchange(
        &app,
        request(
            "POST",
            "/api/setup",
            Some(&json!({ "username": "bad name", "password": PASSWORD }).to_string()),
            None,
        ),
    )
    .await;
    assert_eq!(bad_name.status, StatusCode::BAD_REQUEST);
    assert_eq!(code_of(&bad_name.body), "invalid_username");

    let short = exchange(
        &app,
        request(
            "POST",
            "/api/setup",
            Some(&json!({ "username": "Ada", "password": "short" }).to_string()),
            None,
        ),
    )
    .await;
    assert_eq!(short.status, StatusCode::BAD_REQUEST);
    assert_eq!(code_of(&short.body), "password_invalid");

    let session = setup_admin(&app).await;
    let again = exchange(
        &app,
        request(
            "POST",
            "/api/setup",
            Some(&json!({ "username": "Other", "password": "x" }).to_string()),
            None,
        ),
    )
    .await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(code_of(&again.body), "already_initialized");

    let authed = exchange(
        &app,
        request("GET", "/api/auth/status", None, Some(&session)),
    )
    .await;
    let authed_body: Value = serde_json::from_str(&authed.body).unwrap();
    assert_eq!(authed_body["authenticated"], true);
    assert_eq!(authed_body["username"], "Ada");
    assert_eq!(authed_body["can_download"], true);
    assert_eq!(authed_body["can_share"], true);

    let anon = exchange(&app, request("GET", "/api/auth/status", None, None)).await;
    assert_eq!(
        serde_json::from_str::<Value>(&anon.body).unwrap()["authenticated"],
        false
    );

    let missing_garage = exchange(&app, request("GET", "/api/keys", None, Some(&session))).await;
    assert_eq!(missing_garage.status, StatusCode::BAD_GATEWAY);
    assert_eq!(code_of(&missing_garage.body), "garage_unavailable");
}

#[tokio::test]
async fn api_response_allows_no_cross_origin_access() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let forbidden = [
        "access-control-allow-origin",
        "access-control-allow-credentials",
    ];
    let probes = [
        (
            "GET",
            with_peer(
                Request::builder()
                    .method("GET")
                    .uri("/api/auth/status")
                    .header("Origin", "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
                [127, 0, 0, 1],
            ),
        ),
        (
            "OPTIONS",
            with_peer(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/api/auth/status")
                    .header("Origin", "https://evil.example")
                    .header("Access-Control-Request-Method", "GET")
                    .body(Body::empty())
                    .unwrap(),
                [127, 0, 0, 1],
            ),
        ),
    ];
    for (method, request) in probes {
        let response = exchange(&app, request).await;
        for name in forbidden {
            let present = response
                .headers
                .keys()
                .any(|key| key.as_str().eq_ignore_ascii_case(name));
            assert!(!present, "{method} /api/auth/status sent {name}");
        }
    }
}

#[tokio::test]
async fn cookies_are_secure_by_default_and_csrf_cookie_is_readable() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let session = setup_admin(&app).await;
    let session_cookie = cookie_line(&session, "garage_session");
    let csrf_cookie = cookie_line(&session, "garage_csrf");
    assert!(session_cookie.contains("HttpOnly"));
    assert!(session_cookie.contains("SameSite=Lax"));
    assert!(session_cookie.contains("; Secure"));
    assert!(session_cookie.contains("Path=/; Max-Age="));
    assert!(!csrf_cookie.contains("HttpOnly"));
    assert!(csrf_cookie.contains("SameSite=Lax"));
    assert!(csrf_cookie.contains("; Secure"));
    assert!(csrf_cookie.contains("Path=/; Max-Age="));

    let loose = state::test_app_with(
        &dir.join("loose"),
        &[("COOKIE_SECURE", "false")],
        test_quota(),
    )
    .await;
    let loose_session = setup_admin(&loose).await;
    assert!(!cookie_line(&loose_session, "garage_session").contains("; Secure"));
    assert!(!cookie_line(&loose_session, "garage_csrf").contains("; Secure"));
}

#[tokio::test]
async fn base_path_mounts_the_api_and_keeps_health_at_the_root() {
    let dir = crate::util::temp_dir();
    let app = state::test_app_with(&dir, &[("BASE_PATH", "/console")], test_quota()).await;
    let health = exchange(&app, request("GET", "/healthz", None, None)).await;
    assert_eq!(health.status, StatusCode::OK);
    assert!(health.body.contains(crate::version()));
    let response = exchange(
        &app,
        request(
            "POST",
            "/console/api/setup",
            Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
            None,
        ),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.body);
    let session = session_from(&response.headers);
    assert!(cookie_line(&session, "garage_session").contains("Path=/console; Max-Age="));
}

#[tokio::test]
async fn failed_login_is_audited_without_the_password() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    setup_admin(&app).await;
    let failed = login(&app, "Ada", "wrong horse", None, Some([203, 0, 113, 9])).await;
    assert_eq!(failed.status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&failed.body), "invalid_credentials");
    assert!(!failed.body.contains("wrong horse"));
    assert_clean("login body", &failed.body);
    let audit = audit_text(&app).await;
    assert!(audit.contains("203.0.113.9"));
    assert!(audit.contains("invalid_credentials"));
    assert!(!audit.contains("wrong horse"));
    assert_clean("audit", &audit);
    assert!(!logs(&app).contains("wrong horse"));
    assert_clean("log", &logs(&app));
    let queried = exchange(
        &app,
        request(
            "GET",
            "/api/auth/status?x=not-a-secret-but-query",
            None,
            None,
        ),
    )
    .await;
    assert_eq!(queried.status, StatusCode::OK);
    assert!(!logs(&app).contains("not-a-secret-but-query"));
}

fn failed_login_from(peer: [u8; 4], forwarded: &str) -> Request<Body> {
    let mut request = request(
        "POST",
        "/api/auth/login",
        Some(&json!({ "username": "Ada", "password": "wrong horse" }).to_string()),
        None,
    );
    request
        .headers_mut()
        .insert("x-forwarded-for", forwarded.parse().unwrap());
    with_peer(request, peer)
}

#[tokio::test]
async fn trusted_proxy_uses_the_last_forwarded_hop() {
    let peer = [192, 0, 2, 8];
    let forwarded = "198.51.100.10, 203.0.113.55, ";
    let dir = crate::util::temp_dir();

    let plain = state::test_app(&dir).await;
    setup_admin(&plain).await;
    let plain_failed = exchange(&plain, failed_login_from(peer, forwarded)).await;
    assert_eq!(plain_failed.status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&plain_failed.body), "invalid_credentials");
    assert!(!plain_failed.body.contains("wrong horse"));
    let plain_audit = audit_text(&plain).await;
    assert!(
        plain_audit.contains("Ada 192.0.2.8 failure invalid_credentials"),
        "unset proxy did not record the connection address",
    );
    assert!(
        !plain_audit.contains("198.51.100.10") && !plain_audit.contains("203.0.113.55"),
        "unset proxy recorded a forwarded hop",
    );
    assert_clean("plain audit", &plain_audit);

    let trusted = state::test_app_with(
        &dir.join("trusted"),
        &[("TRUSTED_PROXY", "true")],
        test_quota(),
    )
    .await;
    setup_admin(&trusted).await;
    let trusted_failed = exchange(&trusted, failed_login_from(peer, forwarded)).await;
    assert_eq!(trusted_failed.status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&trusted_failed.body), "invalid_credentials");
    assert!(!trusted_failed.body.contains("wrong horse"));
    let trusted_audit = audit_text(&trusted).await;
    assert!(
        trusted_audit.contains("Ada 203.0.113.55 failure invalid_credentials"),
        "trusted proxy did not record the last forwarded hop",
    );
    assert!(
        !trusted_audit.contains("192.0.2.8") && !trusted_audit.contains("198.51.100.10"),
        "trusted proxy recorded the peer or an earlier hop",
    );
    assert_clean("trusted audit", &trusted_audit);
}

#[tokio::test]
async fn login_rate_limit_is_per_username_and_writes_audit() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    for _ in 0..10 {
        let response = login(&app, "Ada", "wrong horse", None, Some([198, 51, 100, 7])).await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    }
    let blocked = login(&app, "ada", "wrong horse", None, Some([198, 51, 100, 7])).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(code_of(&blocked.body), "rate_limited");
    let retry: u64 = header(&blocked.headers, "retry-after").parse().unwrap();
    assert!(retry >= 1);
    let other = login(&app, "Bea", "wrong horse", None, Some([198, 51, 100, 7])).await;
    assert_eq!(other.status, StatusCode::UNAUTHORIZED);
    tokio::time::sleep(Duration::from_millis(400)).await;
    let again = login(&app, "Ada", "wrong horse", None, Some([198, 51, 100, 7])).await;
    assert_eq!(again.status, StatusCode::UNAUTHORIZED);
    let audit = audit_text(&app).await;
    assert!(audit.contains("rate_limited"));
    assert!(audit.contains("198.51.100.7"));
    assert!(!audit.contains("wrong horse"));
    assert!(!logs(&app).contains("wrong horse"));
    assert_clean("rate audit", &audit);
}

#[tokio::test]
async fn setup_rate_limit_is_per_address() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let peer = [198, 51, 100, 7];
    let other_peer = [203, 0, 113, 9];

    let created = setup_from(&app, peer).await;
    assert_eq!(created.status, StatusCode::OK);
    assert_clean("setup", &created.body);

    for _ in 0..9 {
        let conflict = setup_from(&app, peer).await;
        assert_eq!(conflict.status, StatusCode::CONFLICT);
        assert_eq!(code_of(&conflict.body), "already_initialized");
        assert_clean("setup conflict", &conflict.body);
    }

    let blocked = setup_from(&app, peer).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(code_of(&blocked.body), "rate_limited");
    let retry: u64 = header(&blocked.headers, "retry-after").parse().unwrap();
    assert!(retry >= 1);
    assert_clean("setup blocked", &blocked.body);

    let other = setup_from(&app, other_peer).await;
    assert_eq!(other.status, StatusCode::CONFLICT);
    assert_eq!(code_of(&other.body), "already_initialized");
    assert_clean("setup other peer", &other.body);

    tokio::time::sleep(Duration::from_millis(400)).await;
    let again = setup_from(&app, peer).await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(code_of(&again.body), "already_initialized");
    assert_clean("setup after window", &again.body);

    let audit = audit_text(&app).await;
    assert!(
        audit.contains("Ada 198.51.100.7 rate_limited rate_limited POST /api/setup"),
        "setup 429 did not record result rate_limited",
    );
    assert_clean("setup rate audit", &audit);
    assert_clean("setup rate log", &logs(&app));
}

#[tokio::test]
async fn password_rate_limit_is_per_username() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let ada = setup_admin(&app).await;

    for _ in 0..10 {
        let response = failed_password_change(&app, &ada).await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&response.body), "invalid_credentials");
        assert!(
            !response.body.contains("wrong horse"),
            "body leaked a password"
        );
        assert_clean("password change", &response.body);
    }

    let blocked = failed_password_change(&app, &ada).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(code_of(&blocked.body), "rate_limited");
    let retry: u64 = header(&blocked.headers, "retry-after").parse().unwrap();
    assert!(retry >= 1);
    assert!(
        !blocked.body.contains("wrong horse"),
        "body leaked a password"
    );
    assert_clean("password blocked", &blocked.body);

    let created = exchange(
        &app,
        request(
            "POST",
            "/api/users",
            Some(
                &json!({
                    "username": "Bea",
                    "password": OTHER_PASSWORD,
                    "role": "admin"
                })
                .to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED);
    assert_clean("create user", &created.body);
    let bea = login_ok(&app, "Bea", OTHER_PASSWORD).await;
    let other = failed_password_change(&app, &bea).await;
    assert_eq!(other.status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&other.body), "invalid_credentials");
    assert!(
        !other.body.contains("wrong horse"),
        "body leaked a password"
    );
    assert_clean("other user", &other.body);

    tokio::time::sleep(Duration::from_millis(400)).await;
    let again = failed_password_change(&app, &ada).await;
    assert_eq!(again.status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&again.body), "invalid_credentials");
    assert!(
        !again.body.contains("wrong horse"),
        "body leaked a password"
    );
    assert_clean("password after window", &again.body);

    let audit = audit_text(&app).await;
    assert!(
        audit.contains("Ada 127.0.0.1 rate_limited rate_limited POST /api/auth/change-password"),
        "password 429 did not record result rate_limited",
    );
    assert!(!audit.contains("wrong horse"), "audit leaked a password");
    assert_clean("password rate audit", &audit);
    assert!(!logs(&app).contains("wrong horse"), "log leaked a password");
    assert_clean("password rate log", &logs(&app));
}

#[tokio::test]
async fn csrf_rejects_a_session_without_a_token_and_logout_clears_it() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let session = setup_admin(&app).await;
    let mut without_token = request("POST", "/api/auth/logout", None, None);
    without_token
        .headers_mut()
        .insert("cookie", cookie_header(&session).parse().unwrap());
    let rejected = exchange(&app, without_token).await;
    assert_eq!(rejected.status, StatusCode::FORBIDDEN);
    assert_eq!(code_of(&rejected.body), "csrf_rejected");
    let still = exchange(
        &app,
        request("GET", "/api/auth/status", None, Some(&session)),
    )
    .await;
    assert_eq!(
        serde_json::from_str::<Value>(&still.body).unwrap()["authenticated"],
        true
    );

    let missing = exchange(&app, request("POST", "/api/auth/logout", None, None)).await;
    assert_eq!(missing.status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&missing.body), "unauthenticated");

    let logged_out = exchange(
        &app,
        request("POST", "/api/auth/logout", None, Some(&session)),
    )
    .await;
    assert_eq!(logged_out.status, StatusCode::NO_CONTENT);
    let cleared = session_from(&logged_out.headers);
    assert!(cookie_line(&cleared, "garage_session").contains("Max-Age=0"));
    assert!(cookie_line(&cleared, "garage_csrf").contains("Max-Age=0"));
    let after = exchange(
        &app,
        request("GET", "/api/auth/status", None, Some(&session)),
    )
    .await;
    assert_eq!(
        serde_json::from_str::<Value>(&after.body).unwrap()["authenticated"],
        false
    );
}

#[tokio::test]
async fn login_presenting_a_session_returns_a_new_id_and_retires_the_old_one() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let presented = setup_admin(&app).await;
    let response = login(&app, "Ada", PASSWORD, Some(&presented), None).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.body);
    let rotated = session_from(&response.headers);
    assert_ne!(rotated.id, presented.id);
    assert_closed(&app, &presented).await;
    assert_open(&app, &rotated).await;
}

#[tokio::test]
async fn sessions_survive_reopen_until_the_key_or_password_changes() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let ada = setup_admin(&app).await;
    let bob = login_ok(&app, "Ada", PASSWORD).await;
    assert_ne!(ada.id, bob.id);
    let ada_status = exchange(&app, request("GET", "/api/auth/status", None, Some(&ada))).await;
    let bob_status = exchange(&app, request("GET", "/api/auth/status", None, Some(&bob))).await;
    assert_eq!(
        serde_json::from_str::<Value>(&ada_status.body).unwrap()["authenticated"],
        true
    );
    assert_eq!(
        serde_json::from_str::<Value>(&bob_status.body).unwrap()["authenticated"],
        true
    );

    let expires_before: i64 = sqlx::query_scalar("SELECT expires_at FROM sessions WHERE id = ?")
        .bind(&ada.id)
        .fetch_one(&app.db)
        .await
        .unwrap();
    sqlx::query("UPDATE sessions SET last_seen_at = last_seen_at - 30 WHERE id = ?")
        .bind(&ada.id)
        .execute(&app.db)
        .await
        .unwrap();
    let seen_before: i64 = sqlx::query_scalar("SELECT last_seen_at FROM sessions WHERE id = ?")
        .bind(&ada.id)
        .fetch_one(&app.db)
        .await
        .unwrap();
    let touched = exchange(&app, request("GET", "/api/auth/status", None, Some(&ada))).await;
    assert_eq!(touched.status, StatusCode::OK);
    let expires_after: i64 = sqlx::query_scalar("SELECT expires_at FROM sessions WHERE id = ?")
        .bind(&ada.id)
        .fetch_one(&app.db)
        .await
        .unwrap();
    let seen_after: i64 = sqlx::query_scalar("SELECT last_seen_at FROM sessions WHERE id = ?")
        .bind(&ada.id)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(expires_before, expires_after);
    assert!(seen_after > seen_before);

    let changed = exchange(
        &app,
        request(
            "POST",
            "/api/auth/change-password",
            Some(
                &json!({ "current_password": PASSWORD, "new_password": NEW_PASSWORD }).to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
    let ada_new = session_from(&changed.headers);
    assert_ne!(ada_new.id, ada.id);
    assert_closed(&app, &ada).await;
    assert_closed(&app, &bob).await;
    assert_open(&app, &ada_new).await;
    assert!(!changed.body.contains(&ada_new.id));
    assert_clean("password change", &changed.body);
    assert_clean("password change log", &logs(&app));

    app.db.close().await;
    drop(app);
    let reopened = state::test_app(&dir).await;
    assert_open(&reopened, &ada_new).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("session.key"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(
            std::fs::metadata(dir.join("session.key")).unwrap().len(),
            48
        );
    }
    reopened.db.close().await;
    drop(reopened);
    std::fs::write(dir.join("session.key"), [0x11_u8; 48]).unwrap();
    let replaced = state::test_app(&dir).await;
    assert_closed(&replaced, &ada_new).await;

    let idle_app = state::test_app(&dir.join("idle")).await;
    let idle_session = setup_admin(&idle_app).await;
    sqlx::query("UPDATE sessions SET last_seen_at = 0")
        .execute(&idle_app.db)
        .await
        .unwrap();
    assert_closed(&idle_app, &idle_session).await;
    let absolute_session = login_ok(&idle_app, "Ada", PASSWORD).await;
    sqlx::query("UPDATE sessions SET expires_at = 1, last_seen_at = ?")
        .bind(crate::util::now_secs())
        .execute(&idle_app.db)
        .await
        .unwrap();
    assert_closed(&idle_app, &absolute_session).await;
}

#[tokio::test]
async fn authenticate_rejects_a_disabled_account_and_a_missing_account() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let first = setup_admin(&app).await;
    let second = login_ok(&app, "Ada", PASSWORD).await;
    assert_ne!(first.id, second.id);
    sqlx::query("UPDATE users SET disabled = 1 WHERE username = 'Ada'")
        .execute(&app.db)
        .await
        .unwrap();
    assert_closed(&app, &first).await;
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id IN (?, ?)")
        .bind(&first.id)
        .bind(&second.id)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(left, 0);

    let orphan = state::test_app(&dir.join("orphan")).await;
    let session = setup_admin(&orphan).await;
    let mut conn = orphan.db.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    let deleted = sqlx::query("DELETE FROM users WHERE username = 'Ada'")
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(deleted.rows_affected(), 1);
    drop(conn);
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id = ?")
        .bind(&session.id)
        .fetch_one(&orphan.db)
        .await
        .unwrap();
    assert_eq!(before, 1);
    assert_closed(&orphan, &session).await;
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id = ?")
        .bind(&session.id)
        .fetch_one(&orphan.db)
        .await
        .unwrap();
    assert_eq!(after, 1);
}

#[tokio::test]
async fn user_admin_locks_self_resets_others_and_hides_hashes() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let ada = setup_admin(&app).await;
    let share = exchange(
        &app,
        request(
            "POST",
            "/api/users",
            Some(
                &json!({
                    "username": "Vera",
                    "password": OTHER_PASSWORD,
                    "role": "viewer",
                    "can_download": false,
                    "can_share": true
                })
                .to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(share.status, StatusCode::BAD_REQUEST);
    assert_eq!(code_of(&share.body), "share_requires_download");

    let created = exchange(
        &app,
        request(
            "POST",
            "/api/users",
            Some(
                &json!({
                    "username": "Bea",
                    "password": OTHER_PASSWORD,
                    "role": "admin",
                    "can_download": true,
                    "can_share": true
                })
                .to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let created_body: Value = serde_json::from_str(&created.body).unwrap();
    assert_eq!(created_body["can_download"], false);
    assert_eq!(created_body["can_share"], false);
    assert_clean("create user", &created.body);
    let bea = login_ok(&app, "Bea", OTHER_PASSWORD).await;
    let ada_id = user_id(&app, &ada, "Ada").await;
    let bea_id = user_id(&app, &ada, "Bea").await;

    let self_disable = exchange(
        &app,
        request(
            "PATCH",
            &format!("/api/users/{ada_id}"),
            Some(&json!({ "disabled": true }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(code_of(&self_disable.body), "cannot_lock_self");
    let self_demote = exchange(
        &app,
        request(
            "PATCH",
            &format!("/api/users/{ada_id}"),
            Some(&json!({ "role": "viewer" }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(code_of(&self_demote.body), "cannot_lock_self");
    let self_delete = exchange(
        &app,
        request("DELETE", &format!("/api/users/{ada_id}"), None, Some(&ada)),
    )
    .await;
    assert_eq!(code_of(&self_delete.body), "cannot_lock_self");
    let self_reset = exchange(
        &app,
        request(
            "POST",
            &format!("/api/users/{ada_id}/reset-password"),
            Some(&json!({ "password": NEW_PASSWORD }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(code_of(&self_reset.body), "cannot_reset_self");

    let removed = exchange(
        &app,
        request("DELETE", &format!("/api/users/{bea_id}"), None, Some(&ada)),
    )
    .await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT);
    assert_closed(&app, &bea).await;

    let vera = exchange(
        &app,
        request(
            "POST",
            "/api/users",
            Some(
                &json!({
                    "username": "Vera",
                    "password": OTHER_PASSWORD,
                    "role": "viewer",
                    "can_download": true,
                    "can_share": true
                })
                .to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(vera.status, StatusCode::CREATED, "{}", vera.body);
    let vera_session = login_ok(&app, "Vera", OTHER_PASSWORD).await;
    let vera_id = user_id(&app, &ada, "Vera").await;
    let disabled = exchange(
        &app,
        request(
            "PATCH",
            &format!("/api/users/{vera_id}"),
            Some(&json!({ "disabled": true }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(disabled.status, StatusCode::OK, "{}", disabled.body);
    assert_closed(&app, &vera_session).await;

    let cara = exchange(
        &app,
        request(
            "POST",
            "/api/users",
            Some(
                &json!({
                    "username": "Cara",
                    "password": OTHER_PASSWORD,
                    "role": "admin"
                })
                .to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(cara.status, StatusCode::CREATED, "{}", cara.body);
    let cara_session = login_ok(&app, "Cara", OTHER_PASSWORD).await;
    let cara_id = user_id(&app, &ada, "Cara").await;
    let reset = exchange(
        &app,
        request(
            "POST",
            &format!("/api/users/{cara_id}/reset-password"),
            Some(&json!({ "password": NEW_PASSWORD }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(reset.status, StatusCode::NO_CONTENT, "{}", reset.body);
    assert_closed(&app, &cara_session).await;
    let cara_new = login_ok(&app, "Cara", NEW_PASSWORD).await;
    let demoted = exchange(
        &app,
        request(
            "PATCH",
            &format!("/api/users/{cara_id}"),
            Some(&json!({ "role": "viewer" }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(demoted.status, StatusCode::OK, "{}", demoted.body);
    assert_closed(&app, &cara_new).await;
}

#[tokio::test]
async fn preview_download_and_zip_follow_the_download_bit() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let ada = setup_admin(&app).await;
    app.fixtures.lock().expect("fixtures").insert(
        "page.html".into(),
        Fixture {
            content_type: "text/html".into(),
            filename: "page.html".into(),
            body: b"SECRET-BYTES".to_vec(),
        },
    );
    app.fixtures.lock().expect("fixtures").insert(
        "icon.svg".into(),
        Fixture {
            content_type: "image/svg+xml".into(),
            filename: "icon.svg".into(),
            body: b"<svg></svg>".to_vec(),
        },
    );
    let created = exchange(
        &app,
        request(
            "POST",
            "/api/users",
            Some(
                &json!({
                    "username": "Vera",
                    "password": OTHER_PASSWORD,
                    "role": "viewer",
                    "can_download": false,
                    "can_share": false
                })
                .to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let vera = login_ok(&app, "Vera", OTHER_PASSWORD).await;
    let denied = exchange(
        &app,
        request(
            "GET",
            "/api/objects/preview?name=page.html",
            None,
            Some(&vera),
        ),
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert!(!denied.body.contains("SECRET-BYTES"));

    let html = exchange(
        &app,
        request(
            "GET",
            "/api/objects/preview?name=page.html",
            None,
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(html.status, StatusCode::OK);
    assert_eq!(
        header(&html.headers, "content-type"),
        "application/octet-stream"
    );
    assert!(header(&html.headers, "content-disposition").contains("attachment"));
    assert!(header(&html.headers, "content-disposition").contains("filename*=UTF-8''page.html"));
    assert_eq!(header(&html.headers, "cache-control"), "private, no-store");
    assert_eq!(header(&html.headers, "x-frame-options"), "SAMEORIGIN");
    assert!(!header(&html.headers, "content-security-policy").contains("default-src"));
    assert_eq!(html.body, "SECRET-BYTES");

    let svg = exchange(
        &app,
        request(
            "GET",
            "/api/objects/download?name=icon.svg",
            None,
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(
        header(&svg.headers, "content-type"),
        "application/octet-stream"
    );
    assert!(header(&svg.headers, "content-disposition").contains("attachment"));
    assert_eq!(header(&svg.headers, "cache-control"), "private, no-store");

    let vera_id = user_id(&app, &ada, "Vera").await;
    let grant = exchange(
        &app,
        request(
            "PATCH",
            &format!("/api/users/{vera_id}"),
            Some(&json!({ "can_download": true, "can_share": true }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(grant.status, StatusCode::OK, "{}", grant.body);
    let allowed = exchange(
        &app,
        request(
            "GET",
            "/api/objects/thumbnail?name=page.html",
            None,
            Some(&vera),
        ),
    )
    .await;
    assert_eq!(allowed.status, StatusCode::OK);
    assert_eq!(
        header(&allowed.headers, "cache-control"),
        "private, no-store"
    );

    let zip = exchange(
        &app,
        request(
            "POST",
            "/api/buckets/bkt-1/archive-token",
            Some(&json!({ "keys": ["page.html"] }).to_string()),
            Some(&vera),
        ),
    )
    .await;
    assert_eq!(zip.status, StatusCode::OK, "{}", zip.body);
    assert_eq!(header(&zip.headers, "cache-control"), "private, no-store");
    let zip_id = serde_json::from_str::<Value>(&zip.body).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();

    let revoke = exchange(
        &app,
        request(
            "PATCH",
            &format!("/api/users/{vera_id}"),
            Some(&json!({ "can_download": false }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(revoke.status, StatusCode::OK, "{}", revoke.body);
    let revoked_body: Value = serde_json::from_str(&revoke.body).unwrap();
    assert_eq!(revoked_body["can_download"], false);
    assert_eq!(revoked_body["can_share"], false);
    let still = exchange(&app, request("GET", "/api/auth/status", None, Some(&vera))).await;
    assert_eq!(
        serde_json::from_str::<Value>(&still.body).unwrap()["authenticated"],
        true
    );
    assert_eq!(
        serde_json::from_str::<Value>(&still.body).unwrap()["can_download"],
        false
    );
    let consume = exchange(
        &app,
        request(
            "GET",
            &format!("/api/buckets/bkt-1/archive?token={zip_id}"),
            None,
            Some(&vera),
        ),
    )
    .await;
    assert_eq!(consume.status, StatusCode::FORBIDDEN);

    let regrant = exchange(
        &app,
        request(
            "PATCH",
            &format!("/api/users/{vera_id}"),
            Some(&json!({ "can_download": true }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(regrant.status, StatusCode::OK, "{}", regrant.body);
    let gone = exchange(
        &app,
        request(
            "GET",
            &format!("/api/buckets/bkt-1/archive?token={zip_id}"),
            None,
            Some(&vera),
        ),
    )
    .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn share_and_upload_stop_before_unimplemented_work() {
    let dir = crate::util::temp_dir();
    let app = state::test_app(&dir).await;
    let ada = setup_admin(&app).await;
    let created = exchange(
        &app,
        request(
            "POST",
            "/api/users",
            Some(
                &json!({
                    "username": "Vera",
                    "password": OTHER_PASSWORD,
                    "role": "viewer"
                })
                .to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let vera = login_ok(&app, "Vera", OTHER_PASSWORD).await;
    let denied = exchange(
        &app,
        request(
            "POST",
            "/api/share",
            Some(&json!({ "ttl_seconds": 60, "bucket": "b", "key": "k" }).to_string()),
            Some(&vera),
        ),
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(code_of(&denied.body), "forbidden");
    let denied_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit WHERE path = '/api/share'")
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(denied_count, 1);

    let unavailable = exchange(
        &app,
        request(
            "POST",
            "/api/share",
            Some(&json!({ "ttl_seconds": 60, "bucket": "b", "key": "k" }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(unavailable.status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(code_of(&unavailable.body), "share_unavailable");
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit WHERE path = '/api/share'")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(after, 1);

    let upload_denied = exchange(&app, request("POST", "/api/objects", None, Some(&vera))).await;
    assert_eq!(upload_denied.status, StatusCode::FORBIDDEN);
    let missing_length = exchange(&app, request("POST", "/api/objects", None, Some(&ada))).await;
    assert_eq!(missing_length.status, StatusCode::BAD_REQUEST);
    assert_eq!(code_of(&missing_length.body), "length_required");
    let mut too_big = request("POST", "/api/objects", None, Some(&ada));
    too_big
        .headers_mut()
        .insert("content-length", "9999999999".parse().unwrap());
    let too_big = exchange(&app, too_big).await;
    assert_eq!(too_big.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(code_of(&too_big.body), "payload_too_large");
    let mut small = request("POST", "/api/objects", None, Some(&ada));
    small
        .headers_mut()
        .insert("content-length", "4".parse().unwrap());
    let small = exchange(&app, small).await;
    assert_eq!(small.status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(code_of(&small.body), "not_implemented");

    let ready = state::test_app_with(
        &dir.join("share"),
        &[("PUBLIC_S3_URL", "http://127.0.0.1:9")],
        test_quota(),
    )
    .await;
    let ada = setup_admin(&ready).await;
    let not_ready = exchange(
        &ready,
        request(
            "POST",
            "/api/share",
            Some(&json!({ "ttl_seconds": 99999999, "bucket": "b", "key": "k" }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(not_ready.status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(code_of(&not_ready.body), "no_usable_key");
    assert_eq!(
        serde_json::from_str::<Value>(&not_ready.body).unwrap()["message"],
        "This bucket has no usable read-write key"
    );
    assert!(!not_ready.body.contains("http"));
}

#[tokio::test]
async fn config_is_public_fields_only_and_json_body_is_capped() {
    let dir = crate::util::temp_dir();
    let app = state::test_app_with(
        &dir,
        &[
            ("S3_REGION", "eu-test"),
            ("WEBSITE_ROOT_DOMAIN", "sites.example"),
            ("GARAGE_ADMIN_TOKEN", "planted-admin-token-9f3a"),
        ],
        test_quota(),
    )
    .await;
    let ada = setup_admin(&app).await;
    let config = exchange(&app, request("GET", "/api/config", None, Some(&ada))).await;
    assert_eq!(config.status, StatusCode::OK, "{}", config.body);
    let value: Value = serde_json::from_str(&config.body).unwrap();
    let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "s3_region",
            "share_enabled",
            "version",
            "website_root_domain"
        ]
    );
    assert_eq!(value["s3_region"], "eu-test");
    assert_eq!(value["website_root_domain"], "sites.example");
    assert_eq!(value["share_enabled"], false);
    assert_eq!(value["version"], crate::version());
    assert!(!config.body.contains("planted-admin-token-9f3a"));
    assert!(!config.body.contains("rpc"));

    let bulky = "x".repeat(2 * 1024 * 1024);
    let limited = exchange(&app, request("POST", "/api/auth/login", Some(&bulky), None)).await;
    assert_eq!(limited.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(header(&limited.headers, "content-security-policy").contains("default-src 'self'"));
    assert_eq!(
        header(&limited.headers, "x-content-type-options"),
        "nosniff"
    );
    assert_eq!(header(&limited.headers, "x-frame-options"), "DENY");
    assert_eq!(header(&limited.headers, "referrer-policy"), "no-referrer");
    assert!(!limited.body.contains("planted-admin-token-9f3a"));
}

#[tokio::test]
async fn garage_whitelist_blocks_before_upstream_and_strips_secret_query() {
    let listener = Arc::new(TcpListener::bind("127.0.0.1:0").await.unwrap());
    let port = listener.local_addr().unwrap().port();
    let url = format!("http://127.0.0.1:{port}");
    let dir = crate::util::temp_dir();
    let app = state::test_app_with(
        &dir,
        &[
            ("GARAGE_ADMIN_URL", url.as_str()),
            ("GARAGE_ADMIN_TOKEN", "admin-token-value1"),
        ],
        test_quota(),
    )
    .await;
    let ada = setup_admin(&app).await;
    let created = exchange(
        &app,
        request(
            "POST",
            "/api/users",
            Some(
                &json!({
                    "username": "Vera",
                    "password": OTHER_PASSWORD,
                    "role": "viewer"
                })
                .to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let vera = login_ok(&app, "Vera", OTHER_PASSWORD).await;

    let probe = {
        let listener = Arc::clone(&listener);
        tokio::spawn(async move {
            tokio::time::timeout(Duration::from_millis(200), listener.accept()).await
        })
    };
    let viewer_token = exchange(
        &app,
        request(
            "POST",
            "/api/garage/v2/CreateAdminToken",
            Some("{}"),
            Some(&vera),
        ),
    )
    .await;
    assert_eq!(viewer_token.status, StatusCode::FORBIDDEN);
    assert_eq!(code_of(&viewer_token.body), "forbidden");
    let viewer_bucket = exchange(
        &app,
        request(
            "POST",
            "/api/garage/v2/CreateBucket",
            Some("{}"),
            Some(&vera),
        ),
    )
    .await;
    assert_eq!(viewer_bucket.status, StatusCode::FORBIDDEN);
    let unknown = exchange(
        &app,
        request(
            "POST",
            "/api/garage/v2/NotARealEndpoint",
            Some("{}"),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    let check = exchange(&app, request("GET", "/api/garage/check", None, Some(&ada))).await;
    assert_eq!(check.status, StatusCode::NOT_FOUND);
    let unconfirmed = exchange(
        &app,
        request(
            "POST",
            "/api/garage/v2/CreateAdminToken",
            Some("{}"),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(unconfirmed.status, StatusCode::FORBIDDEN);
    assert_eq!(code_of(&unconfirmed.body), "confirmation_required");
    let metrics = exchange(
        &app,
        request("GET", "/api/garage/metrics", None, Some(&ada)),
    )
    .await;
    assert_eq!(metrics.status, StatusCode::BAD_GATEWAY);
    assert_eq!(code_of(&metrics.body), "garage_unavailable");
    assert!(probe.await.unwrap().is_err(), "upstream was contacted");

    let seen = spawn_upstream(Arc::clone(&listener));
    let info = exchange(
        &app,
        request(
            "GET",
            "/api/garage/v2/GetKeyInfo?id=abc&showSecretKey=true&search=q",
            None,
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(info.status, StatusCode::OK, "{}", info.body);
    assert!(info.headers.get("set-cookie").is_none());
    let forwarded = seen.await.unwrap();
    let lowered = forwarded.to_ascii_lowercase();
    assert!(lowered.contains("authorization: bearer admin-token-value1"));
    assert!(!lowered.contains("showsecretkey"));
    assert!(forwarded.contains("id=abc"));
    assert!(forwarded.contains("search=q"));
    assert!(!lowered.contains("x-confirm"));

    let secret = exchange(
        &app,
        request("POST", "/api/keys/abc/secret", None, Some(&ada)),
    )
    .await;
    assert_eq!(secret.status, StatusCode::FORBIDDEN);
    assert_eq!(code_of(&secret.body), "confirmation_required");
    let mut confirmed = request("POST", "/api/keys/abc/secret", None, Some(&ada));
    confirmed
        .headers_mut()
        .insert("x-confirm", "yes".parse().unwrap());
    let seen = spawn_upstream(Arc::clone(&listener));
    let secret = exchange(&app, confirmed).await;
    assert_eq!(secret.status, StatusCode::OK, "{}", secret.body);
    assert_eq!(
        header(&secret.headers, "cache-control"),
        "private, no-store"
    );
    let forwarded = seen.await.unwrap();
    assert!(forwarded.contains("showSecretKey=true"));
    assert!(forwarded.contains("id=abc"));
    assert!(
        forwarded
            .to_ascii_lowercase()
            .contains("authorization: bearer admin-token-value1")
    );

    let seen = spawn_upstream(Arc::clone(&listener));
    let health = exchange(&app, request("GET", "/api/garage/health", None, Some(&ada))).await;
    assert_eq!(health.status, StatusCode::OK, "{}", health.body);
    let forwarded = seen.await.unwrap();
    assert!(forwarded.starts_with("GET /health "));
    assert!(!forwarded.to_ascii_lowercase().contains("authorization:"));

    drop(listener);
    let mut confirmed = request(
        "POST",
        "/api/garage/v2/CreateAdminToken",
        Some("{}"),
        Some(&ada),
    );
    confirmed
        .headers_mut()
        .insert("x-confirm", "yes".parse().unwrap());
    let down = exchange(&app, confirmed).await;
    assert_eq!(down.status, StatusCode::BAD_GATEWAY);
    assert_eq!(code_of(&down.body), "garage_unavailable");
}

async fn boot_loaded(dir: &std::path::Path, extra: &[(&str, &str)]) -> anyhow::Result<App> {
    let mut env = std::collections::HashMap::new();
    env.insert("DATA_DIR".to_string(), dir.display().to_string());
    for (key, value) in extra {
        env.insert((*key).to_string(), (*value).to_string());
    }
    let mut loaded = crate::config::load_map(&env).expect("config");
    loaded.settings.bcrypt_cost = 4;
    state::boot_with(loaded, test_quota()).await
}

#[tokio::test]
async fn bootstrap_admin_logs_in_once_and_setup_stays_closed() {
    let username = "Mina";
    let hash = crate::password::hash(PASSWORD, 4).expect("hash");
    let dir = crate::util::temp_dir();
    let app = state::test_app_with(
        &dir,
        &[
            ("GARAGE_UI_BOOTSTRAP_USERNAME", username),
            ("GARAGE_UI_BOOTSTRAP_PASSWORD_HASH", hash.as_str()),
        ],
        test_quota(),
    )
    .await;
    let setup = exchange(
        &app,
        request(
            "POST",
            "/api/setup",
            Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
            None,
        ),
    )
    .await;
    assert_eq!(setup.status, StatusCode::CONFLICT);
    login_ok(&app, username, PASSWORD).await;

    let again = state::test_app_with(
        &dir,
        &[
            ("GARAGE_UI_BOOTSTRAP_USERNAME", username),
            ("GARAGE_UI_BOOTSTRAP_PASSWORD_HASH", "not-a-bcrypt-hash"),
        ],
        test_quota(),
    )
    .await;
    assert_eq!(crate::db::count_users(&again.db).await.unwrap(), 1);
}

#[tokio::test]
async fn bootstrap_admin_rejects_a_half_pair_or_a_bad_hash() {
    let username = "planted-bootstrap-user";
    let dir = crate::util::temp_dir();
    let Err(err) = boot_loaded(&dir, &[("GARAGE_UI_BOOTSTRAP_USERNAME", username)]).await else {
        panic!("half pair must fail");
    };
    let text = format!("{err:#}");
    assert!(text.contains("bootstrap account must be configured as a pair; refusing to start"));
    assert!(!text.contains(username));

    let hash = "not-a-bcrypt-hash";
    let dir = crate::util::temp_dir();
    let Err(err) = boot_loaded(
        &dir,
        &[
            ("GARAGE_UI_BOOTSTRAP_USERNAME", username),
            ("GARAGE_UI_BOOTSTRAP_PASSWORD_HASH", hash),
        ],
    )
    .await
    else {
        panic!("bad hash must fail");
    };
    let text = format!("{err:#}");
    assert!(text.contains("bootstrap account could not be imported; refusing to start"));
    assert!(!text.contains(username));
    assert!(!text.contains(hash));
}

fn share_body(bucket: &str, key: &str, ttl_seconds: u64) -> String {
    json!({ "ttl_seconds": ttl_seconds, "bucket": bucket, "key": key }).to_string()
}

async fn post_share(
    app: &App,
    session: &Session,
    bucket: &str,
    key: &str,
    ttl_seconds: u64,
) -> Exchange {
    exchange(
        app,
        request(
            "POST",
            "/api/share",
            Some(&share_body(bucket, key, ttl_seconds)),
            Some(session),
        ),
    )
    .await
}

fn url_path(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

async fn serve_json(body: &'static str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0_u8; 2048];
                loop {
                    let Ok(read) = socket.read(&mut tmp).await else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..read]);
                    if buf.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                    if buf.len() > 65536 {
                        return;
                    }
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), task)
}

#[tokio::test]
async fn share_presigns_a_question_mark_key() {
    const QUESTION: &str = "a?b#c%20d=e";
    const QUESTION_PATH: &str = "a%3Fb%23c%2520d%3De";
    const CHINESE: &str = "照片.txt";
    const CHINESE_PATH: &str = "%E7%85%A7%E7%89%87.txt";
    const SECRET: &str = "project-secret-value";
    let (admin_url, admin_task) = serve_json(
        r#"{"id":"photos","websiteAccess":{"enabled":true,"indexDocument":"index.html"}}"#,
    )
    .await;
    let dir = crate::util::temp_dir();
    let app = state::test_app_with(
        &dir,
        &[
            ("PUBLIC_S3_URL", "http://127.0.0.1:3901"),
            ("S3_REGION", "garage"),
            ("S3_ACCESS_KEY_ID", "PROJECT"),
            ("S3_SECRET_ACCESS_KEY", SECRET),
            ("WEBSITE_ROOT_DOMAIN", "https://{bucket}.web.example"),
            ("GARAGE_ADMIN_URL", admin_url.as_str()),
            ("GARAGE_ADMIN_TOKEN", "admin-token-value1"),
        ],
        test_quota(),
    )
    .await;
    let ada = setup_admin(&app).await;
    let created = exchange(
        &app,
        request(
            "POST",
            "/api/users",
            Some(
                &json!({
                    "username": "Vera",
                    "password": OTHER_PASSWORD,
                    "role": "viewer"
                })
                .to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let vera = login_ok(&app, "Vera", OTHER_PASSWORD).await;
    let denied = post_share(&app, &vera, "photos", QUESTION, 3600).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(code_of(&denied.body), "forbidden");

    let vera_id = user_id(&app, &ada, "Vera").await;
    let grant = exchange(
        &app,
        request(
            "PATCH",
            &format!("/api/users/{vera_id}"),
            Some(&json!({ "can_download": true, "can_share": true }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(grant.status, StatusCode::OK, "{}", grant.body);
    let shared_by_viewer = post_share(&app, &vera, "photos", "note.txt", 3600).await;
    assert_eq!(
        shared_by_viewer.status,
        StatusCode::OK,
        "{}",
        shared_by_viewer.body
    );

    let signed = post_share(&app, &ada, "photos", QUESTION, 3600).await;
    assert_eq!(signed.status, StatusCode::OK, "{}", signed.body);
    let body: Value = serde_json::from_str(&signed.body).unwrap();
    let url = body["url"].as_str().expect("presigned url");
    assert!(url.starts_with("http://127.0.0.1:3901/photos/"), "{url}");
    assert!(url_path(url).contains(QUESTION_PATH), "{url}");
    assert!(!url_path(url).contains('?'), "{url}");
    assert!(url.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"), "{url}");
    assert!(url.contains("X-Amz-Expires=3600"), "{url}");
    assert_eq!(body["expires_in"], 3600);
    assert_eq!(body["website_url"], "https://photos.web.example");
    assert!(!signed.body.contains(SECRET));
    let rows = crate::db::recent_audit(&app.db).await.unwrap();
    let recorded = rows
        .iter()
        .find(|row| row.path == "/api/share" && row.target.contains(QUESTION))
        .expect("share audit");
    assert_eq!(recorded.username, "Ada");
    assert!(recorded.target.contains("photos"));
    assert!(recorded.target.contains("3600"));
    assert_eq!(recorded.result, "success");
    assert_eq!(recorded.status, 200);

    let chinese = post_share(&app, &ada, "photos", CHINESE, 24 * 60 * 60).await;
    assert_eq!(chinese.status, StatusCode::OK, "{}", chinese.body);
    let chinese_body: Value = serde_json::from_str(&chinese.body).unwrap();
    let chinese_url = chinese_body["url"].as_str().unwrap();
    assert!(
        url_path(chinese_url).contains(CHINESE_PATH),
        "{chinese_url}"
    );
    assert!(chinese_url.contains("X-Amz-Expires=86400"), "{chinese_url}");

    let capped = post_share(&app, &ada, "photos", "plain.txt", 99_999_999).await;
    assert_eq!(capped.status, StatusCode::OK, "{}", capped.body);
    let capped_body: Value = serde_json::from_str(&capped.body).unwrap();
    let capped_url = capped_body["url"].as_str().unwrap();
    assert!(capped_url.contains("X-Amz-Expires=604800"), "{capped_url}");
    assert_eq!(capped_body["expires_in"], 7 * 24 * 60 * 60);
    let capped_audit = crate::db::recent_audit(&app.db)
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.target.contains("plain.txt"))
        .expect("capped audit");
    assert!(capped_audit.target.contains("604800"));
    assert!(!capped_audit.target.contains("99999999"));

    for index in 0..7 {
        let padded = post_share(&app, &ada, "photos", &format!("pad-{index}"), 3600).await;
        assert_eq!(padded.status, StatusCode::OK, "{}", padded.body);
    }
    let blocked = post_share(&app, &ada, "photos", "once-more", 3600).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(code_of(&blocked.body), "rate_limited");
    assert!(!header(&blocked.headers, "retry-after").is_empty());

    let closed = state::test_app(&dir.join("closed")).await;
    let ada = setup_admin(&closed).await;
    let unavailable = post_share(&closed, &ada, "photos", QUESTION, 3600).await;
    assert_eq!(unavailable.status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(code_of(&unavailable.body), "share_unavailable");
    assert!(!unavailable.body.contains("http"));
    let closed_audit: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit WHERE path = '/api/share'")
            .fetch_one(&closed.db)
            .await
            .unwrap();
    assert_eq!(closed_audit, 0);
    admin_task.abort();
}

fn empty_list_http() -> String {
    let body = r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>"#;
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

async fn capture_requests(
    response_for: impl Fn(&str) -> String + Send + Sync + 'static,
) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_task = Arc::clone(&seen);
    let response_for = Arc::new(response_for);
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let seen_task = Arc::clone(&seen_task);
            let response_for = Arc::clone(&response_for);
            tokio::spawn(async move {
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
                let headers = String::from_utf8_lossy(&buf[..header_end]).into_owned();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                let mut body = buf[header_end + 4..].to_vec();
                while body.len() < length {
                    let Ok(read) = socket.read(&mut tmp).await else {
                        return;
                    };
                    if read == 0 {
                        break;
                    }
                    body.extend_from_slice(&tmp[..read]);
                }
                seen_task.lock().expect("captured").push(headers.clone());
                let response = response_for(&headers);
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), seen, task)
}

#[tokio::test]
async fn missing_bucket_key_returns_412_and_is_not_cached() {
    const SECRET: &str = "chosen-secret-value";
    const MESSAGE: &str = "This bucket has no usable read-write key";
    let (s3_url, s3_seen, s3_task) = capture_requests(|_| empty_list_http()).await;
    let (admin_url, admin_task) =
        serve_json(r#"{"accessKeyId":"CHOSEN","secretAccessKey":"chosen-secret-value"}"#).await;
    let dir = crate::util::temp_dir();
    let app = state::test_app_with(
        &dir,
        &[
            ("S3_ENDPOINT_URL", s3_url.as_str()),
            ("S3_REGION", "garage"),
            ("GARAGE_ADMIN_URL", admin_url.as_str()),
            ("GARAGE_ADMIN_TOKEN", "admin-token-value1"),
        ],
        test_quota(),
    )
    .await;
    let ada = setup_admin(&app).await;
    let created = exchange(
        &app,
        request(
            "POST",
            "/api/users",
            Some(
                &json!({
                    "username": "Vera",
                    "password": OTHER_PASSWORD,
                    "role": "viewer"
                })
                .to_string(),
            ),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let vera = login_ok(&app, "Vera", OTHER_PASSWORD).await;

    for _ in 0..2 {
        let missing = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&ada)),
        )
        .await;
        assert_eq!(
            missing.status,
            StatusCode::PRECONDITION_FAILED,
            "{}",
            missing.body
        );
        assert_eq!(code_of(&missing.body), "no_usable_key");
        let body: Value = serde_json::from_str(&missing.body).unwrap();
        assert_eq!(body["message"], MESSAGE);
    }
    assert!(s3_seen.lock().expect("s3").is_empty());

    let viewer_put = exchange(
        &app,
        request(
            "PUT",
            "/api/buckets/bkt-1/credential",
            Some(&json!({ "access_key_id": "CHOSEN" }).to_string()),
            Some(&vera),
        ),
    )
    .await;
    assert_eq!(
        viewer_put.status,
        StatusCode::FORBIDDEN,
        "{}",
        viewer_put.body
    );

    let chosen = exchange(
        &app,
        request(
            "PUT",
            "/api/buckets/bkt-1/credential",
            Some(&json!({ "access_key_id": "CHOSEN" }).to_string()),
            Some(&ada),
        ),
    )
    .await;
    assert_eq!(chosen.status, StatusCode::OK, "{}", chosen.body);
    assert!(!chosen.body.contains(SECRET));

    let listed = exchange(
        &app,
        request("GET", "/api/buckets/bkt-1/objects", None, Some(&ada)),
    )
    .await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    let captured = s3_seen.lock().expect("s3").clone();
    assert!(
        captured
            .iter()
            .any(|headers| headers.contains("Credential=CHOSEN/")),
        "{captured:?}"
    );
    assert!(
        captured.iter().all(|headers| !headers.contains(SECRET)),
        "{captured:?}"
    );

    let access_key_id: String =
        sqlx::query_scalar("SELECT access_key_id FROM bucket_keys WHERE bucket_id = 'bkt-1'")
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(access_key_id, "CHOSEN");
    sqlx::query("PRAGMA wal_checkpoint(FULL)")
        .execute(&app.db)
        .await
        .unwrap();
    for name in [
        "garage-ui.sqlite",
        "garage-ui.sqlite-wal",
        "garage-ui.sqlite-shm",
    ] {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            !bytes
                .windows(SECRET.len())
                .any(|window| window == SECRET.as_bytes()),
            "{name} stored the key secret"
        );
    }
    s3_task.abort();
    admin_task.abort();
}

fn spawn_upstream(listener: Arc<TcpListener>) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
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
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\nSet-Cookie: leaked=1\r\nConnection: close\r\n\r\n{}",
            )
            .await
            .unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    })
}

#[tokio::test]
async fn thumbnail_content_type_matches_png_bytes() {
    const PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2,
        0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 0,
        3, 1, 1, 0, 201, 254, 146, 239, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    const SECRET: &str = "project-secret-value";
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
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
                let line = text.lines().next().unwrap_or("");
                let target = line.split_whitespace().nth(1).unwrap_or("");
                let path = target.split('?').next().unwrap_or("");
                if !path.ends_with("/dot.png") {
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nContent-Type: application/xml\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                    let _ = socket.shutdown().await;
                    return;
                }
                let mut response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nETag: \"png-as-jpeg\"\r\nConnection: close\r\n\r\n",
                    PNG.len()
                )
                .into_bytes();
                if !line.starts_with("HEAD ") {
                    response.extend_from_slice(PNG);
                }
                let _ = socket.write_all(&response).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    let dir = crate::util::temp_dir();
    let endpoint = format!("http://127.0.0.1:{port}");
    let app = state::test_app_with(
        &dir,
        &[
            ("S3_ENDPOINT_URL", endpoint.as_str()),
            ("S3_REGION", "garage"),
            ("S3_ACCESS_KEY_ID", "PROJECT"),
            ("S3_SECRET_ACCESS_KEY", SECRET),
        ],
        test_quota(),
    )
    .await;
    let session = setup_admin(&app).await;
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        router(app).oneshot(request(
            "GET",
            "/api/buckets/bkt-1/objects/dot.png/thumbnail",
            None,
            Some(&session),
        )),
    )
    .await
    .expect("thumbnail timed out")
    .unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let header_text = response
        .headers()
        .iter()
        .map(|(name, value)| format!("{name}: {}", value.to_str().unwrap_or("")))
        .collect::<Vec<_>>()
        .join("\n");
    let bytes = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        content_type,
        "image/png",
        "status {status} body {}",
        String::from_utf8_lossy(&bytes[..bytes.len().min(180)])
    );
    assert_eq!(status, StatusCode::OK);
    assert!(
        bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "body does not start with a PNG signature"
    );
    assert!(
        !header_text.contains(SECRET),
        "thumbnail headers leaked the key secret"
    );
    assert!(
        !bytes
            .windows(SECRET.len())
            .any(|window| window == SECRET.as_bytes()),
        "thumbnail body leaked the key secret"
    );
    task.abort();
}
