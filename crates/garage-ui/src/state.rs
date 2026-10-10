use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex;

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

#[derive(Clone)]
pub struct App {
    pub db: sqlx::SqlitePool,
    pub settings: Arc<Settings>,
    pub limits: Arc<Limits>,
    pub dummy_hash: Arc<String>,
    pub http: reqwest::Client,
    pub fixtures: Arc<std::sync::Mutex<HashMap<String, Fixture>>>,
    pub write: Arc<Mutex<()>>,
    pub key_id: Arc<String>,
    #[cfg(test)]
    pub log_sink: Arc<std::sync::Mutex<Vec<String>>>,
}

impl App {
    pub fn record_access(&self, line: &str) {
        #[cfg(test)]
        self.log_sink
            .lock()
            .expect("log sink")
            .push(line.to_string());
        let _ = line;
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
    let cost = loaded.settings.bcrypt_cost;
    let dummy_password = util::random_bytes(32)?;
    let dummy_hash = password::hash_async(hex_encode(&dummy_password), cost)
        .await
        .map_err(|_| anyhow::anyhow!("无法初始化口令校验"))?;
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context_client()?;
    Ok(App {
        db: pool,
        settings: Arc::new(loaded.settings),
        limits: Arc::new(Limits::new(quota)),
        dummy_hash: Arc::new(dummy_hash),
        http,
        fixtures: Arc::new(std::sync::Mutex::new(HashMap::new())),
        write: Arc::new(Mutex::new(())),
        key_id: Arc::new(key_id),
        #[cfg(test)]
        log_sink: Arc::new(std::sync::Mutex::new(Vec::new())),
    })
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
