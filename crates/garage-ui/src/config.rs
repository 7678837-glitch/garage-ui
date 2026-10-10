use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::password::PRODUCTION_BCRYPT_COST;

pub const JSON_BODY_LIMIT: usize = 1024 * 1024;
const DEFAULT_UPLOAD_MB: u64 = 512;
const DEFAULT_ABSOLUTE_SECS: u64 = 24 * 60 * 60;
const DEFAULT_IDLE_SECS: u64 = 2 * 60 * 60;
const MAX_DURATION_SECS: u64 = 365 * 24 * 60 * 60;

const AUTH_OFF: &[&str] = &["AUTH_DISABLED", "DISABLE_AUTH", "GARAGE_UI_NO_AUTH"];

const PLACEHOLDERS: &[&str] = &[
    "changeme",
    "replace-me",
    "your_admin_token",
    "your_metrics_token",
    "your_session_key",
    "example",
];

pub struct ProjectKey {
    pub access_key_id: String,
    pub secret_access_key: String,
}

pub struct Settings {
    pub data_dir: PathBuf,
    pub base_path: String,
    pub cookie_path: String,
    pub cookie_secure: bool,
    pub session_absolute: Duration,
    pub session_idle: Duration,
    pub bcrypt_cost: u32,
    pub json_body_limit: usize,
    pub max_upload_bytes: u64,
    pub fanout_in_flight: NonZeroUsize,
    pub s3_region: String,
    pub website_root_domain: String,
    pub public_s3_url: Option<String>,
    pub s3_endpoint_url: Option<String>,
    pub garage_admin_url: Option<String>,
    pub update_url: Option<String>,
    pub base_tag: String,
    pub garage_admin_token: Option<String>,
    pub metrics_token: Option<String>,
    pub project_key: Option<ProjectKey>,
    pub trusted_proxy: bool,
    pub redact_secrets: Vec<String>,
}

pub enum KeyMaterial {
    Generate,
    Provided(Vec<u8>),
}

pub struct Loaded {
    pub settings: Settings,
    pub key: KeyMaterial,
}

impl Settings {
    pub fn share_enabled(&self) -> bool {
        self.public_s3_url
            .as_ref()
            .is_some_and(|url| !url.is_empty())
    }
}

pub fn load_process() -> anyhow::Result<Loaded> {
    let mut env = read_dotenv();
    for (key, value) in std::env::vars_os() {
        let Some(key) = key.to_str() else {
            continue;
        };
        if AUTH_OFF.contains(&key) {
            anyhow::bail!("不允许关闭鉴权");
        }
        if let Some(value) = value.to_str() {
            env.insert(key.to_string(), value.to_string());
        }
    }
    load_map(&env)
}

pub fn load_map(env: &HashMap<String, String>) -> anyhow::Result<Loaded> {
    for key in AUTH_OFF {
        if env.contains_key(*key) {
            anyhow::bail!("不允许关闭鉴权");
        }
    }
    let data_dir = PathBuf::from(env.get("DATA_DIR").map(String::as_str).unwrap_or("./data"));
    let base_path = normalize_base(env.get("BASE_PATH").map(String::as_str).unwrap_or(""))?;
    let base_tag = base_tag(&base_path);
    let cookie_path = if base_path.is_empty() {
        "/".to_string()
    } else {
        base_path.clone()
    };
    let cookie_secure = cookie_secure(env.get("COOKIE_SECURE").map(String::as_str))?;
    let session_absolute = duration_or_default(
        env.get("SESSION_ABSOLUTE_SECS").map(String::as_str),
        DEFAULT_ABSOLUTE_SECS,
    );
    let session_idle = duration_or_default(
        env.get("SESSION_IDLE_SECS").map(String::as_str),
        DEFAULT_IDLE_SECS,
    );
    let max_upload_mb = match env.get("MAX_UPLOAD_SIZE_MB").map(String::as_str) {
        Some(value) => value
            .parse::<u64>()
            .ok()
            .filter(|mb| (1..=10240).contains(mb)),
        None => Some(DEFAULT_UPLOAD_MB),
    }
    .unwrap_or(DEFAULT_UPLOAD_MB);
    let garage_admin_token = optional_secret(env, "API_ADMIN_KEY_FILE", "GARAGE_ADMIN_TOKEN")?;
    let metrics_token = optional_secret(env, "METRICS_TOKEN_FILE", "GARAGE_METRICS_TOKEN")?;
    let project_key = project_key(env)?;
    let key = session_key(env)?;
    let mut redact_secrets = Vec::new();
    if let Some(token) = garage_admin_token.clone() {
        redact_secrets.push(token);
    }
    if let Some(token) = metrics_token.clone() {
        redact_secrets.push(token);
    }
    if let Some(pair) = &project_key {
        if pair.access_key_id.len() >= 8 {
            redact_secrets.push(pair.access_key_id.clone());
        }
        if pair.secret_access_key.len() >= 8 {
            redact_secrets.push(pair.secret_access_key.clone());
        }
    }
    if let KeyMaterial::Provided(bytes) = &key
        && let Ok(text) = std::str::from_utf8(bytes)
        && text.len() >= 8
    {
        redact_secrets.push(text.to_string());
    }
    let public_s3_url = endpoint_from(env, "S3_PUBLIC_ENDPOINT_URL", Some("PUBLIC_S3_URL"));
    let s3_endpoint_url = endpoint_from(env, "S3_ENDPOINT_URL", None);
    let garage_admin_url = endpoint_from(env, "API_BASE_URL", Some("GARAGE_ADMIN_URL"));
    let update_url = env
        .get("UPDATE_URL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(Loaded {
        settings: Settings {
            data_dir,
            base_path,
            base_tag,
            cookie_path,
            cookie_secure,
            session_absolute,
            session_idle,
            bcrypt_cost: PRODUCTION_BCRYPT_COST,
            json_body_limit: JSON_BODY_LIMIT,
            max_upload_bytes: max_upload_mb.saturating_mul(1024 * 1024),
            fanout_in_flight: fanout_in_flight(env.get("FANOUT_LIMIT").map(String::as_str)),
            s3_region: env
                .get("S3_REGION")
                .cloned()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "garage".to_string()),
            website_root_domain: env.get("WEBSITE_ROOT_DOMAIN").cloned().unwrap_or_default(),
            public_s3_url,
            s3_endpoint_url,
            garage_admin_url,
            update_url,
            garage_admin_token,
            metrics_token,
            project_key,
            trusted_proxy: env.get("TRUSTED_PROXY").map(String::as_str) == Some("true"),
            redact_secrets,
        },
        key,
    })
}

fn project_key(env: &HashMap<String, String>) -> anyhow::Result<Option<ProjectKey>> {
    let access_key_id = nonempty(env, "S3_ACCESS_KEY_ID");
    let secret_access_key = nonempty(env, "S3_SECRET_ACCESS_KEY");
    match (access_key_id, secret_access_key) {
        (None, None) => Ok(None),
        (Some(access_key_id), Some(secret_access_key)) => {
            if is_placeholder(access_key_id) || is_placeholder(secret_access_key) {
                anyhow::bail!("密钥与文档占位符相同，拒绝启动");
            }
            Ok(Some(ProjectKey {
                access_key_id: access_key_id.to_string(),
                secret_access_key: secret_access_key.to_string(),
            }))
        }
        _ => anyhow::bail!("对象存储密钥需要成对配置，拒绝启动"),
    }
}

fn nonempty<'a>(env: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    env.get(name)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

fn optional_secret(
    env: &HashMap<String, String>,
    file_key: &str,
    value_key: &str,
) -> anyhow::Result<Option<String>> {
    if let Some(path) = env.get(file_key).filter(|path| !path.is_empty()) {
        let bytes = read_secret_file(Path::new(path))?;
        return validate_token(&bytes);
    }
    match env.get(value_key) {
        Some(value) => validate_token(value.as_bytes()),
        None => Ok(None),
    }
}

fn session_key(env: &HashMap<String, String>) -> anyhow::Result<KeyMaterial> {
    let Some(path) = env.get("SESSION_KEY_FILE").filter(|path| !path.is_empty()) else {
        return Ok(KeyMaterial::Generate);
    };
    let bytes = read_secret_file(Path::new(path))?;
    let bytes = if bytes.len() == 48 {
        bytes
    } else {
        strip_trailing_newlines(bytes)
    };
    validate_key_material(&bytes)?;
    Ok(KeyMaterial::Provided(bytes))
}

pub fn validate_key_material(bytes: &[u8]) -> anyhow::Result<()> {
    // 短占位符（例如 YOUR_SESSION_KEY）和全零字节都先按占位符拒绝。
    if !bytes.is_empty() && bytes.iter().all(|byte| *byte == 0) {
        anyhow::bail!("密钥与文档占位符相同，拒绝启动");
    }
    if let Ok(text) = std::str::from_utf8(bytes)
        && is_placeholder(text)
    {
        anyhow::bail!("密钥与文档占位符相同，拒绝启动");
    }
    if bytes.len() < 32 {
        anyhow::bail!("密钥长度不足，拒绝启动");
    }
    Ok(())
}

fn validate_token(bytes: &[u8]) -> anyhow::Result<Option<String>> {
    let bytes = strip_trailing_newlines(bytes.to_vec());
    if bytes.is_empty() {
        return Ok(None);
    }
    let text = String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("密钥无法解析，拒绝启动"))?;
    if text.is_empty() {
        return Ok(None);
    }
    // 文档占位符有的短于 16 字节。先认占位符，否则 changeme 会被长度检查抢走文案。
    if is_placeholder(&text) {
        anyhow::bail!("密钥与文档占位符相同，拒绝启动");
    }
    if text.len() < 16 {
        anyhow::bail!("密钥长度不足，拒绝启动");
    }
    Ok(Some(text))
}

fn is_placeholder(text: &str) -> bool {
    PLACEHOLDERS
        .iter()
        .any(|name| text.eq_ignore_ascii_case(name))
        || (!text.is_empty() && text.chars().all(|ch| ch == '0'))
}

pub fn strip_trailing_newlines(mut bytes: Vec<u8>) -> Vec<u8> {
    while matches!(bytes.last(), Some(b'\n' | b'\r')) {
        bytes.pop();
    }
    bytes
}

fn read_secret_file(path: &Path) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path)
        .map_err(|error| anyhow::anyhow!("读取密钥文件失败: {}: {}", path.display(), error.kind()))
}

fn cookie_secure(value: Option<&str>) -> anyhow::Result<bool> {
    match value {
        None | Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => anyhow::bail!("COOKIE_SECURE 无法解析，拒绝启动"),
    }
}

fn fanout_in_flight(value: Option<&str>) -> NonZeroUsize {
    value
        .and_then(|text| text.parse::<usize>().ok())
        .and_then(NonZeroUsize::new)
        .unwrap_or(crate::limit::DEFAULT_FANOUT_IN_FLIGHT)
}

fn duration_or_default(value: Option<&str>, default: u64) -> Duration {
    let secs = value
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|secs| (1..=MAX_DURATION_SECS).contains(secs))
        .unwrap_or(default);
    Duration::from_secs(secs)
}

pub fn join(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return String::new();
    }
    let path = path.trim().trim_start_matches('/');
    if path.is_empty() {
        base.to_string()
    } else {
        format!("{base}/{path}")
    }
}

fn endpoint_from(
    env: &HashMap<String, String>,
    spec_key: &str,
    alias_key: Option<&str>,
) -> Option<String> {
    let pick = |key: &str| {
        let joined = join(env.get(key)?, "");
        if joined.is_empty() {
            None
        } else {
            Some(joined)
        }
    };
    pick(spec_key).or_else(|| alias_key.and_then(pick))
}

fn base_tag(base_path: &str) -> String {
    if base_path.is_empty() {
        "<base href=\"/\">".to_string()
    } else {
        format!("<base href=\"{base_path}/\">")
    }
}

// 更新检查默认关闭。没有地址时直接返回，避免构造请求。
pub fn maybe_check_updates(_update_url: Option<&str>) {}

fn normalize_base(raw: &str) -> anyhow::Result<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw == "/" {
        return Ok(String::new());
    }
    let mut path = if raw.starts_with('/') {
        raw.to_string()
    } else {
        format!("/{raw}")
    };
    while path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    let legal = path
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_'));
    if !legal || path.contains("//") {
        anyhow::bail!("BASE_PATH 无法解析");
    }
    Ok(path)
}

fn read_dotenv() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(text) = std::fs::read_to_string(".env") else {
        return map;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || map.contains_key(key) {
            continue;
        }
        let value = value.trim().trim_matches('"');
        map.insert(key.to_string(), value.to_string());
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn auth_switches_and_bad_secrets_fail_closed() {
        let cases = [
            vec![("AUTH_DISABLED", "1")],
            vec![("DISABLE_AUTH", "")],
            vec![("GARAGE_UI_NO_AUTH", "no")],
            vec![("GARAGE_ADMIN_TOKEN", "changeme")],
            vec![("GARAGE_ADMIN_TOKEN", "short")],
            vec![("GARAGE_METRICS_TOKEN", "YOUR_METRICS_TOKEN")],
            vec![("COOKIE_SECURE", "yes")],
            vec![("GARAGE_ADMIN_TOKEN", "0000000000000000")],
        ];
        for pairs in cases {
            let Err(err) = load_map(&map(&pairs)) else {
                panic!("must fail");
            };
            let text = format!("{err:#}");
            assert!(!text.contains("planted-admin-token-9f3a"), "{text}");
            assert!(
                text.contains("不允许关闭鉴权")
                    || text.contains("拒绝启动")
                    || text.contains("无法解析"),
                "{text}"
            );
        }
    }

    #[test]
    fn file_secret_wins_and_empty_token_is_allowed() {
        let dir = crate::util::temp_dir();
        let path = dir.join("admin.key");
        std::fs::write(&path, b"file-admin-token-ok\n").unwrap();
        let loaded = load_map(&map(&[
            ("DATA_DIR", dir.to_str().unwrap()),
            ("API_ADMIN_KEY_FILE", path.to_str().unwrap()),
            ("GARAGE_ADMIN_TOKEN", "env-admin-token-nope"),
            ("GARAGE_METRICS_TOKEN", ""),
            ("COOKIE_SECURE", "false"),
            ("SESSION_ABSOLUTE_SECS", "nope"),
            ("SESSION_IDLE_SECS", "0"),
        ]))
        .unwrap();
        assert_eq!(
            loaded.settings.garage_admin_token.as_deref(),
            Some("file-admin-token-ok")
        );
        assert!(loaded.settings.metrics_token.is_none());
        assert!(!loaded.settings.cookie_secure);
        assert_eq!(
            loaded.settings.session_absolute,
            Duration::from_secs(24 * 60 * 60)
        );
        assert_eq!(
            loaded.settings.session_idle,
            Duration::from_secs(2 * 60 * 60)
        );
        assert_eq!(loaded.settings.bcrypt_cost, 12);
        assert!(
            loaded
                .settings
                .redact_secrets
                .iter()
                .any(|secret| secret == "file-admin-token-ok")
        );
        assert!(
            !loaded
                .settings
                .redact_secrets
                .iter()
                .any(|secret| secret == "env-admin-token-nope")
        );
    }

    #[test]
    fn missing_secret_file_names_the_path_only() {
        let Err(err) = load_map(&map(&[
            ("API_ADMIN_KEY_FILE", "/tmp/garage-ui-missing-admin-key"),
            ("GARAGE_ADMIN_TOKEN", "planted-admin-token-9f3a"),
        ])) else {
            panic!("missing file must fail");
        };
        let text = format!("{err:#}");
        assert!(text.contains("/tmp/garage-ui-missing-admin-key"));
        assert!(!text.contains("planted-admin-token-9f3a"));
    }

    #[test]
    fn trailing_slash_joins_the_same_admin_url() {
        let plain = load_map(&map(&[("GARAGE_ADMIN_URL", "http://127.0.0.1:3900")])).unwrap();
        let slashed = load_map(&map(&[("API_BASE_URL", "http://127.0.0.1:3900/")])).unwrap();
        assert_eq!(
            plain.settings.garage_admin_url.as_deref(),
            Some("http://127.0.0.1:3900")
        );
        assert_eq!(
            slashed.settings.garage_admin_url.as_deref(),
            Some("http://127.0.0.1:3900")
        );
        assert_eq!(
            join("http://127.0.0.1:3900", "v2/GetClusterStatus"),
            "http://127.0.0.1:3900/v2/GetClusterStatus"
        );
        assert_eq!(
            join("http://127.0.0.1:3900/", "v2/GetClusterStatus"),
            "http://127.0.0.1:3900/v2/GetClusterStatus"
        );
    }

    #[test]
    fn slash_only_endpoint_is_unset() {
        let loaded = load_map(&map(&[
            ("API_BASE_URL", "///"),
            ("GARAGE_ADMIN_URL", "/"),
            ("S3_ENDPOINT_URL", "//"),
            ("S3_PUBLIC_ENDPOINT_URL", " / "),
            ("PUBLIC_S3_URL", "/"),
        ]))
        .unwrap();
        assert!(loaded.settings.garage_admin_url.is_none());
        assert!(loaded.settings.s3_endpoint_url.is_none());
        assert!(loaded.settings.public_s3_url.is_none());
        assert!(!loaded.settings.share_enabled());
    }

    #[test]
    fn spec_endpoint_name_wins_when_both_are_set() {
        let loaded = load_map(&map(&[
            ("API_BASE_URL", "http://127.0.0.1:3900/"),
            ("GARAGE_ADMIN_URL", "http://127.0.0.1:9/"),
            ("S3_PUBLIC_ENDPOINT_URL", "http://127.0.0.1:3901/"),
            ("PUBLIC_S3_URL", "http://127.0.0.1:9/"),
            ("S3_ENDPOINT_URL", "http://127.0.0.1:3902/"),
        ]))
        .unwrap();
        assert_eq!(
            loaded.settings.garage_admin_url.as_deref(),
            Some("http://127.0.0.1:3900")
        );
        assert_eq!(
            loaded.settings.public_s3_url.as_deref(),
            Some("http://127.0.0.1:3901")
        );
        assert_eq!(
            loaded.settings.s3_endpoint_url.as_deref(),
            Some("http://127.0.0.1:3902")
        );
        let alias = load_map(&map(&[("PUBLIC_S3_URL", "http://127.0.0.1:3903/")])).unwrap();
        assert_eq!(
            alias.settings.public_s3_url.as_deref(),
            Some("http://127.0.0.1:3903")
        );
    }

    #[test]
    fn crlf_token_file_bearer_has_no_cr_or_lf() {
        let dir = crate::util::temp_dir();
        let path = dir.join("admin.key");
        std::fs::write(&path, b"file-admin-token-ok\r\n").unwrap();
        let loaded = load_map(&map(&[
            ("DATA_DIR", dir.to_str().unwrap()),
            ("API_ADMIN_KEY_FILE", path.to_str().unwrap()),
            ("GARAGE_ADMIN_TOKEN", "env-admin-token-nope"),
        ]))
        .unwrap();
        let token = loaded.settings.garage_admin_token.expect("token");
        assert_eq!(token, "file-admin-token-ok");
        assert!(!token.as_bytes().contains(&b'\r'));
        assert!(!token.as_bytes().contains(&b'\n'));
    }

    #[tokio::test]
    async fn maybe_check_updates_with_no_url_performs_no_connect() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let loaded = load_map(&map(&[])).unwrap();
        assert!(loaded.settings.update_url.is_none());
        let probe = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_millis(200), listener.accept()).await
        });
        maybe_check_updates(loaded.settings.update_url.as_deref());
        assert!(
            probe.await.unwrap().is_err(),
            "maybe_check_updates contacted 127.0.0.1:{port}"
        );
    }

    #[test]
    fn fanout_limit_falls_back_to_eight_unless_positive() {
        let unset = load_map(&map(&[])).unwrap();
        assert_eq!(unset.settings.fanout_in_flight.get(), 8);
        for value in ["0", "-1", "nope", "1.5", ""] {
            let loaded = load_map(&map(&[("FANOUT_LIMIT", value)])).unwrap();
            assert_eq!(loaded.settings.fanout_in_flight.get(), 8, "{value}");
        }
        let two = load_map(&map(&[("FANOUT_LIMIT", "2")])).unwrap();
        assert_eq!(two.settings.fanout_in_flight.get(), 2);
        let wide = load_map(&map(&[("FANOUT_LIMIT", "1000000")])).unwrap();
        assert_eq!(wide.settings.fanout_in_flight.get(), 1_000_000);
    }

    #[test]
    fn base_path_sets_cookie_path() {
        let loaded = load_map(&map(&[("BASE_PATH", "console/")])).unwrap();
        assert_eq!(loaded.settings.base_path, "/console");
        assert_eq!(loaded.settings.cookie_path, "/console");
        assert!(loaded.settings.cookie_secure);
    }

    #[test]
    fn project_key_is_absent_when_both_sides_are_unset() {
        let missing = load_map(&map(&[])).unwrap();
        assert!(missing.settings.project_key.is_none());
        let empty = load_map(&map(&[
            ("S3_ACCESS_KEY_ID", ""),
            ("S3_SECRET_ACCESS_KEY", ""),
        ]))
        .unwrap();
        assert!(empty.settings.project_key.is_none());
    }

    #[test]
    fn project_key_stores_the_pair_without_a_length_minimum() {
        let mixed = load_map(&map(&[
            ("S3_ACCESS_KEY_ID", " gk1"),
            ("S3_SECRET_ACCESS_KEY", "sec ret-value"),
        ]))
        .unwrap();
        let pair = mixed.settings.project_key.expect("pair");
        assert_eq!(pair.access_key_id, " gk1");
        assert_eq!(pair.secret_access_key, "sec ret-value");
        assert_eq!(
            mixed.settings.redact_secrets,
            vec!["sec ret-value".to_string()]
        );
        let both = load_map(&map(&[
            ("S3_ACCESS_KEY_ID", "access-key-1"),
            ("S3_SECRET_ACCESS_KEY", "secret-key-1"),
        ]))
        .unwrap();
        assert_eq!(
            both.settings.redact_secrets,
            vec!["access-key-1".to_string(), "secret-key-1".to_string()]
        );
    }

    #[test]
    fn half_project_key_refuses_startup_without_the_value() {
        let planted = "only-access-key-value";
        let Err(err) = load_map(&map(&[("S3_ACCESS_KEY_ID", planted)])) else {
            panic!("half pair must fail");
        };
        let text = format!("{err:#}");
        assert!(
            text.contains("对象存储密钥需要成对配置，拒绝启动"),
            "{text}"
        );
        assert!(!text.contains(planted), "{text}");
        let planted_secret = "only-secret-key-value";
        let Err(err) = load_map(&map(&[
            ("S3_ACCESS_KEY_ID", ""),
            ("S3_SECRET_ACCESS_KEY", planted_secret),
        ])) else {
            panic!("half pair must fail");
        };
        let text = format!("{err:#}");
        assert!(
            text.contains("对象存储密钥需要成对配置，拒绝启动"),
            "{text}"
        );
        assert!(!text.contains(planted_secret), "{text}");
    }

    #[test]
    fn placeholder_project_key_refuses_startup_without_the_value() {
        let planted = "real-secret-value-9f3a";
        for access in ["ChangeMe", "0000", "EXAMPLE"] {
            let Err(err) = load_map(&map(&[
                ("S3_ACCESS_KEY_ID", access),
                ("S3_SECRET_ACCESS_KEY", planted),
            ])) else {
                panic!("placeholder must fail: {access}");
            };
            let text = format!("{err:#}");
            assert!(text.contains("密钥与文档占位符相同，拒绝启动"), "{text}");
            assert!(!text.contains(planted), "{text}");
            assert!(!text.contains(access), "{text}");
        }
        let Err(err) = load_map(&map(&[
            ("S3_ACCESS_KEY_ID", planted),
            ("S3_SECRET_ACCESS_KEY", "REPLACE-ME"),
        ])) else {
            panic!("placeholder secret must fail");
        };
        let text = format!("{err:#}");
        assert!(text.contains("密钥与文档占位符相同，拒绝启动"), "{text}");
        assert!(!text.contains(planted), "{text}");
        assert!(!text.contains("REPLACE-ME"), "{text}");
    }
}
