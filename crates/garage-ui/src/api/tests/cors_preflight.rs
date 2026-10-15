use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};

const CONTAINER: &str = "garage-wave1-v241";
const ADMIN_URL: &str = "http://127.0.0.1:3953";
const S3_URL: &str = "http://127.0.0.1:3950";
const ORIGIN: &str = "https://photos.example";
const METHOD: &str = "GET";

struct ConfigFile {
    dir: PathBuf,
}

impl Drop for ConfigFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Held {
    cookie: String,
    csrf: String,
    id: String,
}

fn shown(text: &str, token: &str) -> String {
    let clipped: String = text.chars().take(500).collect();
    let clipped = if text.chars().count() > 500 {
        format!("{clipped}...")
    } else {
        clipped
    };
    if token.is_empty() {
        return clipped;
    }
    clipped.replace(token, "[redacted]")
}

fn docker(args: &[&str]) -> std::process::Output {
    Command::new("docker")
        .args(args)
        .output()
        .unwrap_or_else(|_| panic!("docker {} failed to start", args[0]))
}

fn config_path() -> String {
    let output = docker(&[
        "inspect",
        CONTAINER,
        "--format",
        "{{range .Config.Env}}{{println .}}{{end}}",
    ]);
    assert!(
        output.status.success(),
        "docker inspect exited {}",
        output.status
    );
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text
        .lines()
        .find(|row| row.starts_with("GARAGE_CONFIG_FILE="))
        .unwrap_or_else(|| panic!("{CONTAINER} has no GARAGE_CONFIG_FILE"));
    let path = line["GARAGE_CONFIG_FILE=".len()..].trim();
    assert!(
        path.starts_with('/'),
        "{CONTAINER} GARAGE_CONFIG_FILE is not absolute"
    );
    path.to_string()
}

fn admin_token() -> String {
    let path = config_path();
    let dir = std::env::temp_dir().join(format!(
        "garage-ui-e2e-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("config temp dir");
    let _file = ConfigFile { dir: dir.clone() };
    let dest = dir.join("garage.toml");
    let dest_text = dest.display().to_string();
    let output = docker(&["cp", &format!("{CONTAINER}:{path}"), &dest_text]);
    assert!(
        output.status.success(),
        "docker cp exited {}",
        output.status
    );
    let text = std::fs::read_to_string(&dest).expect("garage config");
    token_from(&text)
}

fn token_from(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|row| row.starts_with("admin_token"))
        .unwrap_or_else(|| panic!("garage config has no admin_token field"));
    let equals = line
        .find('=')
        .unwrap_or_else(|| panic!("garage admin_token field has no value"));
    let mut value = line[equals + 1..].trim().to_string();
    if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
        || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
    {
        value = value[1..value.len() - 1].to_string();
    }
    assert!(value.len() >= 16, "garage admin_token field is too short");
    value
}

fn bucket_alias() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("e2e-280-{}-{nanos}", std::process::id())
}

fn bucket_id(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let id = value.get("id").and_then(Value::as_str)?;
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

fn remember(slot: &Mutex<Option<Held>>, held: Held) {
    *slot.lock().unwrap_or_else(|error| error.into_inner()) = Some(held);
}

fn take_held(slot: &Mutex<Option<Held>>) -> Option<Held> {
    slot.lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
}

fn authed(method: &str, uri: &str, cookie: &str, csrf: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .body(Body::empty())
        .expect("delete request")
}

fn method_allowed(header: &str, method: &str) -> bool {
    header
        .split(',')
        .map(str::trim)
        .any(|allowed| allowed == method)
}

async fn delete_bucket(app: &crate::state::App, held: &Held) -> StatusCode {
    let response = super::exchange(
        app,
        authed(
            "DELETE",
            &format!("/api/buckets/{}", held.id),
            &held.cookie,
            &held.csrf,
        ),
    )
    .await;
    response.status
}

async fn browser_preflight(app: crate::state::App, token: String, slot: &Mutex<Option<Held>>) {
    let (session, _) = super::login(&app).await;
    let alias = bucket_alias();
    assert!(alias.starts_with("e2e-280-"), "{alias}");
    let created = super::exchange(
        &app,
        super::request(
            "POST",
            "/api/buckets",
            Some(&json!({ "globalAlias": alias }).to_string()),
            Some(&session),
        ),
    )
    .await;
    let created_body = shown(&created.body, &token);
    if let Some(id) = bucket_id(&created.body) {
        remember(
            slot,
            Held {
                cookie: super::cookie_header(&session),
                csrf: session.csrf.clone(),
                id,
            },
        );
    }
    assert_eq!(created.status, StatusCode::OK, "{created_body}");
    let id = bucket_id(&created.body).expect("created bucket id");

    let rules = json!([{
        "ID": "photos",
        "AllowedOrigin": [ORIGIN],
        "AllowedMethod": [METHOD, "HEAD"],
        "AllowedHeader": ["*"],
        "ExposeHeader": ["ETag"],
        "MaxAgeSeconds": 600
    }]);
    let saved = super::exchange(
        &app,
        super::request(
            "PUT",
            &format!("/api/buckets/{id}/cors"),
            Some(&json!({ "corsRules": rules }).to_string()),
            Some(&session),
        ),
    )
    .await;
    assert_eq!(
        saved.status,
        StatusCode::OK,
        "{}",
        shown(&saved.body, &token)
    );

    let read = super::exchange(
        &app,
        super::request(
            "GET",
            &format!("/api/buckets/{id}/cors"),
            None,
            Some(&session),
        ),
    )
    .await;
    let stored = shown(&read.body, &token);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .expect("preflight client");
    let response = client
        .request(reqwest::Method::OPTIONS, format!("{S3_URL}/{alias}/probe"))
        .header("Origin", ORIGIN)
        .header("Access-Control-Request-Method", METHOD)
        .send()
        .await
        .expect("preflight request");
    let status = response.status();
    let allow_origin = response
        .headers()
        .get("access-control-allow-origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let allow_methods = response
        .headers()
        .get("access-control-allow-methods")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let preflight_body = shown(&response.text().await.unwrap_or_default(), &token);
    println!("preflight status={status} allow-origin={allow_origin} allow-methods={allow_methods}");
    // An unknown global alias is answered with a wildcard. This rule names one origin.
    assert!(
        status.is_success() && allow_origin == ORIGIN && method_allowed(&allow_methods, METHOD),
        "preflight status={status} allow-origin={allow_origin} allow-methods={allow_methods} stored={stored} body={preflight_body}"
    );
}

#[tokio::test]
#[ignore = "needs the garage-wave1-v241 Docker fixture (see CONTRIBUTING.md); run with --include-ignored"]
async fn browser_preflight_matches_the_saved_cors_rule() {
    let token = admin_token();
    let dir = crate::util::temp_dir();
    let app = crate::state::test_app_with(
        &dir,
        &[
            ("GARAGE_ADMIN_URL", ADMIN_URL),
            ("GARAGE_ADMIN_TOKEN", token.as_str()),
        ],
        crate::limit::test_quota(),
    )
    .await;
    let slot = Arc::new(Mutex::new(None));
    let app_task = app.clone();
    let token_task = token.clone();
    let slot_task = Arc::clone(&slot);
    let outcome = tokio::spawn(async move {
        browser_preflight(app_task, token_task, &slot_task).await;
    })
    .await;
    let task_ok = outcome.is_ok();
    if let Some(held) = take_held(&slot) {
        let status = delete_bucket(&app, &held).await;
        if task_ok {
            assert!(status.is_success(), "delete status={status}");
        }
    }
    if let Err(error) = outcome {
        if error.is_panic() {
            std::panic::resume_unwind(error.into_panic());
        }
        panic!("preflight task failed");
    }
}
