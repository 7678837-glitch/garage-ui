use std::net::SocketAddr;
use std::sync::Arc;
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

async fn user_id(app: &App, session: &Session, username: &str) -> i64 {
    let response = exchange(app, request("GET", "/api/users", None, Some(session))).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.body);
    assert_clean("users", &response.body);
    let users: Vec<Value> = serde_json::from_str(&response.body).unwrap();
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

    let zip = exchange(&app, request("POST", "/api/zip-tokens", None, Some(&vera))).await;
    assert_eq!(zip.status, StatusCode::OK, "{}", zip.body);
    assert_eq!(header(&zip.headers, "cache-control"), "private, no-store");
    let zip_id = serde_json::from_str::<Value>(&zip.body).unwrap()["id"]
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
            "POST",
            &format!("/api/zip-tokens/{zip_id}/consume"),
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
            "POST",
            &format!("/api/zip-tokens/{zip_id}/consume"),
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
    assert_eq!(not_ready.status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(code_of(&not_ready.body), "share_not_ready");
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
