use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use tokio::sync::{Mutex, Semaphore};

use crate::config::{self, KeyMaterial, Loaded, Settings};
use crate::db;
use crate::limit::{self, Limits};
use crate::password;
use crate::util::{self, hex_encode};

#[derive(Clone)]
pub struct Fixture {
    pub content_type: String,
    pub filename: String,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GarageLink {
    pub version: Option<String>,
    pub writes_allowed: bool,
}

struct CachedGarageLink {
    url: String,
    link: GarageLink,
}

#[derive(Clone)]
pub(crate) struct S3Probe {
    pub endpoint: Option<String>,
    pub region: Option<String>,
}

pub(crate) const UPLOAD_BUFFER_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct App {
    pub db: sqlx::SqlitePool,
    pub settings: Arc<Settings>,
    pub limits: Arc<Limits>,
    pub dummy_hash: Arc<String>,
    pub http: reqwest::Client,
    pub fixtures: Arc<std::sync::Mutex<HashMap<String, Fixture>>>,
    pub write: Arc<Mutex<()>>,
    pub upload_buffer: Arc<Semaphore>,
    metrics: Arc<Metrics>,
    garage_link: Arc<Mutex<Option<CachedGarageLink>>>,
    s3_probe: Arc<Mutex<Option<S3Probe>>>,
    credentials: Arc<Mutex<credentials::CredentialCache>>,
    pub key_id: Arc<String>,
    #[cfg(test)]
    pub log_sink: Arc<std::sync::Mutex<Vec<String>>>,
}

impl GarageLink {
    pub fn unknown() -> Self {
        Self {
            version: None,
            writes_allowed: true,
        }
    }

    pub fn from_reported(raw: Option<&str>) -> Self {
        let Some(raw) = raw else {
            return Self::unknown();
        };
        let Some(parsed) = parse_garage_version(raw) else {
            return Self::unknown();
        };
        Self {
            version: Some(raw.to_string()),
            writes_allowed: parsed >= (2, 3, 0),
        }
    }
}

fn parse_garage_version(raw: &str) -> Option<(u64, u64, u64)> {
    let rest = raw.strip_prefix('v').unwrap_or(raw);
    let mut parts = rest.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

impl App {
    pub async fn garage_link_for(
        &self,
        url: &str,
        probe: impl std::future::Future<Output = GarageLink>,
    ) -> GarageLink {
        let mut slot = self.garage_link.lock().await;
        if let Some(cached) = slot.as_ref()
            && cached.url == url
        {
            return cached.link.clone();
        }
        let link = probe.await;
        *slot = Some(CachedGarageLink {
            url: url.to_string(),
            link: link.clone(),
        });
        link
    }

    pub async fn clear_garage_link(&self) {
        *self.garage_link.lock().await = None;
    }

    pub(crate) async fn cached_s3_probe(
        &self,
        load: impl std::future::Future<Output = S3Probe>,
    ) -> S3Probe {
        let mut slot = self.s3_probe.lock().await;
        if let Some(cached) = slot.clone() {
            return cached;
        }
        let probed = load.await;
        *slot = Some(probed.clone());
        probed
    }

    pub(crate) async fn clear_credential_cache(&self, mutation: &credentials::KeyMutation) {
        self.credentials.lock().await.clear(mutation);
    }

    // CredentialCache::read 是同步的。请求线程里 block_on 会 panic，所以 S3 放到独立 runtime。
    pub(crate) async fn read_credential<T, F, Fut>(
        &self,
        bucket_id: &str,
        load: credentials::CredentialSources,
        mut operation: F,
    ) -> Result<T, credentials::ReadFailure>
    where
        T: Send + 'static,
        F: FnMut(credentials::BucketCredential) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = credentials::Operation<T>> + Send + 'static,
    {
        let cache = Arc::clone(&self.credentials);
        let bucket_id = bucket_id.to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX))
            .unwrap_or(0);
        tokio::task::spawn_blocking(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("s3 runtime");
            let mut guard = cache.blocking_lock();
            guard.read(
                &bucket_id,
                now,
                || load.clone(),
                |credential| runtime.block_on(operation(credential.clone())),
            )
        })
        .await
        .expect("credential read")
    }

    #[cfg(test)]
    pub(crate) async fn resolve_bucket_credential(
        &self,
        bucket_id: &str,
        now: i64,
        sources: &credentials::CredentialSources,
    ) -> Result<credentials::BucketCredential, credentials::NoUsableKey> {
        self.credentials
            .lock()
            .await
            .resolve(bucket_id, now, sources)
    }

    pub fn record_access(&self, line: &str) {
        #[cfg(test)]
        self.log_sink
            .lock()
            .expect("log sink")
            .push(line.to_string());
        let _ = line;
    }

    pub(crate) fn observe_http(&self, seconds: f64) {
        self.metrics.observe_http(seconds);
    }

    pub(crate) fn record_garage_error(&self) {
        self.metrics.garage_errors.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn begin_upload(&self) -> UploadInFlight<'_> {
        self.metrics
            .uploads_in_flight
            .fetch_add(1, Ordering::Relaxed);
        UploadInFlight {
            gauge: &self.metrics.uploads_in_flight,
        }
    }

    pub(crate) fn metrics_text(&self) -> String {
        self.metrics.render()
    }
}

// 进程内只有这一份计数。各请求 fetch_add，抓取时再读。
struct Metrics {
    http_requests: AtomicU64,
    http_buckets: [AtomicU64; 11],
    http_sum_bits: AtomicU64,
    garage_errors: AtomicU64,
    uploads_in_flight: AtomicI64,
}

const LATENCY_BOUNDS: [f64; 10] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0];
const LATENCY_LABELS: [&str; 11] = [
    "0.005", "0.01", "0.025", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "+Inf",
];

impl Metrics {
    fn new() -> Self {
        Self {
            http_requests: AtomicU64::new(0),
            http_buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            http_sum_bits: AtomicU64::new(0),
            garage_errors: AtomicU64::new(0),
            uploads_in_flight: AtomicI64::new(0),
        }
    }

    fn observe_http(&self, seconds: f64) {
        let start = LATENCY_BOUNDS
            .iter()
            .position(|bound| seconds <= *bound)
            .unwrap_or(LATENCY_BOUNDS.len());
        for bucket in &self.http_buckets[start..] {
            bucket.fetch_add(1, Ordering::Relaxed);
        }
        let mut current = self.http_sum_bits.load(Ordering::Relaxed);
        loop {
            let next = (f64::from_bits(current) + seconds).to_bits();
            match self.http_sum_bits.compare_exchange_weak(
                current,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
        self.http_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn render(&self) -> String {
        let requests = self.http_requests.load(Ordering::Relaxed);
        let errors = self.garage_errors.load(Ordering::Relaxed);
        let uploads = self.uploads_in_flight.load(Ordering::Relaxed);
        let sum = f64::from_bits(self.http_sum_bits.load(Ordering::Relaxed));
        let mut out = String::new();
        push_counter(
            &mut out,
            "garage_ui_http_requests_total",
            "Finished HTTP requests.",
            requests,
        );
        out.push_str(
            "# HELP garage_ui_http_request_duration_seconds HTTP request duration in seconds.\n",
        );
        out.push_str("# TYPE garage_ui_http_request_duration_seconds histogram\n");
        let mut observations = 0_u64;
        for (label, bucket) in LATENCY_LABELS.iter().zip(self.http_buckets.iter()) {
            observations = bucket.load(Ordering::Relaxed);
            out.push_str(&format!(
                "garage_ui_http_request_duration_seconds_bucket{{le=\"{label}\"}} {observations}\n"
            ));
        }
        out.push_str(&format!(
            "garage_ui_http_request_duration_seconds_sum {}\n",
            format_seconds(sum)
        ));
        out.push_str(&format!(
            "garage_ui_http_request_duration_seconds_count {observations}\n"
        ));
        push_counter(
            &mut out,
            "garage_ui_garage_errors_total",
            "Garage admin calls that returned no HTTP status.",
            errors,
        );
        push_gauge(
            &mut out,
            "garage_ui_uploads_in_flight",
            "Uploads currently in progress.",
            uploads,
        );
        out
    }
}

fn push_counter(out: &mut String, name: &str, help: &str, value: u64) {
    out.push_str(&format!(
        "# HELP {name} {help}\n# TYPE {name} counter\n{name} {value}\n"
    ));
}

fn push_gauge(out: &mut String, name: &str, help: &str, value: i64) {
    out.push_str(&format!(
        "# HELP {name} {help}\n# TYPE {name} gauge\n{name} {value}\n"
    ));
}

fn format_seconds(value: f64) -> String {
    if value == 0.0 {
        "0".to_string()
    } else {
        format!("{value}")
    }
}

pub(crate) struct UploadInFlight<'a> {
    gauge: &'a AtomicI64,
}

impl Drop for UploadInFlight<'_> {
    fn drop(&mut self) {
        self.gauge.fetch_sub(1, Ordering::Relaxed);
    }
}

pub async fn boot() -> anyhow::Result<App> {
    let loaded = config::load_process()?;
    boot_with(loaded, limit::production_quota()).await
}

pub async fn boot_with(loaded: Loaded, quota: governor::Quota) -> anyhow::Result<App> {
    std::fs::create_dir_all(&loaded.settings.data_dir)
        .map_err(|_| anyhow::anyhow!("数据目录不可写: {}", loaded.settings.data_dir.display()))?;
    let probe = loaded.settings.data_dir.join(".write-probe");
    std::fs::write(&probe, b"")
        .map_err(|_| anyhow::anyhow!("数据目录不可写: {}", loaded.settings.data_dir.display()))?;
    let _ = std::fs::remove_file(&probe);
    let key_bytes = load_session_key(&loaded.settings.data_dir, loaded.key)?;
    let key_id = hex_encode(&key_bytes[..16]);
    let pool = db::open(&loaded.settings.data_dir.join("garage-ui.sqlite")).await?;
    import_bootstrap(&pool, &loaded.bootstrap).await?;
    let cost = loaded.settings.bcrypt_cost;
    let dummy_password = util::random_bytes(32)?;
    let dummy_hash = password::hash_async(hex_encode(&dummy_password), cost)
        .await
        .map_err(|_| anyhow::anyhow!("无法初始化口令校验"))?;
    let mut http = reqwest::Client::builder()
        .connect_timeout(loaded.settings.garage_admin_connect_timeout)
        .timeout(loaded.settings.garage_admin_timeout)
        .redirect(reqwest::redirect::Policy::none());
    if loaded.settings.tls_insecure {
        tracing::warn!("tls_insecure");
        http = http.danger_accept_invalid_certs(true);
    }
    if let Some(pem) = &loaded.settings.tls_ca_pem {
        let certificate = reqwest::Certificate::from_pem(pem).context_client()?;
        http = http.add_root_certificate(certificate);
    }
    let http = http.build().context_client()?;
    Ok(App {
        db: pool,
        settings: Arc::new(loaded.settings),
        limits: Arc::new(Limits::new(quota)),
        dummy_hash: Arc::new(dummy_hash),
        http,
        fixtures: Arc::new(std::sync::Mutex::new(HashMap::new())),
        write: Arc::new(Mutex::new(())),
        // 超出 64 MiB 时在这个信号量上等待。不再另做一条队列。
        upload_buffer: Arc::new(Semaphore::new(UPLOAD_BUFFER_BYTES)),
        metrics: Arc::new(Metrics::new()),
        garage_link: Arc::new(Mutex::new(None)),
        s3_probe: Arc::new(Mutex::new(None)),
        credentials: Arc::new(Mutex::new(credentials::CredentialCache::new(60))),
        key_id: Arc::new(key_id),
        #[cfg(test)]
        log_sink: Arc::new(std::sync::Mutex::new(Vec::new())),
    })
}

async fn import_bootstrap(
    pool: &sqlx::SqlitePool,
    bootstrap: &config::Bootstrap,
) -> anyhow::Result<()> {
    match bootstrap {
        config::Bootstrap::Unset => Ok(()),
        config::Bootstrap::Half => anyhow::bail!("启动账号需要成对配置，拒绝启动"),
        config::Bootstrap::Ready {
            username,
            password_hash,
        } => {
            if db::count_users(pool).await? > 0 {
                return Ok(());
            }
            if crate::api::validate_username(username).is_err() || !is_bcrypt_hash(password_hash) {
                anyhow::bail!("启动账号无法导入，拒绝启动");
            }
            db::insert_user(pool, username, password_hash, "admin", false, false)
                .await
                .map_err(|_| anyhow::anyhow!("启动账号无法导入，拒绝启动"))?;
            Ok(())
        }
    }
}

fn is_bcrypt_hash(hash: &str) -> bool {
    hash.starts_with("$2a$") || hash.starts_with("$2b$") || hash.starts_with("$2y$")
}

fn load_session_key(dir: &Path, material: KeyMaterial) -> anyhow::Result<Vec<u8>> {
    match material {
        KeyMaterial::Provided(bytes) => {
            config::validate_key_material(&bytes)?;
            Ok(bytes)
        }
        KeyMaterial::Generate => read_or_create_key(&dir.join("session.key")),
    }
}

fn read_or_create_key(path: &Path) -> anyhow::Result<Vec<u8>> {
    if path.exists() {
        let bytes = std::fs::read(path).map_err(|error| {
            anyhow::anyhow!("读取密钥文件失败: {}: {}", path.display(), error.kind())
        })?;
        let bytes = if bytes.len() == 48 {
            bytes
        } else {
            config::strip_trailing_newlines(bytes)
        };
        config::validate_key_material(&bytes)?;
        return Ok(bytes);
    }
    let mut bytes = util::random_bytes(48)?;
    for _ in 0..4 {
        let bad_tail = matches!(bytes.last(), Some(b'\n' | b'\r'));
        if bytes.iter().all(|byte| *byte == 0) || bad_tail {
            bytes = util::random_bytes(48)?;
        } else {
            break;
        }
    }
    config::validate_key_material(&bytes)?;
    write_private(path, &bytes)?;
    Ok(bytes)
}

fn write_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| {
            anyhow::anyhow!("写入密钥文件失败: {}: {}", path.display(), error.kind())
        })?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

trait ClientError<T> {
    fn context_client(self) -> anyhow::Result<T>;
}

impl<T, E: std::fmt::Display> ClientError<T> for Result<T, E> {
    fn context_client(self) -> anyhow::Result<T> {
        self.map_err(|_| anyhow::anyhow!("创建 Garage HTTP 客户端失败"))
    }
}

#[cfg(test)]
pub async fn test_app_with(dir: &Path, extra: &[(&str, &str)], quota: governor::Quota) -> App {
    let mut env = HashMap::new();
    env.insert("DATA_DIR".to_string(), dir.display().to_string());
    for (key, value) in extra {
        env.insert((*key).to_string(), (*value).to_string());
    }
    let mut loaded = config::load_map(&env).expect("test config");
    loaded.settings.bcrypt_cost = 4;
    boot_with(loaded, quota).await.expect("boot")
}

#[cfg(test)]
pub async fn test_app(dir: &Path) -> App {
    test_app_with(dir, &[], limit::test_quota()).await
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::{Arc, Mutex};

    use super::GarageLink;

    struct WarnLog(Arc<Mutex<Vec<u8>>>);

    impl Write for WarnLog {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("warn log").extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn env_with(dir: &Path, extra: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        let mut env = std::collections::HashMap::new();
        env.insert("DATA_DIR".to_string(), dir.display().to_string());
        for (key, value) in extra {
            env.insert((*key).to_string(), (*value).to_string());
        }
        env
    }

    async fn boot_logged(mut loaded: crate::config::Loaded) -> (super::App, String) {
        loaded.settings.bcrypt_cost = 4;
        let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&logs);
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .with_writer(move || WarnLog(Arc::clone(&sink)))
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let app = super::boot_with(loaded, crate::limit::test_quota())
            .await
            .expect("boot");
        let text = String::from_utf8(logs.lock().expect("warn log").clone()).unwrap();
        (app, text)
    }

    const TLS_SERVER: &str = r#"
import http.server
import ssl
import sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
server.socket = context.wrap_socket(server.socket, server_side=True)
print(server.server_address[1], flush=True)
server.serve_forever()
"#;

    struct TlsProbe {
        child: Child,
        port: u16,
        ca: PathBuf,
    }

    fn openssl(args: &[&str]) {
        let output = Command::new("openssl")
            .args(args)
            .output()
            .expect("openssl");
        assert!(
            output.status.success(),
            "openssl {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    impl TlsProbe {
        fn start() -> Self {
            let dir = crate::util::temp_dir();
            let ca = dir.join("ca.pem");
            let ca_key = dir.join("ca.key");
            let server_key = dir.join("server.key");
            let server_cert = dir.join("server.pem");
            let csr = dir.join("server.csr");
            let ca_s = ca.to_str().expect("ca path");
            let ca_key_s = ca_key.to_str().expect("ca key path");
            let server_key_s = server_key.to_str().expect("server key path");
            let server_cert_s = server_cert.to_str().expect("server cert path");
            let csr_s = csr.to_str().expect("csr path");
            openssl(&[
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                ca_key_s,
                "-out",
                ca_s,
                "-days",
                "1",
                "-nodes",
                "-subj",
                "/CN=GarageTestCA",
                "-addext",
                "basicConstraints=critical,CA:TRUE",
            ]);
            openssl(&[
                "req",
                "-newkey",
                "rsa:2048",
                "-keyout",
                server_key_s,
                "-out",
                csr_s,
                "-nodes",
                "-subj",
                "/CN=127.0.0.1",
                "-addext",
                "subjectAltName=IP:127.0.0.1",
                "-addext",
                "extendedKeyUsage=serverAuth",
            ]);
            openssl(&[
                "x509",
                "-req",
                "-in",
                csr_s,
                "-CA",
                ca_s,
                "-CAkey",
                ca_key_s,
                "-CAcreateserial",
                "-out",
                server_cert_s,
                "-days",
                "1",
                "-copy_extensions",
                "copy",
            ]);
            let mut child = Command::new("python3")
                .arg("-c")
                .arg(TLS_SERVER)
                .arg(&server_cert)
                .arg(&server_key)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("python");
            let stdout = child.stdout.take().expect("python stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("python port");
            let port = line.trim().parse().unwrap_or_else(|_| {
                let mut err = String::new();
                if let Some(stderr) = child.stderr.take() {
                    let _ = BufReader::new(stderr).read_to_string(&mut err);
                }
                panic!("python port from {line:?}: {err}");
            });
            Self { child, port, ca }
        }
    }

    impl Drop for TlsProbe {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    async fn fetch_status(client: &reqwest::Client, port: u16) -> Result<u16, String> {
        match client
            .get(format!("https://127.0.0.1:{port}/"))
            .send()
            .await
        {
            Ok(response) => Ok(response.status().as_u16()),
            Err(error) => {
                let mut text = error.to_string();
                let mut source = std::error::Error::source(&error);
                while let Some(inner) = source {
                    text.push_str(": ");
                    text.push_str(&inner.to_string());
                    source = std::error::Error::source(inner);
                }
                Err(text)
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn tls_insecure_is_off_unless_the_switch_is_one_and_a_missing_ca_fails() {
        let missing = crate::util::temp_dir().join("missing-ca.pem");
        let missing_path = missing.display().to_string();
        assert!(!missing.exists());
        let Err(err) = crate::config::load_map(&env_with(
            &crate::util::temp_dir(),
            &[("GARAGE_TLS_CA_FILE", missing_path.as_str())],
        )) else {
            panic!("missing CA file must fail");
        };
        let text = format!("{err:#}");
        assert!(text.contains(&missing_path), "{text}");

        let probe = TlsProbe::start();
        let ca = probe.ca.display().to_string();

        for value in [None, Some(""), Some("0")] {
            let dir = crate::util::temp_dir();
            let mut pairs = Vec::new();
            if let Some(value) = value {
                pairs.push(("GARAGE_TLS_INSECURE", value));
            }
            let loaded = crate::config::load_map(&env_with(&dir, &pairs)).expect("load");
            let (app, logs) = boot_logged(loaded).await;
            let err = fetch_status(&app.http, probe.port)
                .await
                .expect_err("verification stays on");
            assert!(err.contains("certificate"), "{value:?}: {err}");
            assert!(!logs.contains("tls_insecure"), "{value:?}: {logs}");
        }

        let trusted = crate::config::load_map(&env_with(
            &crate::util::temp_dir(),
            &[("GARAGE_TLS_CA_FILE", ca.as_str())],
        ))
        .expect("ca file");
        let (app, logs) = boot_logged(trusted).await;
        assert_eq!(
            fetch_status(&app.http, probe.port)
                .await
                .expect("custom CA"),
            200
        );
        assert!(!logs.contains("tls_insecure"), "{logs}");

        let loaded = crate::config::load_map(&env_with(
            &crate::util::temp_dir(),
            &[("GARAGE_TLS_INSECURE", "1")],
        ))
        .expect("load");
        let (app, logs) = boot_logged(loaded).await;
        assert_eq!(
            fetch_status(&app.http, probe.port)
                .await
                .expect("skip accepts the server"),
            200
        );
        assert!(logs.contains("tls_insecure"), "{logs}");
    }

    #[test]
    fn reported_version_blocks_only_a_parsed_release_below_2_3_0() {
        let old = GarageLink::from_reported(Some("v2.2.0"));
        assert_eq!(old.version.as_deref(), Some("v2.2.0"));
        assert!(!old.writes_allowed);
        assert!(!GarageLink::from_reported(Some("v2.2.9")).writes_allowed);
        assert!(!GarageLink::from_reported(Some("2.2.9")).writes_allowed);

        let current = GarageLink::from_reported(Some("v2.3.0"));
        assert_eq!(current.version.as_deref(), Some("v2.3.0"));
        assert!(current.writes_allowed);
        assert!(GarageLink::from_reported(Some("2.3.0")).writes_allowed);
        assert!(GarageLink::from_reported(Some("v2.10.0")).writes_allowed);

        let missing = GarageLink::from_reported(None);
        assert_eq!(missing.version, None);
        assert!(missing.writes_allowed);
        let unparsed = GarageLink::from_reported(Some("nightly"));
        assert_eq!(unparsed.version, None);
        assert!(unparsed.writes_allowed);
    }
}

// read_write_keys 不参与选择。非测试构建里没有人读这个字段。
#[allow(dead_code)]
pub mod credentials {
    use std::collections::HashMap;

    const MAX_TTL_SECS: i64 = 60;

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct BucketCredential {
        access_key_id: String,
        secret_key: String,
    }

    impl BucketCredential {
        pub fn new(access_key_id: impl Into<String>, secret_key: impl Into<String>) -> Self {
            Self {
                access_key_id: access_key_id.into(),
                secret_key: secret_key.into(),
            }
        }

        pub fn access_key_id(&self) -> &str {
            &self.access_key_id
        }

        pub fn secret_key(&self) -> &str {
            &self.secret_key
        }
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct CredentialSources {
        pub project_key: Option<BucketCredential>,
        pub explicit_key: Option<BucketCredential>,
        pub read_write_keys: Vec<BucketCredential>,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct NoUsableKey;

    impl NoUsableKey {
        pub fn status(self) -> u16 {
            412
        }

        pub fn code(self) -> &'static str {
            "no_usable_key"
        }

        pub fn message(self) -> &'static str {
            "This bucket has no usable read-write key"
        }
    }

    #[allow(clippy::enum_variant_names)]
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum KeyMutation {
        AllowBucketKey { bucket_id: String },
        DenyBucketKey { bucket_id: String },
        DeleteKey { key_id: String },
        UpdateKey { key_id: String },
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum Operation<T> {
        Done(T),
        Forbidden,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum ReadFailure {
        NoUsableKey(NoUsableKey),
        Forbidden,
    }

    struct Entry {
        credential: BucketCredential,
        stored_at: i64,
    }

    pub struct CredentialCache {
        ttl_secs: i64,
        entries: HashMap<String, Entry>,
    }

    impl CredentialCache {
        pub fn new(ttl_secs: i64) -> Self {
            Self {
                ttl_secs: ttl_secs.clamp(0, MAX_TTL_SECS),
                entries: HashMap::new(),
            }
        }

        pub fn resolve(
            &mut self,
            bucket_id: &str,
            now: i64,
            sources: &CredentialSources,
        ) -> Result<BucketCredential, NoUsableKey> {
            if let Some(hit) = self.fresh(bucket_id, now) {
                return Ok(hit.clone());
            }
            self.entries.remove(bucket_id);
            let selected = select(sources)?;
            self.entries.insert(
                bucket_id.to_string(),
                Entry {
                    credential: selected.clone(),
                    stored_at: now,
                },
            );
            Ok(selected)
        }

        pub fn clear(&mut self, mutation: &KeyMutation) {
            match mutation {
                KeyMutation::AllowBucketKey { bucket_id, .. }
                | KeyMutation::DenyBucketKey { bucket_id, .. } => {
                    self.entries.remove(bucket_id);
                }
                KeyMutation::DeleteKey { key_id } | KeyMutation::UpdateKey { key_id } => {
                    self.entries
                        .retain(|_, entry| entry.credential.access_key_id != *key_id);
                }
            }
        }

        pub fn read<T>(
            &mut self,
            bucket_id: &str,
            now: i64,
            mut load: impl FnMut() -> CredentialSources,
            mut operation: impl FnMut(&BucketCredential) -> Operation<T>,
        ) -> Result<T, ReadFailure> {
            let first = self
                .resolve(bucket_id, now, &load())
                .map_err(ReadFailure::NoUsableKey)?;
            match operation(&first) {
                Operation::Done(value) => Ok(value),
                Operation::Forbidden => {
                    self.entries.remove(bucket_id);
                    let second = self
                        .resolve(bucket_id, now, &load())
                        .map_err(ReadFailure::NoUsableKey)?;
                    match operation(&second) {
                        Operation::Done(value) => Ok(value),
                        Operation::Forbidden => {
                            self.entries.remove(bucket_id);
                            Err(ReadFailure::Forbidden)
                        }
                    }
                }
            }
        }

        fn fresh(&self, bucket_id: &str, now: i64) -> Option<&BucketCredential> {
            let entry = self.entries.get(bucket_id)?;
            if now.saturating_sub(entry.stored_at) >= self.ttl_secs {
                None
            } else {
                Some(&entry.credential)
            }
        }
    }

    fn select(sources: &CredentialSources) -> Result<BucketCredential, NoUsableKey> {
        if let Some(key) = &sources.project_key {
            return Ok(key.clone());
        }
        if let Some(key) = &sources.explicit_key {
            return Ok(key.clone());
        }
        Err(NoUsableKey)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn cred(id: &str, secret: &str) -> BucketCredential {
            BucketCredential::new(id, secret)
        }

        fn explicit(id: &str) -> CredentialSources {
            CredentialSources {
                project_key: None,
                explicit_key: Some(cred(id, "secret")),
                read_write_keys: vec![cred("rw-ignored", "nope")],
            }
        }

        #[test]
        fn project_key_beats_an_explicit_key_and_read_write_keys() {
            let mut cache = CredentialCache::new(60);
            let sources = CredentialSources {
                project_key: Some(cred("PROJECT", "project-secret")),
                explicit_key: Some(cred("EXPLICIT", "explicit-secret")),
                read_write_keys: vec![cred("RW", "rw-secret")],
            };
            let got = cache.resolve("photos", 0, &sources).unwrap();
            assert_eq!(got.access_key_id(), "PROJECT");
            assert_eq!(got.secret_key(), "project-secret");
        }

        #[test]
        fn missing_key_is_not_stored() {
            let mut cache = CredentialCache::new(60);
            let missing = CredentialSources {
                project_key: None,
                explicit_key: None,
                read_write_keys: vec![cred("RW", "rw-secret")],
            };
            let err = cache.resolve("photos", 0, &missing).unwrap_err();
            assert_eq!(err.status(), 412);
            assert_eq!(err.code(), "no_usable_key");
            assert_eq!(err.message(), "This bucket has no usable read-write key");
            let granted = explicit("KEYB");
            let got = cache.resolve("photos", 1, &granted).unwrap();
            assert_eq!(got.access_key_id(), "KEYB");
        }

        #[test]
        fn revoke_then_next_read() {
            let mut cache = CredentialCache::new(60);
            let mut photos = explicit("KEYA");
            assert_eq!(
                cache
                    .resolve("photos", 10, &photos)
                    .unwrap()
                    .access_key_id(),
                "KEYA"
            );
            let mut other = explicit("KEEP");
            assert_eq!(
                cache.resolve("other", 10, &other).unwrap().access_key_id(),
                "KEEP"
            );
            cache.clear(&KeyMutation::DenyBucketKey {
                bucket_id: "photos".into(),
            });
            photos.explicit_key = None;
            photos.read_write_keys = vec![cred("KEYA", "secret"), cred("OTHER", "secret")];
            let err = cache.resolve("photos", 11, &photos).unwrap_err();
            assert_eq!(err.status(), 412);
            assert_eq!(err.code(), "no_usable_key");
            assert_eq!(err.message(), "This bucket has no usable read-write key");
            other.explicit_key = Some(cred("CHANGED", "secret"));
            assert_eq!(
                cache.resolve("other", 11, &other).unwrap().access_key_id(),
                "KEEP"
            );

            let mut docs = explicit("KEYA");
            assert_eq!(
                cache.resolve("docs", 12, &docs).unwrap().access_key_id(),
                "KEYA"
            );
            cache.clear(&KeyMutation::DeleteKey {
                key_id: "KEYA".into(),
            });
            docs.explicit_key = Some(cred("KEYB", "secret"));
            assert_eq!(
                cache.resolve("docs", 13, &docs).unwrap().access_key_id(),
                "KEYB"
            );
            assert_eq!(
                cache.resolve("other", 13, &other).unwrap().access_key_id(),
                "KEEP"
            );
        }

        #[test]
        fn absent_then_granted() {
            let mut cache = CredentialCache::new(60);
            let mut sources = CredentialSources {
                project_key: None,
                explicit_key: None,
                read_write_keys: vec![cred("RW", "rw-secret")],
            };
            let err = cache.resolve("photos", 0, &sources).unwrap_err();
            assert_eq!(err.status(), 412);
            assert_eq!(err.message(), "This bucket has no usable read-write key");
            cache.clear(&KeyMutation::AllowBucketKey {
                bucket_id: "photos".into(),
            });
            sources.explicit_key = Some(cred("KEYB", "secret"));
            assert_eq!(
                cache
                    .resolve("photos", 1, &sources)
                    .unwrap()
                    .access_key_id(),
                "KEYB"
            );
        }

        #[test]
        fn allow_and_update_clear_the_matching_entry() {
            let mut cache = CredentialCache::new(60);
            let mut photos = explicit("OLD");
            assert_eq!(
                cache.resolve("photos", 0, &photos).unwrap().access_key_id(),
                "OLD"
            );
            let kept = explicit("KEEP");
            assert_eq!(
                cache.resolve("other", 0, &kept).unwrap().access_key_id(),
                "KEEP"
            );
            cache.clear(&KeyMutation::AllowBucketKey {
                bucket_id: "photos".into(),
            });
            photos.explicit_key = Some(cred("NEW", "secret"));
            assert_eq!(
                cache.resolve("photos", 1, &photos).unwrap().access_key_id(),
                "NEW"
            );
            assert_eq!(
                cache.resolve("other", 1, &kept).unwrap().access_key_id(),
                "KEEP"
            );

            let mut project = CredentialSources {
                project_key: Some(cred("PROJECT", "old-secret")),
                explicit_key: None,
                read_write_keys: vec![cred("RW", "rw-secret")],
            };
            assert_eq!(
                cache.resolve("album", 2, &project).unwrap().secret_key(),
                "old-secret"
            );
            cache.clear(&KeyMutation::UpdateKey {
                key_id: "PROJECT".into(),
            });
            project.project_key = Some(cred("PROJECT", "new-secret"));
            assert_eq!(
                cache.resolve("album", 3, &project).unwrap().secret_key(),
                "new-secret"
            );
            assert_eq!(
                cache.resolve("other", 3, &kept).unwrap().access_key_id(),
                "KEEP"
            );
        }

        #[test]
        fn ttl_is_at_most_60_seconds() {
            let mut cache = CredentialCache::new(120);
            let mut sources = explicit("KEYA");
            assert_eq!(
                cache
                    .resolve("photos", 1_000, &sources)
                    .unwrap()
                    .access_key_id(),
                "KEYA"
            );
            sources.explicit_key = Some(cred("KEYB", "secret"));
            assert_eq!(
                cache
                    .resolve("photos", 1_059, &sources)
                    .unwrap()
                    .access_key_id(),
                "KEYA"
            );
            assert_eq!(
                cache
                    .resolve("photos", 1_060, &sources)
                    .unwrap()
                    .access_key_id(),
                "KEYB"
            );
        }

        #[test]
        fn forbidden_runs_the_operation_once_more() {
            let mut cache = CredentialCache::new(60);
            let mut loads = 0;
            let mut seen = Vec::new();
            let result = cache.read(
                "photos",
                0,
                || {
                    loads += 1;
                    if loads == 1 {
                        explicit("OLD")
                    } else {
                        explicit("NEW")
                    }
                },
                |credential| {
                    seen.push(credential.access_key_id().to_string());
                    if credential.access_key_id() == "OLD" {
                        Operation::Forbidden
                    } else {
                        Operation::Done(credential.access_key_id().to_string())
                    }
                },
            );
            assert_eq!(result, Ok("NEW".to_string()));
            assert_eq!(seen, vec!["OLD".to_string(), "NEW".to_string()]);
        }

        #[test]
        fn second_forbidden_stays_a_failure() {
            let mut cache = CredentialCache::new(60);
            let mut calls = 0;
            let result: Result<&str, ReadFailure> = cache.read(
                "photos",
                0,
                || explicit("KEYA"),
                |_| {
                    calls += 1;
                    Operation::Forbidden
                },
            );
            assert_eq!(calls, 2);
            assert_eq!(result, Err(ReadFailure::Forbidden));
            assert_eq!(
                cache
                    .resolve("photos", 1, &explicit("KEYB"))
                    .unwrap()
                    .access_key_id(),
                "KEYB"
            );
        }
    }
}
