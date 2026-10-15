use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};

const GARAGE_IMAGE: &str = "dxflrs/garage:v2.4.1";
const OWNER_LABEL: &str = "garage-ui.cors-owner";
const ORIGIN: &str = "https://photos.example";
const METHOD: &str = "GET";

struct GarageFixture {
    container: String,
    data_volume: String,
    config_dir: std::path::PathBuf,
    owner: String,
    token: String,
    admin_url: String,
    s3_url: String,
}

impl Drop for GarageFixture {
    fn drop(&mut self) {
        self.remove_owned_container();
        self.remove_owned_volume();
        if let Err(error) = std::fs::remove_dir_all(&self.config_dir) {
            eprintln!("failed to remove CORS fixture config directory: {error}");
        }
    }
}

impl GarageFixture {
    fn remove_owned_container(&self) {
        let container_label = docker_cleanup(&[
            "inspect",
            &self.container,
            "--format",
            "{{index .Config.Labels \"garage-ui.cors-owner\"}}",
        ]);
        match container_label {
            Ok(output) if output.status.success() => {
                if String::from_utf8_lossy(&output.stdout).trim() == self.owner {
                    report_cleanup_failure(
                        "remove owned CORS fixture container",
                        &self.container,
                        docker_cleanup(&["rm", "-f", &self.container]),
                    );
                }
            }
            Ok(output) if !resource_absent(&output) => {
                eprintln!(
                    "failed to inspect CORS fixture container {}",
                    self.container
                );
            }
            Ok(_) => {}
            Err(error) => eprintln!(
                "failed to start Docker while inspecting CORS fixture container {}: {error}",
                self.container
            ),
        }
    }

    fn remove_owned_volume(&self) {
        let volume_label = docker_cleanup(&[
            "volume",
            "inspect",
            &self.data_volume,
            "--format",
            "{{index .Labels \"garage-ui.cors-owner\"}}",
        ]);
        match volume_label {
            Ok(output) if output.status.success() => {
                if String::from_utf8_lossy(&output.stdout).trim() == self.owner {
                    report_cleanup_failure(
                        "remove owned CORS fixture data volume",
                        &self.data_volume,
                        docker_cleanup(&["volume", "rm", &self.data_volume]),
                    );
                }
            }
            Ok(output) if !resource_absent(&output) => {
                eprintln!(
                    "failed to inspect CORS fixture data volume {}",
                    self.data_volume
                );
            }
            Ok(_) => {}
            Err(error) => eprintln!(
                "failed to start Docker while inspecting CORS fixture data volume {}: {error}",
                self.data_volume
            ),
        }
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

fn docker_cleanup(args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("docker").args(args).output()
}

fn resource_absent(output: &std::process::Output) -> bool {
    String::from_utf8_lossy(&output.stderr)
        .to_ascii_lowercase()
        .contains("no such")
}

fn report_cleanup_failure(
    operation: &str,
    resource: &str,
    result: std::io::Result<std::process::Output>,
) {
    match result {
        Ok(output) if output.status.success() => {}
        Ok(_) => eprintln!("failed to {operation} {resource}"),
        Err(error) => {
            eprintln!("failed to start Docker while attempting to {operation} {resource}: {error}")
        }
    }
}

fn random_hex() -> String {
    crate::util::hex_encode(&crate::util::random_bytes(32).expect("random fixture secret"))
}

fn docker_port(container: &str, port: &str) -> String {
    let output = docker(&["port", container, port]);
    assert!(
        output.status.success(),
        "docker port {port} exited {}",
        output.status
    );
    String::from_utf8(output.stdout)
        .expect("docker port utf-8")
        .trim()
        .rsplit_once(':')
        .map(|(_, port)| port.to_string())
        .unwrap_or_else(|| panic!("docker port {port} did not return a loopback port"))
}

impl GarageFixture {
    async fn start() -> Self {
        let owner = format!("{}-{}", std::process::id(), random_hex());
        let container = format!("garage-ui-cors-{owner}");
        let data_volume = format!("{container}-data");
        let config_dir = crate::util::temp_dir();
        #[cfg(unix)]
        std::fs::set_permissions(
            &config_dir,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .expect("set Garage fixture config directory permissions");
        let token = random_hex();
        let rpc_secret = random_hex();
        let config_path = config_dir.join("garage.toml");
        std::fs::write(
            &config_path,
            format!(
                r#"metadata_dir = "/data/meta"
data_dir = "/data/objects"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "{rpc_secret}"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "{token}"
"#
            ),
        )
        .expect("write Garage fixture config");
        let fixture = Self {
            container,
            data_volume,
            config_dir,
            owner,
            token,
            admin_url: String::new(),
            s3_url: String::new(),
        };
        let label = format!("{OWNER_LABEL}={}", fixture.owner);
        assert!(
            docker(&["volume", "create", "--label", &label, &fixture.data_volume])
                .status
                .success(),
            "create Garage fixture data volume"
        );
        let config_mount = format!("{}:/etc/garage.toml:ro", config_path.display());
        assert!(
            docker(&[
                "run",
                "-d",
                "--pull",
                "never",
                "--name",
                &fixture.container,
                "--label",
                &label,
                "-e",
                "GARAGE_CONFIG_FILE=/etc/garage.toml",
                "-p",
                "127.0.0.1::3900",
                "-p",
                "127.0.0.1::3903",
                "-v",
                &config_mount,
                "-v",
                &format!("{}:/data", fixture.data_volume),
                GARAGE_IMAGE,
                "/garage",
                "server",
                "--single-node"
            ])
            .status
            .success(),
            "start Garage CORS fixture"
        );
        let mut fixture = fixture;
        fixture.admin_url = format!(
            "http://127.0.0.1:{}",
            docker_port(&fixture.container, "3903/tcp")
        );
        fixture.s3_url = format!(
            "http://127.0.0.1:{}",
            docker_port(&fixture.container, "3900/tcp")
        );
        fixture.wait_healthy().await;
        fixture
    }

    async fn wait_healthy(&self) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .no_proxy()
            .build()
            .expect("Garage health client");
        let mut last = String::from("not checked");
        for _ in 0..60 {
            match client
                .get(format!("{}/v2/GetClusterHealth", self.admin_url))
                .bearer_auth(&self.token)
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => {
                    let body: Value = response.json().await.expect("Garage health JSON");
                    if body.get("status").and_then(Value::as_str) == Some("healthy")
                        && body.get("storageNodes").and_then(Value::as_u64) == Some(1)
                        && body.get("storageNodesUp").and_then(Value::as_u64) == Some(1)
                    {
                        return;
                    }
                    last = format!("cluster health={body}");
                }
                Ok(response) => last = format!("HTTP {}", response.status()),
                Err(error) => last = error.to_string(),
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        panic!("Garage CORS fixture did not become healthy: {last}");
    }
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

async fn browser_preflight(
    app: crate::state::App,
    token: String,
    s3_url: String,
    slot: &Mutex<Option<Held>>,
) {
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
        .request(reqwest::Method::OPTIONS, format!("{s3_url}/{alias}/probe"))
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
async fn browser_preflight_matches_the_saved_cors_rule() {
    let fixture = GarageFixture::start().await;
    let dir = crate::util::temp_dir();
    let app = crate::state::test_app_with(
        &dir,
        &[
            ("GARAGE_ADMIN_URL", fixture.admin_url.as_str()),
            ("GARAGE_ADMIN_TOKEN", fixture.token.as_str()),
        ],
        crate::limit::test_quota(),
    )
    .await;
    let slot = Arc::new(Mutex::new(None));
    let app_task = app.clone();
    let token_task = fixture.token.clone();
    let s3_url_task = fixture.s3_url.clone();
    let slot_task = Arc::clone(&slot);
    let outcome = tokio::spawn(async move {
        browser_preflight(app_task, token_task, s3_url_task, &slot_task).await;
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
