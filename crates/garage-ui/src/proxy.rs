use axum::body::Body;
use axum::http::{HeaderMap, Method, Response, StatusCode};
use serde_json::Value;

use crate::access::{self, Op};
use crate::config;
use crate::db::{self, AuditEvent, User};
use crate::error::ApiError;
use crate::state::{App, GarageLink, S3Probe};

#[derive(Clone, Copy, Debug)]
pub struct Endpoint {
    pub name: &'static str,
    pub method: &'static str,
    pub op: Op,
    pub confirm: bool,
    pub audit: bool,
    pub writes: bool,
}

const fn ep(
    name: &'static str,
    method: &'static str,
    op: Op,
    confirm: bool,
    audit: bool,
    writes: bool,
) -> Endpoint {
    Endpoint {
        name,
        method,
        op,
        confirm,
        audit,
        writes,
    }
}

pub fn endpoints() -> &'static [Endpoint] {
    &ENDPOINTS
}

pub fn find_endpoint(name: &str, method: &str) -> Option<&'static Endpoint> {
    endpoints()
        .iter()
        .find(|endpoint| endpoint.name == name && endpoint.method == method)
}

pub fn endpoint_name(path: &str) -> Option<&str> {
    let path = path.trim_matches('/');
    if path == "health" || path == "metrics" {
        return Some(path);
    }
    let rest = path.strip_prefix("v2/")?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest)
}

pub fn forwarded_query(name: &str, raw: Option<&str>) -> String {
    let Some(raw) = raw.filter(|query| !query.is_empty()) else {
        return String::new();
    };
    if name != "GetKeyInfo" {
        return raw.to_string();
    }
    raw.split('&')
        .filter(|pair| {
            let key = pair.split('=').next().unwrap_or("").to_ascii_lowercase();
            key == "id" || key == "search"
        })
        .collect::<Vec<_>>()
        .join("&")
}

pub fn confirmed(headers: &HeaderMap) -> bool {
    headers
        .get("x-confirm")
        .and_then(|value| value.to_str().ok())
        == Some("yes")
}

// 转发需要身份、方法和上游请求材料，少一项就组不出请求。
#[allow(clippy::too_many_arguments)]
pub async fn dispatch(
    app: &App,
    user: &User,
    ip: &str,
    method: &Method,
    path: &str,
    query: Option<&str>,
    body: &[u8],
    headers: &HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let Some(name) = endpoint_name(path) else {
        return Err(ApiError::not_found());
    };
    let Some(endpoint) = find_endpoint(name, method.as_str()) else {
        return Err(ApiError::not_found());
    };
    if !access::permits(user.actor(), endpoint.op) {
        audit(
            app,
            user,
            ip,
            "denied",
            "forbidden",
            method.as_str(),
            path,
            name,
            403,
        )
        .await?;
        return Err(ApiError::forbidden("forbidden", "Not allowed"));
    }
    if endpoint.confirm && !confirmed(headers) {
        return Err(ApiError::forbidden(
            "confirmation_required",
            "Confirmation required",
        ));
    }
    if endpoint.writes {
        let link = ensure_garage_link(app).await;
        if !link.writes_allowed {
            audit(
                app,
                user,
                ip,
                "error",
                "garage_too_old",
                method.as_str(),
                path,
                name,
                409,
            )
            .await?;
            return Err(ApiError::conflict(
                "garage_too_old",
                "Garage v2.3.0 or newer is required",
            ));
        }
    }
    let filtered = forwarded_query(name, query);
    let response = match send(app, name, method, &filtered, body).await {
        Ok(response) => response,
        Err(error) => {
            if endpoint.writes {
                audit(
                    app,
                    user,
                    ip,
                    "error",
                    error.code(),
                    method.as_str(),
                    path,
                    name,
                    i64::from(error.status_code().as_u16()),
                )
                .await?;
            }
            return Err(error);
        }
    };
    if response.status().is_success()
        && let Some(mutation) = credential_mutation(name, &filtered, body)
    {
        app.clear_credential_cache(&mutation).await;
    }
    if endpoint.audit {
        let status = i64::from(response.status().as_u16());
        audit(
            app,
            user,
            ip,
            "success",
            "ok",
            method.as_str(),
            path,
            name,
            status,
        )
        .await?;
    }
    Ok(response)
}

// 收到任意 HTTP 响应即视为已应答。不读版本，避免把旧 Garage 当成未就绪。
pub(crate) async fn garage_answered(app: &App) -> bool {
    exchange(app, "GetNodeInfo", &Method::GET, "node=self", &[])
        .await
        .is_ok()
}

pub async fn ensure_garage_link(app: &App) -> GarageLink {
    let Some(url) = app.settings.garage_admin_url.clone() else {
        return GarageLink::unknown();
    };
    if app.settings.garage_admin_token.is_none() {
        return GarageLink::unknown();
    }
    app.garage_link_for(&url, probe_node_info(app)).await
}

async fn probe_node_info(app: &App) -> GarageLink {
    let Ok(response) = send(app, "GetNodeInfo", &Method::GET, "node=self", &[]).await else {
        return GarageLink::unknown();
    };
    if !response.status().is_success() {
        return GarageLink::unknown();
    }
    let Ok(bytes) = axum::body::to_bytes(response.into_body(), 1024 * 1024).await else {
        return GarageLink::unknown();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return GarageLink::unknown();
    };
    GarageLink::from_reported(reported_garage_version(&value))
}

// v2.4.1 的 GetNodeInfo 是 MultiResponse，garageVersion 在 success 的节点对象里。
fn reported_garage_version(value: &Value) -> Option<&str> {
    if let Some(version) = value.get("garageVersion").and_then(Value::as_str) {
        return Some(version);
    }
    let nodes = value.get("success").and_then(Value::as_object)?;
    let mut found: Option<&str> = None;
    for node in nodes.values() {
        let Some(version) = node.get("garageVersion").and_then(Value::as_str) else {
            continue;
        };
        match found {
            None => found = Some(version),
            Some(current) if current == version => {}
            Some(_) => return None,
        }
    }
    found
}

// connectionParameters sits on the same object as garageVersion.
// A v2.4 MultiResponse keeps that object under success.
pub async fn s3_origin(app: &App) -> (Option<String>, String) {
    let configured_endpoint = app.settings.s3_endpoint_url.clone();
    let configured_region = app.settings.configured_s3_region.clone();
    if let (Some(endpoint), Some(region)) = (configured_endpoint.clone(), configured_region.clone())
    {
        return (Some(endpoint), region);
    }
    let probed = app.cached_s3_probe(read_s3_probe(app)).await;
    let endpoint = configured_endpoint.or(probed.endpoint);
    let region = configured_region
        .or(probed.region)
        .unwrap_or_else(|| app.settings.s3_region.clone());
    (endpoint, region)
}

fn empty_probe() -> S3Probe {
    S3Probe {
        endpoint: None,
        region: None,
    }
}

async fn read_s3_probe(app: &App) -> S3Probe {
    let Ok(response) = send(app, "GetNodeInfo", &Method::GET, "node=self", &[]).await else {
        return empty_probe();
    };
    if !response.status().is_success() {
        return empty_probe();
    }
    let Ok(bytes) = axum::body::to_bytes(response.into_body(), 1024 * 1024).await else {
        return empty_probe();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return empty_probe();
    };
    s3_probe_from(&value)
}

fn s3_probe_from(value: &Value) -> S3Probe {
    let carriers = connection_carriers(value);
    S3Probe {
        endpoint: agreed(carriers.iter().copied(), "s3Endpoint").and_then(normalize_s3_endpoint),
        region: agreed(carriers.iter().copied(), "s3Region"),
    }
}

fn connection_carriers(value: &Value) -> Vec<&Value> {
    if value.get("garageVersion").is_some() {
        return vec![value];
    }
    let Some(nodes) = value.get("success").and_then(Value::as_object) else {
        return Vec::new();
    };
    nodes
        .values()
        .filter(|node| node.get("garageVersion").is_some())
        .collect()
}

fn agreed<'a>(carriers: impl Iterator<Item = &'a Value>, field: &str) -> Option<String> {
    let mut found = None;
    for carrier in carriers {
        let Some(text) = carrier
            .get("connectionParameters")
            .and_then(Value::as_object)
            .and_then(|params| params.get(field))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        else {
            continue;
        };
        match &found {
            None => found = Some(text.to_string()),
            Some(current) if current == text => {}
            Some(_) => return None,
        }
    }
    found
}

fn normalize_s3_endpoint(raw: String) -> Option<String> {
    let joined = config::join(&raw, "");
    (!joined.is_empty()).then_some(joined)
}

pub async fn fetch_key_secret(app: &App, id: &str) -> Result<Response<Body>, ApiError> {
    let query = format!("id={}&showSecretKey=true", percent_encode(id));
    send(app, "GetKeyInfo", &Method::GET, &query, &[]).await
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

async fn send(
    app: &App,
    name: &str,
    method: &Method,
    query: &str,
    body: &[u8],
) -> Result<Response<Body>, ApiError> {
    let upstream = present(exchange(app, name, method, query, body).await?);
    let mut response = Response::new(Body::from(upstream.bytes));
    *response.status_mut() = upstream.status;
    if let Some(content_type) = upstream.content_type
        && let Ok(value) = axum::http::HeaderValue::from_bytes(content_type.as_bytes())
    {
        response.headers_mut().insert("content-type", value);
    }
    Ok(response)
}

struct UpstreamBody {
    status: StatusCode,
    bytes: Vec<u8>,
    content_type: Option<reqwest::header::HeaderValue>,
}

fn present(upstream: UpstreamBody) -> UpstreamBody {
    let error = upstream.status.is_client_error() || upstream.status.is_server_error();
    if !error || serde_json::from_slice::<Value>(&upstream.bytes).is_ok() {
        return upstream;
    }
    UpstreamBody {
        status: upstream.status,
        bytes: crate::error::upstream_error_json(upstream.status.as_u16(), &upstream.bytes),
        content_type: Some(reqwest::header::HeaderValue::from_static(
            "application/json",
        )),
    }
}

fn upstream_failure(upstream: UpstreamBody) -> ApiError {
    let shown = present(upstream);
    let content_type = shown
        .content_type
        .and_then(|header| axum::http::HeaderValue::from_bytes(header.as_bytes()).ok());
    ApiError::upstream(shown.status, shown.bytes, content_type)
}

async fn exchange(
    app: &App,
    name: &str,
    method: &Method,
    query: &str,
    body: &[u8],
) -> Result<UpstreamBody, ApiError> {
    let result = exchange_upstream(app, name, method, query, body).await;
    if result.is_err() {
        app.record_garage_error();
    }
    result
}

async fn exchange_upstream(
    app: &App,
    name: &str,
    method: &Method,
    query: &str,
    body: &[u8],
) -> Result<UpstreamBody, ApiError> {
    let Some(base) = app.settings.garage_admin_url.clone() else {
        return Err(garage_unconfigured());
    };
    let token = token_for(app, name)?;
    let url = upstream_url(&base, name, query);
    let reqwest_method = reqwest::Method::from_bytes(method.as_str().as_bytes())
        .map_err(|_| ApiError::not_found())?;
    let mut request = app.http.request(reqwest_method, &url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if !body.is_empty() {
        request = request.body(body.to_vec());
    }
    let upstream = request.send().await.map_err(admin_transport)?;
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .cloned();
    let bytes = upstream.bytes().await.map_err(admin_transport)?.to_vec();
    Ok(UpstreamBody {
        status,
        bytes,
        content_type,
    })
}

fn token_for(app: &App, name: &str) -> Result<Option<String>, ApiError> {
    match name {
        "health" => Ok(None),
        "metrics" => Ok(Some(
            app.settings
                .metrics_token
                .clone()
                .ok_or_else(garage_unconfigured)?,
        )),
        _ => Ok(Some(
            app.settings
                .garage_admin_token
                .clone()
                .ok_or_else(garage_unconfigured)?,
        )),
    }
}

fn upstream_url(base: &str, name: &str, query: &str) -> String {
    let path = if name == "health" || name == "metrics" {
        config::join(base, name)
    } else {
        config::join(base, &format!("v2/{name}"))
    };
    if query.is_empty() {
        path
    } else {
        format!("{path}?{query}")
    }
}

fn garage_unconfigured() -> ApiError {
    ApiError::unavailable("garage_unavailable", "Garage admin API is not configured")
}

fn garage_down() -> ApiError {
    ApiError::unavailable("garage_unavailable", "Garage admin API is not reachable")
}

// reqwest 错误正文可能含管理地址，响应里不保留它。
fn admin_transport(error: reqwest::Error) -> ApiError {
    if error.is_timeout() {
        ApiError::new(
            StatusCode::GATEWAY_TIMEOUT,
            "garage_timeout",
            "Garage admin API timed out",
        )
    } else {
        garage_down()
    }
}

fn credential_mutation(
    name: &str,
    query: &str,
    body: &[u8],
) -> Option<crate::state::credentials::KeyMutation> {
    use crate::state::credentials::KeyMutation;
    match name {
        "AllowBucketKey" => Some(KeyMutation::AllowBucketKey {
            bucket_id: json_string(body, "bucketId")?,
        }),
        "DenyBucketKey" => Some(KeyMutation::DenyBucketKey {
            bucket_id: json_string(body, "bucketId")?,
        }),
        // DeleteKey 与 UpdateKey 的 id 在 query，OpenAPI 没有把这个字段放进 body。
        "DeleteKey" => Some(KeyMutation::DeleteKey {
            key_id: query_value(query, "id")?,
        }),
        "UpdateKey" => Some(KeyMutation::UpdateKey {
            key_id: query_value(query, "id")?,
        }),
        _ => None,
    }
}

fn json_string(body: &[u8], field: &str) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let text = value.get(field)?.as_str()?;
    (!text.is_empty()).then(|| text.to_string())
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (name == key && !value.is_empty()).then(|| value.to_string())
    })
}

// api 接入前库目标看不到分页入口，整段会变成死代码。
#[allow(dead_code)]
mod lists {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    use serde::Serialize;

    use super::*;
    use crate::limit;

    fn garage_unreadable() -> ApiError {
        ApiError::unavailable(
            "garage_unavailable",
            "Garage admin API returned an unreadable list",
        )
    }

    #[derive(Clone, Copy)]
    struct Catalog {
        info: &'static str,
        ids: &'static str,
        detail: &'static str,
    }

    const BUCKETS: Catalog = Catalog {
        info: "ListBucketsInfo",
        ids: "ListBuckets",
        detail: "GetBucketInfo",
    };

    const KEYS: Catalog = Catalog {
        info: "ListKeysInfo",
        ids: "ListKeys",
        detail: "GetKeyInfo",
    };

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Page {
        pub items: Vec<Value>,
        pub more: bool,
    }

    #[derive(Clone, Copy, PartialEq, Eq, Default, Serialize)]
    #[serde(rename_all = "lowercase")]
    pub enum Probe {
        #[default]
        Unknown,
        Present,
        Absent,
    }

    pub struct ListProbes {
        pub buckets: Probe,
        pub keys: Probe,
    }

    struct Slot {
        probe: Probe,
        resume: HashMap<u64, String>,
    }

    impl Default for Slot {
        fn default() -> Self {
            Self {
                probe: Probe::Unknown,
                resume: HashMap::new(),
            }
        }
    }

    // 每个管理地址的探测只记确定结果。连接失败不能记成接口不存在。
    static PROBES: LazyLock<Mutex<HashMap<String, Slot>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    enum ProbeMiss {
        Absent,
        Down(ApiError),
    }

    pub async fn list_buckets(app: &App, offset: u64, limit: usize) -> Result<Page, ApiError> {
        list_catalog(app, BUCKETS, offset, limit).await
    }

    pub async fn list_keys(app: &App, offset: u64, limit: usize) -> Result<Page, ApiError> {
        list_catalog(app, KEYS, offset, limit).await
    }

    async fn list_catalog(
        app: &App,
        catalog: Catalog,
        offset: u64,
        limit: usize,
    ) -> Result<Page, ApiError> {
        let Some(base) = app.settings.garage_admin_url.clone() else {
            return Err(garage_unconfigured());
        };
        if app.settings.garage_admin_token.is_none() {
            return Err(garage_unconfigured());
        }
        let key = probe_key(&base, catalog.info);
        match probe_of(&key) {
            Probe::Absent => absent_page(app, catalog, offset, limit).await,
            Probe::Present => present_page(app, catalog, &key, offset, limit)
                .await
                .map_err(miss_to_error),
            Probe::Unknown => match present_page(app, catalog, &key, offset, limit).await {
                Ok(page) => Ok(page),
                Err(ProbeMiss::Absent) => {
                    remember_absent(&key);
                    absent_page(app, catalog, offset, limit).await
                }
                Err(ProbeMiss::Down(error)) => Err(error),
            },
        }
    }

    fn miss_to_error(miss: ProbeMiss) -> ApiError {
        match miss {
            ProbeMiss::Absent => garage_down(),
            ProbeMiss::Down(error) => error,
        }
    }

    pub fn list_probes(admin_url: Option<&str>) -> ListProbes {
        let Some(base) = admin_url else {
            return ListProbes {
                buckets: Probe::Unknown,
                keys: Probe::Unknown,
            };
        };
        ListProbes {
            buckets: probe_of(&probe_key(base, BUCKETS.info)),
            keys: probe_of(&probe_key(base, KEYS.info)),
        }
    }

    fn probe_key(base: &str, info: &str) -> String {
        format!("{base}\n{info}")
    }

    fn probe_of(key: &str) -> Probe {
        PROBES
            .lock()
            .expect("probe cache")
            .get(key)
            .map(|slot| slot.probe)
            .unwrap_or_default()
    }

    fn remember_present(key: &str) {
        let mut probes = PROBES.lock().expect("probe cache");
        let slot = probes.entry(key.to_string()).or_default();
        if slot.probe != Probe::Absent {
            slot.probe = Probe::Present;
        }
    }

    fn remember_absent(key: &str) {
        let mut probes = PROBES.lock().expect("probe cache");
        let slot = probes.entry(key.to_string()).or_default();
        if slot.probe == Probe::Unknown {
            slot.probe = Probe::Absent;
        }
    }

    fn remember_resume(key: &str, next_offset: u64, last_id: &str) {
        let mut probes = PROBES.lock().expect("probe cache");
        let slot = probes.entry(key.to_string()).or_default();
        slot.resume
            .entry(next_offset)
            .or_insert_with(|| last_id.to_string());
    }

    fn resume_for(key: &str, offset: u64) -> (u64, Option<String>) {
        let probes = PROBES.lock().expect("probe cache");
        let Some(slot) = probes.get(key) else {
            return (0, None);
        };
        let mut found: Option<(u64, String)> = None;
        for (at, id) in &slot.resume {
            if *at > offset {
                continue;
            }
            let replace = found.as_ref().is_none_or(|(best, _)| *at >= *best);
            if replace {
                found = Some((*at, id.clone()));
            }
        }
        match found {
            Some((at, id)) if at > 0 => (at, Some(id)),
            _ => (0, None),
        }
    }

    async fn present_page(
        app: &App,
        catalog: Catalog,
        key: &str,
        offset: u64,
        limit: usize,
    ) -> Result<Page, ProbeMiss> {
        let (mut at, mut cursor) = resume_for(key, offset);
        loop {
            let (items, more) = fetch_window(app, catalog, key, cursor.as_deref(), limit).await?;
            let last_id = items.last().and_then(item_id);
            if let Some(id) = last_id.as_deref() {
                let next_at = at.saturating_add(u64::try_from(items.len()).unwrap_or(u64::MAX));
                remember_resume(key, next_at, id);
            }
            if at == offset {
                return Ok(Page { items, more });
            }
            let Some(id) = last_id else {
                return Ok(Page {
                    items: Vec::new(),
                    more: false,
                });
            };
            let next_at = at.saturating_add(u64::try_from(items.len()).unwrap_or(u64::MAX));
            if next_at > offset {
                let skip = usize::try_from(offset - at).unwrap_or(usize::MAX);
                let page: Vec<Value> = items.into_iter().skip(skip).take(limit).collect();
                let more = page.len() == limit;
                return Ok(Page { items: page, more });
            }
            if !more {
                return Ok(Page {
                    items: Vec::new(),
                    more: false,
                });
            }
            cursor = Some(id);
            at = next_at;
        }
    }

    async fn fetch_window(
        app: &App,
        catalog: Catalog,
        key: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<Value>, bool), ProbeMiss> {
        // Garage 的 offset 是这一页第一条的 id，包含它自己。下一页要多取一条再丢掉重复的。
        let query = match cursor {
            None => format!("limit={limit}"),
            Some(id) => format!(
                "offset={}&limit={}",
                percent_encode(id),
                limit.saturating_add(1)
            ),
        };
        let upstream = exchange(app, catalog.info, &Method::GET, &query, &[])
            .await
            .map_err(ProbeMiss::Down)?;
        if upstream.status == StatusCode::NOT_FOUND {
            return Err(ProbeMiss::Absent);
        }
        // v2.4.1 对未发布的列表接口回 400，正文含这句，和 404 一样表示接口不存在。
        const UNKNOWN_ENDPOINT: &[u8] = b"Unknown API endpoint";
        if upstream.status == StatusCode::BAD_REQUEST
            && upstream
                .bytes
                .windows(UNKNOWN_ENDPOINT.len())
                .any(|window| window == UNKNOWN_ENDPOINT)
        {
            return Err(ProbeMiss::Absent);
        }
        if upstream.status.is_client_error() || upstream.status.is_server_error() {
            return Err(ProbeMiss::Down(upstream_failure(upstream)));
        }
        if !upstream.status.is_success() {
            return Err(ProbeMiss::Down(garage_down()));
        }
        remember_present(key);
        let mut items = parse_array(&upstream.bytes).map_err(ProbeMiss::Down)?;
        if let Some(id) = cursor
            && items.first().and_then(item_id).as_deref() == Some(id)
        {
            items.remove(0);
        }
        if items.len() > limit {
            items.truncate(limit);
        }
        let more = items.len() == limit;
        Ok((items, more))
    }

    async fn absent_page(
        app: &App,
        catalog: Catalog,
        offset: u64,
        limit: usize,
    ) -> Result<Page, ApiError> {
        let upstream = exchange(app, catalog.ids, &Method::GET, "", &[]).await?;
        if upstream.status.is_client_error() || upstream.status.is_server_error() {
            return Err(upstream_failure(upstream));
        }
        if !upstream.status.is_success() {
            return Err(garage_down());
        }
        let all = parse_array(&upstream.bytes)?;
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        if start >= all.len() {
            return Ok(Page {
                items: Vec::new(),
                more: false,
            });
        }
        let mut ids = Vec::new();
        for item in all.iter().skip(start).take(limit) {
            let Some(id) = item_id(item) else {
                return Err(garage_unreadable());
            };
            ids.push(id);
        }
        let mut items = fetch_details(app, catalog.detail, ids).await?;
        if catalog.ids == BUCKETS.ids {
            // v2.3 的 GetBucketInfo 没有 localAliases，别名只在 ListBuckets 行上。
            keep_list_local_aliases(&all, &mut items);
        }
        // 回退路径手里是完整 id 列表。满页而且正好到末尾时，后面没有下一行。
        let more = start.saturating_add(items.len()) < all.len();
        Ok(Page { items, more })
    }

    fn keep_list_local_aliases(list_rows: &[Value], details: &mut [Value]) {
        for detail in details {
            let Some(id) = item_id(detail) else {
                continue;
            };
            let Some(row) = list_rows
                .iter()
                .find(|row| item_id(row).as_deref() == Some(id.as_str()))
            else {
                continue;
            };
            let Some(from_list) = row.get("localAliases").and_then(Value::as_array) else {
                continue;
            };
            let replace = match detail.get("localAliases").and_then(Value::as_array) {
                Some(existing) if !existing.is_empty() => false,
                Some(_) => !from_list.is_empty(),
                None => true,
            };
            if replace {
                detail["localAliases"] = Value::Array(from_list.clone());
            }
        }
    }

    async fn fetch_details(
        app: &App,
        endpoint: &'static str,
        ids: Vec<String>,
    ) -> Result<Vec<Value>, ApiError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let Some(base) = app.settings.garage_admin_url.clone() else {
            return Err(garage_unconfigured());
        };
        let Some(token) = app.settings.garage_admin_token.clone() else {
            return Err(garage_unconfigured());
        };
        let http = app.http.clone();
        let endpoint = endpoint.to_string();
        let results = limit::fan_out(app.settings.fanout_in_flight, ids, move |id| {
            let http = http.clone();
            let base = base.clone();
            let token = token.clone();
            let endpoint = endpoint.clone();
            async move { fetch_one(&http, &base, &token, &endpoint, &id).await }
        })
        .await;
        let mut items = Vec::with_capacity(results.len());
        for result in results {
            items.push(result?);
        }
        Ok(items)
    }

    async fn fetch_one(
        http: &reqwest::Client,
        base: &str,
        token: &str,
        endpoint: &str,
        id: &str,
    ) -> Result<Value, ApiError> {
        let query = format!("id={}", percent_encode(id));
        let url = upstream_url(base, endpoint, &query);
        let upstream = http
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(admin_transport)?;
        let status =
            StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let bytes = upstream.bytes().await.map_err(admin_transport)?;
        if !status.is_success() {
            return Err(garage_down());
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| garage_unreadable())?;
        Ok(ensure_item_id(value))
    }

    // GetKeyInfo 用 accessKeyId，没有 id。列表行仍要有 id，后面的改名和删除才能指到这条密钥。
    pub(super) fn ensure_item_id(mut value: Value) -> Value {
        let missing = value.get("id").and_then(Value::as_str).is_none();
        if missing
            && let Some(access_key_id) = value
                .get("accessKeyId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
        {
            value["id"] = Value::String(access_key_id.to_string());
        }
        value
    }

    fn parse_array(bytes: &[u8]) -> Result<Vec<Value>, ApiError> {
        let value: Value = serde_json::from_slice(bytes).map_err(|_| garage_unreadable())?;
        value.as_array().cloned().ok_or_else(garage_unreadable)
    }

    fn item_id(value: &Value) -> Option<String> {
        value
            .get("id")
            .and_then(|id| id.as_str())
            .map(str::to_string)
    }

    #[cfg(test)]
    mod tests {
        #[tokio::test]
        async fn fallback_path_reaches_the_last_bucket_in_twelve_list_calls() {
            super::super::tests::fallback_path_reaches_the_last_bucket_in_twelve_list_calls().await;
        }

        #[tokio::test]
        async fn fallback_bucket_keeps_the_list_local_alias() {
            super::super::tests::fallback_bucket_keeps_the_list_local_alias().await;
        }
    }
}

#[allow(dead_code, unused_imports)]
pub use lists::{ListProbes, Page, Probe, list_buckets, list_keys, list_probes};

// 参数就是审计表的列。
#[allow(clippy::too_many_arguments)]
pub async fn audit(
    app: &App,
    user: &User,
    ip: &str,
    result: &'static str,
    reason: &'static str,
    method: &str,
    path: &str,
    target: &str,
    status: i64,
) -> Result<(), ApiError> {
    db::insert_audit(
        &app.db,
        AuditEvent {
            username: &user.username,
            ip,
            result,
            reason,
            method,
            path,
            target,
            status,
        },
    )
    .await
    .map_err(|_| ApiError::internal())
}

static ENDPOINTS: [Endpoint; 50] = [
    ep("health", "GET", Op::ViewCluster, false, false, false),
    ep("metrics", "GET", Op::ViewMetrics, false, false, false),
    ep(
        "AddBucketAlias",
        "POST",
        Op::ChangeBuckets,
        false,
        true,
        true,
    ),
    ep(
        "AllowBucketKey",
        "POST",
        Op::ChangeBucketKeys,
        false,
        true,
        true,
    ),
    ep(
        "ApplyClusterLayout",
        "POST",
        Op::ChangeLayout,
        false,
        true,
        true,
    ),
    ep(
        "CleanupIncompleteUploads",
        "POST",
        Op::WriteObjects,
        false,
        true,
        true,
    ),
    ep(
        "ClusterLayoutSkipDeadNodes",
        "POST",
        Op::ChangeLayout,
        true,
        true,
        true,
    ),
    ep(
        "ConnectClusterNodes",
        "POST",
        Op::ChangeLayout,
        false,
        true,
        true,
    ),
    ep(
        "CreateAdminToken",
        "POST",
        Op::AdminTokens,
        true,
        true,
        true,
    ),
    ep("CreateBucket", "POST", Op::ChangeBuckets, false, true, true),
    ep("CreateKey", "POST", Op::ChangeKeys, false, true, true),
    ep(
        "CreateMetadataSnapshot",
        "POST",
        Op::RunOps,
        false,
        true,
        true,
    ),
    ep(
        "DeleteAdminToken",
        "POST",
        Op::AdminTokens,
        false,
        true,
        true,
    ),
    ep("DeleteBucket", "POST", Op::ChangeBuckets, false, true, true),
    ep("DeleteKey", "POST", Op::ChangeKeys, false, true, true),
    ep(
        "DenyBucketKey",
        "POST",
        Op::ChangeBucketKeys,
        false,
        true,
        true,
    ),
    ep(
        "GetAdminTokenInfo",
        "GET",
        Op::AdminTokens,
        false,
        false,
        false,
    ),
    ep("GetBlockInfo", "POST", Op::ViewOps, false, false, false),
    ep("GetBucketInfo", "GET", Op::ViewBuckets, false, false, false),
    ep(
        "GetClusterHealth",
        "GET",
        Op::ViewCluster,
        false,
        false,
        false,
    ),
    ep(
        "GetClusterLayout",
        "GET",
        Op::ViewCluster,
        false,
        false,
        false,
    ),
    ep(
        "GetClusterLayoutHistory",
        "GET",
        Op::ViewCluster,
        false,
        false,
        false,
    ),
    ep(
        "GetClusterStatistics",
        "GET",
        Op::ViewStats,
        false,
        false,
        false,
    ),
    ep(
        "GetClusterStatus",
        "GET",
        Op::ViewCluster,
        false,
        false,
        false,
    ),
    ep(
        "GetCurrentAdminTokenInfo",
        "GET",
        Op::AdminTokens,
        false,
        false,
        false,
    ),
    ep("GetKeyInfo", "GET", Op::ViewKeys, false, false, false),
    ep("GetNodeInfo", "GET", Op::ViewCluster, false, false, false),
    ep(
        "GetNodeStatistics",
        "GET",
        Op::ViewStats,
        false,
        false,
        false,
    ),
    ep("GetWorkerInfo", "POST", Op::ViewOps, false, false, false),
    ep(
        "GetWorkerVariable",
        "POST",
        Op::ViewOps,
        false,
        false,
        false,
    ),
    ep("ImportKey", "POST", Op::ChangeKeys, false, true, true),
    ep(
        "InspectObject",
        "GET",
        Op::InspectObject,
        false,
        false,
        false,
    ),
    ep(
        "LaunchRepairOperation",
        "POST",
        Op::RunOps,
        true,
        true,
        true,
    ),
    ep(
        "ListAdminTokens",
        "GET",
        Op::AdminTokens,
        false,
        false,
        false,
    ),
    ep("ListBlockErrors", "GET", Op::ViewOps, false, false, false),
    ep("ListBuckets", "GET", Op::ViewBuckets, false, false, false),
    ep(
        "ListBucketsInfo",
        "GET",
        Op::ViewBuckets,
        false,
        false,
        false,
    ),
    ep("ListKeys", "GET", Op::ViewKeys, false, false, false),
    ep("ListKeysInfo", "GET", Op::ViewKeys, false, false, false),
    ep("ListWorkers", "POST", Op::ViewOps, false, false, false),
    ep(
        "PreviewClusterLayoutChanges",
        "POST",
        Op::ChangeLayout,
        false,
        false,
        false,
    ),
    ep("PurgeBlocks", "POST", Op::RunOps, true, true, true),
    ep(
        "RemoveBucketAlias",
        "POST",
        Op::ChangeBuckets,
        false,
        true,
        true,
    ),
    ep("RetryBlockResync", "POST", Op::RunOps, false, true, true),
    ep(
        "RevertClusterLayout",
        "POST",
        Op::ChangeLayout,
        false,
        true,
        true,
    ),
    ep("SetWorkerVariable", "POST", Op::RunOps, true, true, true),
    ep(
        "UpdateAdminToken",
        "POST",
        Op::AdminTokens,
        true,
        true,
        true,
    ),
    ep("UpdateBucket", "POST", Op::ChangeBuckets, false, true, true),
    ep(
        "UpdateClusterLayout",
        "POST",
        Op::ChangeLayout,
        false,
        true,
        true,
    ),
    ep("UpdateKey", "POST", Op::ChangeKeys, false, true, true),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_matches_openapi_methods() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../openapi/garage-admin-v2.json");
        let text = std::fs::read_to_string(path).expect("openapi");
        let spec: serde_json::Value = serde_json::from_str(&text).unwrap();
        let paths = spec["paths"].as_object().unwrap();
        assert!(paths.contains_key("/check"));
        assert!(find_endpoint("check", "GET").is_none());
        for (path, item) in paths {
            if path == "/check" {
                continue;
            }
            let name = path.rsplit('/').next().unwrap();
            for method in ["get", "post", "put", "patch", "delete"] {
                if item.get(method).is_some() {
                    assert!(
                        find_endpoint(name, &method.to_ascii_uppercase()).is_some(),
                        "missing {method} {path}"
                    );
                }
            }
        }
        for endpoint in endpoints() {
            if endpoint.name == "ListBucketsInfo" || endpoint.name == "ListKeysInfo" {
                assert!(find_endpoint(endpoint.name, "GET").is_some());
                continue;
            }
            let path = if endpoint.name == "health" || endpoint.name == "metrics" {
                format!("/{}", endpoint.name)
            } else {
                format!("/v2/{}", endpoint.name)
            };
            let item = paths.get(&path).unwrap_or_else(|| panic!("extra {path}"));
            assert!(
                item.get(endpoint.method.to_ascii_lowercase()).is_some(),
                "{path} {}",
                endpoint.method
            );
        }
    }

    #[test]
    fn get_key_info_drops_show_secret_key() {
        let query = forwarded_query("GetKeyInfo", Some("id=abc&showSecretKey=true&search=k"));
        assert!(query.contains("id=abc"));
        assert!(query.contains("search=k"));
        assert!(!query.to_ascii_lowercase().contains("showsecretkey"));
        assert_eq!(
            forwarded_query("ListKeys", Some("showSecretKey=true")),
            "showSecretKey=true"
        );
    }

    #[test]
    fn only_mutating_endpoints_are_garage_writes() {
        let mut writes: Vec<_> = endpoints()
            .iter()
            .filter(|endpoint| endpoint.writes)
            .map(|endpoint| endpoint.name)
            .collect();
        writes.sort_unstable();
        assert_eq!(
            writes,
            [
                "AddBucketAlias",
                "AllowBucketKey",
                "ApplyClusterLayout",
                "CleanupIncompleteUploads",
                "ClusterLayoutSkipDeadNodes",
                "ConnectClusterNodes",
                "CreateAdminToken",
                "CreateBucket",
                "CreateKey",
                "CreateMetadataSnapshot",
                "DeleteAdminToken",
                "DeleteBucket",
                "DeleteKey",
                "DenyBucketKey",
                "ImportKey",
                "LaunchRepairOperation",
                "PurgeBlocks",
                "RemoveBucketAlias",
                "RetryBlockResync",
                "RevertClusterLayout",
                "SetWorkerVariable",
                "UpdateAdminToken",
                "UpdateBucket",
                "UpdateClusterLayout",
                "UpdateKey",
            ]
        );
        assert!(!find_endpoint("GetWorkerInfo", "POST").unwrap().writes);
        assert!(!find_endpoint("ListWorkers", "POST").unwrap().writes);
        assert!(
            !find_endpoint("PreviewClusterLayoutChanges", "POST")
                .unwrap()
                .writes
        );
    }

    fn reported_link(value: serde_json::Value) -> GarageLink {
        GarageLink::from_reported(reported_garage_version(&value))
    }

    #[test]
    fn reported_garage_version_keeps_flat_v2_4_1() {
        let link = reported_link(json!({"garageVersion": "v2.4.1"}));
        assert_eq!(link.version.as_deref(), Some("v2.4.1"));
        assert!(link.writes_allowed);
    }

    #[test]
    fn reported_garage_version_reads_nested_v2_4_1() {
        let link = reported_link(json!({
            "success": {"node-a": {"garageVersion": "v2.4.1"}},
            "error": {}
        }));
        assert_eq!(link.version.as_deref(), Some("v2.4.1"));
        assert!(link.writes_allowed);
    }

    #[test]
    fn reported_garage_version_reads_nested_v2_2_9() {
        let link = reported_link(json!({
            "success": {"node-a": {"garageVersion": "v2.2.9", "role": "gateway"}},
            "error": {}
        }));
        assert_eq!(link.version.as_deref(), Some("v2.2.9"));
        assert!(!link.writes_allowed);
    }

    #[test]
    fn reported_garage_version_empty_success_has_no_version() {
        let link = reported_link(json!({"success": {}, "error": {}}));
        assert_eq!(link.version, None);
        assert!(link.writes_allowed);
    }

    #[test]
    fn reported_garage_version_conflict_has_no_version() {
        let link = reported_link(json!({
            "success": {
                "node-a": {"garageVersion": "v2.4.1"},
                "node-b": {"garageVersion": "v2.2.9"}
            },
            "error": {}
        }));
        assert_eq!(link.version, None);
    }

    #[test]
    fn ensure_item_id_copies_access_key_id() {
        let filled = lists::ensure_item_id(json!({"accessKeyId": "GK1", "name": "lab-key"}));
        assert_eq!(filled["id"], "GK1");
        assert_eq!(filled["name"], "lab-key");
        let kept = lists::ensure_item_id(json!({"id": "already", "accessKeyId": "GK1"}));
        assert_eq!(kept["id"], "already");
        let empty = lists::ensure_item_id(json!({"accessKeyId": ""}));
        assert!(empty.get("id").is_none());
    }

    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use crate::state::{self, App};

    const ADMIN_TOKEN: &str = "admin-token-list-probe-9f3a";
    const METRICS_TOKEN: &str = "metrics-token-list-probe-9f3a";

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum AuthKind {
        None,
        Admin,
        Metrics,
        Other,
    }

    struct MockOpts {
        buckets: usize,
        keys: usize,
        bucket_info: u16,
        key_info: u16,
        hold_details: bool,
        info_failures: usize,
        local_alias: Option<String>,
    }

    struct Mock {
        url: String,
        inner: Arc<MockInner>,
        task: tokio::task::JoinHandle<()>,
    }

    struct MockInner {
        lines: Mutex<Vec<String>>,
        auths: Mutex<Vec<AuthKind>>,
        details: AtomicUsize,
        inflight: AtomicUsize,
        high: AtomicUsize,
        release: AtomicBool,
        info_failures_left: AtomicUsize,
        opts: MockOpts,
    }

    impl Drop for Mock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl Mock {
        async fn start(opts: MockOpts) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let inner = Arc::new(MockInner {
                lines: Mutex::new(Vec::new()),
                auths: Mutex::new(Vec::new()),
                details: AtomicUsize::new(0),
                inflight: AtomicUsize::new(0),
                high: AtomicUsize::new(0),
                release: AtomicBool::new(!opts.hold_details),
                info_failures_left: AtomicUsize::new(opts.info_failures),
                opts,
            });
            let serve_inner = Arc::clone(&inner);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        break;
                    };
                    let inner = Arc::clone(&serve_inner);
                    tokio::spawn(async move {
                        let _ = serve(socket, inner).await;
                    });
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                inner,
                task,
            }
        }

        fn lines(&self) -> Vec<String> {
            self.inner.lines.lock().expect("lines").clone()
        }

        fn auths(&self) -> Vec<AuthKind> {
            self.inner.auths.lock().expect("auths").clone()
        }
    }

    async fn serve(
        mut socket: tokio::net::TcpStream,
        inner: Arc<MockInner>,
    ) -> std::io::Result<()> {
        let header = read_headers(&mut socket).await?;
        let request_line = header.lines().next().unwrap_or("").to_string();
        let target = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .to_string();
        inner.lines.lock().expect("lines").push(request_line);
        inner
            .auths
            .lock()
            .expect("auths")
            .push(auth_kind(&header, ADMIN_TOKEN, METRICS_TOKEN));
        let path = target.split('?').next().unwrap_or("");
        if path.ends_with("ListBucketsInfo") || path.ends_with("ListKeysInfo") {
            let left =
                inner
                    .info_failures_left
                    .try_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                        value.checked_sub(1)
                    });
            if left.is_ok() {
                return Ok(());
            }
        }
        let (status, body) = route(&inner, path, &target).await;
        write_json(&mut socket, status, &body).await?;
        let _ = socket.shutdown().await;
        Ok(())
    }

    async fn route(inner: &MockInner, path: &str, target: &str) -> (&'static str, String) {
        match path {
            "/health" | "/metrics" => ("200 OK", r#"{"ok":true}"#.to_string()),
            "/v2/GetNodeInfo" => ("200 OK", r#"{"garageVersion":"v2.4.1"}"#.to_string()),
            "/v2/ListBucketsInfo" => info_page(inner.opts.bucket_info, inner.opts.buckets, target),
            "/v2/ListKeysInfo" => info_page(inner.opts.key_info, inner.opts.keys, target),
            "/v2/ListBuckets" => (
                "200 OK",
                id_page(inner.opts.buckets, inner.opts.local_alias.as_deref()),
            ),
            "/v2/ListKeys" => ("200 OK", id_page(inner.opts.keys, None)),
            "/v2/GetBucketInfo" | "/v2/GetKeyInfo" => {
                inner.details.fetch_add(1, Ordering::SeqCst);
                if inner.opts.hold_details {
                    let now = inner.inflight.fetch_add(1, Ordering::SeqCst) + 1;
                    inner.high.fetch_max(now, Ordering::SeqCst);
                    while !inner.release.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    inner.inflight.fetch_sub(1, Ordering::SeqCst);
                }
                let id = query(target, "id").unwrap_or_default();
                ("200 OK", json!({"id": id, "via": "detail"}).to_string())
            }
            _ => ("404 Not Found", r#"{"error":"not found"}"#.to_string()),
        }
    }

    fn info_page(status: u16, count: usize, target: &str) -> (&'static str, String) {
        if status == 404 {
            return ("404 Not Found", r#"{"error":"not found"}"#.to_string());
        }
        if status == 400 {
            return (
                "400 Bad Request",
                r#"{"message":"Unknown API endpoint"}"#.to_string(),
            );
        }
        // 422 只给测试用：线上仍是 400，但 message 不含未知端点，不能当成接口不存在。
        if status == 422 {
            return (
                "400 Bad Request",
                r#"{"message":"limit is not valid"}"#.to_string(),
            );
        }
        let limit = query(target, "limit")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(count);
        let start = query(target, "offset")
            .map(|id| {
                (0..count)
                    .find(|index| row_id(*index) == id)
                    .unwrap_or(count)
            })
            .unwrap_or(0);
        let end = start.saturating_add(limit).min(count);
        let items: Vec<_> = (start..end)
            .map(|index| json!({"id": row_id(index), "via": "info"}))
            .collect();
        ("200 OK", serde_json::to_string(&items).unwrap())
    }

    fn id_page(count: usize, local_alias: Option<&str>) -> String {
        let items: Vec<_> = (0..count)
            .map(|index| {
                let mut row = json!({"id": row_id(index), "via": "ids"});
                if let Some(alias) = local_alias {
                    row["localAliases"] = json!([{
                        "accessKeyId": "GK-list",
                        "alias": alias,
                    }]);
                }
                row
            })
            .collect();
        serde_json::to_string(&items).unwrap()
    }

    fn row_id(index: usize) -> String {
        format!("{index:05}")
    }

    fn query(target: &str, key: &str) -> Option<String> {
        let query = target.split_once('?')?.1;
        query.split('&').find_map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (name == key).then(|| value.to_string())
        })
    }

    fn auth_kind(header: &str, admin: &str, metrics: &str) -> AuthKind {
        for line in header.lines() {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if !name.eq_ignore_ascii_case("authorization") {
                continue;
            }
            let token = value.trim().strip_prefix("Bearer ").unwrap_or(value.trim());
            if token == admin {
                return AuthKind::Admin;
            }
            if token == metrics {
                return AuthKind::Metrics;
            }
            return AuthKind::Other;
        }
        AuthKind::None
    }

    async fn read_headers(socket: &mut tokio::net::TcpStream) -> std::io::Result<String> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..read]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() > 65536 {
                break;
            }
        }
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    async fn write_json(
        socket: &mut tokio::net::TcpStream,
        status: &str,
        body: &str,
    ) -> std::io::Result<()> {
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await
    }

    async fn app_at(url: &str) -> App {
        let dir = crate::util::temp_dir();
        state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", url),
                ("GARAGE_ADMIN_TOKEN", ADMIN_TOKEN),
                ("GARAGE_METRICS_TOKEN", METRICS_TOKEN),
            ],
            crate::limit::test_quota(),
        )
        .await
    }

    fn ids_of(page: &Page) -> Vec<String> {
        page.items
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn info_path_reaches_the_last_bucket_in_twelve_list_calls() {
        let mock = Mock::start(MockOpts {
            buckets: 12000,
            keys: 0,
            bucket_info: 200,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let app = app_at(&mock.url).await;
        let mut ids = Vec::new();
        for step in 0..12 {
            let page = list_buckets(&app, step * 1000, 1000).await.unwrap();
            assert_eq!(page.items.len(), 1000, "page {step}");
            assert!(page.more, "page {step} hid the rest");
            assert_eq!(page.items[0]["via"], "info");
            ids.extend(ids_of(&page));
        }
        assert_eq!(ids.len(), 12000);
        assert_eq!(ids[0], "00000");
        assert_eq!(ids[1000], "01000");
        assert_eq!(ids[11000], "11000");
        assert_eq!(ids[11999], "11999");
        let lines = mock.lines();
        let info: Vec<_> = lines
            .iter()
            .filter(|line| line.contains("ListBucketsInfo"))
            .collect();
        assert_eq!(info.len(), 12);
        assert!(
            info.iter()
                .all(|line| line.contains("GET /v2/ListBucketsInfo?"))
        );
        assert!(info[0].contains("limit=1000"));
        assert!(!info[0].contains("offset="));
        assert!(info[1].contains("offset=00999&limit=1001"));
        assert!(info[11].contains("offset=10999&limit=1001"));
        assert!(lines.iter().all(|line| !line.contains("GetBucketInfo")));
        assert!(lines.iter().all(|line| !line.contains(ADMIN_TOKEN)));
        assert!(mock.auths().iter().all(|kind| *kind == AuthKind::Admin));
    }

    pub(crate) async fn fallback_path_reaches_the_last_bucket_in_twelve_list_calls() {
        let mock = Mock::start(MockOpts {
            buckets: 12000,
            keys: 0,
            bucket_info: 404,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let app = app_at(&mock.url).await;
        let first = list_buckets(&app, 0, 1000).await.unwrap();
        assert_eq!(first.items.len(), 1000);
        assert!(first.more);
        assert_eq!(first.items[0]["id"], "00000");
        assert_eq!(first.items[0]["via"], "detail");
        let marked = mock.lines().len();
        let last = list_buckets(&app, 11000, 1000).await.unwrap();
        assert_eq!(last.items.len(), 1000);
        assert_eq!(last.items[0]["id"], "11000");
        assert_eq!(last.items[999]["id"], "11999");
        assert_eq!(last.items[0]["via"], "detail");
        assert!(!last.more);
        let detail: Vec<_> = mock.lines()[marked..]
            .iter()
            .filter(|line| line.contains("GetBucketInfo"))
            .cloned()
            .collect();
        assert_eq!(detail.len(), 1000);
        for line in &detail {
            let id = line
                .split("id=")
                .nth(1)
                .and_then(|value| value.split([' ', '&']).next())
                .and_then(|value| value.parse::<usize>().ok())
                .expect(line);
            assert!((11000..12000).contains(&id), "{line}");
        }

        let keys = Mock::start(MockOpts {
            buckets: 0,
            keys: 3,
            bucket_info: 404,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let key_app = app_at(&keys.url).await;
        let last_key = list_keys(&key_app, 2, 1).await.unwrap();
        assert_eq!(ids_of(&last_key), ["00002"]);
        assert_eq!(last_key.items[0]["via"], "detail");
        assert!(!last_key.more);
    }

    pub(crate) async fn fallback_bucket_keeps_the_list_local_alias() {
        let mock = Mock::start(MockOpts {
            buckets: 2,
            keys: 0,
            bucket_info: 404,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
            local_alias: Some("a&b=c".to_string()),
        })
        .await;
        let app = app_at(&mock.url).await;
        let page = list_buckets(&app, 0, 10).await.unwrap();
        assert_eq!(page.items[0]["id"], "00000");
        assert_eq!(page.items[0]["via"], "detail");
        assert_eq!(
            page.items[0]["localAliases"],
            json!([{
                "accessKeyId": "GK-list",
                "alias": "a&b=c"
            }])
        );
    }

    #[tokio::test]
    async fn short_page_has_no_more_and_full_page_does() {
        let mock = Mock::start(MockOpts {
            buckets: 0,
            keys: 2,
            bucket_info: 404,
            key_info: 200,
            hold_details: false,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let app = app_at(&mock.url).await;
        let short = list_keys(&app, 0, 10).await.unwrap();
        assert_eq!(ids_of(&short), ["00000", "00001"]);
        assert!(!short.more);
        assert_eq!(short.items[0]["via"], "info");
        let full = list_keys(&app, 0, 2).await.unwrap();
        assert_eq!(full.items.len(), 2);
        assert!(full.more);
        let next = list_keys(&app, 2, 2).await.unwrap();
        assert!(next.items.is_empty());
        assert!(!next.more);
        let lines = mock.lines();
        assert!(lines.iter().all(|line| line.contains("/v2/ListKeysInfo?")));
        assert!(lines.iter().all(|line| !line.contains("GetKeyInfo")));
    }

    #[tokio::test]
    async fn absent_bucket_page_keeps_details_at_or_under_eight() {
        let mock = Mock::start(MockOpts {
            buckets: 1500,
            keys: 0,
            bucket_info: 404,
            key_info: 404,
            hold_details: true,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let app = app_at(&mock.url).await;
        let app_task = app.clone();
        let task = tokio::spawn(async move { list_buckets(&app_task, 0, 1000).await });
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let now = mock.inner.inflight.load(Ordering::SeqCst);
            assert!(now <= 8, "in flight {now}");
            if now == 8 {
                tokio::task::yield_now().await;
                let again = mock.inner.inflight.load(Ordering::SeqCst);
                assert!(again <= 8, "in flight {again}");
                break;
            }
            assert!(Instant::now() < deadline, "in flight stayed at {now}");
            tokio::task::yield_now().await;
        }
        mock.inner.release.store(true, Ordering::SeqCst);
        let page = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .expect("detail page")
            .unwrap()
            .unwrap();
        assert_eq!(page.items.len(), 1000);
        assert!(page.more);
        assert_eq!(page.items[0]["via"], "detail");
        assert_eq!(page.items[0]["id"], "00000");
        assert_eq!(page.items[999]["id"], "00999");
        assert!(mock.inner.high.load(Ordering::SeqCst) <= 8);
        assert_eq!(mock.inner.details.load(Ordering::SeqCst), 1000);
        let lines = mock.lines();
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("ListBucketsInfo"))
                .count(),
            1
        );
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("ListBuckets "))
                .count(),
            1
        );
        assert!(lines.iter().all(|line| !line.contains("id=01000")));
        assert!(lines.iter().all(|line| !line.contains(ADMIN_TOKEN)));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(ADMIN_TOKEN));
    }

    #[tokio::test]
    async fn fanout_limit_two_keeps_details_at_or_under_two() {
        let mock = Mock::start(MockOpts {
            buckets: 40,
            keys: 0,
            bucket_info: 404,
            key_info: 404,
            hold_details: true,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", mock.url.as_str()),
                ("GARAGE_ADMIN_TOKEN", ADMIN_TOKEN),
                ("GARAGE_METRICS_TOKEN", METRICS_TOKEN),
                ("FANOUT_LIMIT", "2"),
            ],
            crate::limit::test_quota(),
        )
        .await;
        assert_eq!(app.settings.fanout_in_flight.get(), 2);
        let app_task = app.clone();
        let task = tokio::spawn(async move { list_buckets(&app_task, 0, 40).await });
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let now = mock.inner.inflight.load(Ordering::SeqCst);
            assert!(now <= 2, "in flight {now}");
            if now == 2 {
                tokio::task::yield_now().await;
                let again = mock.inner.inflight.load(Ordering::SeqCst);
                assert!(again <= 2, "in flight {again}");
                break;
            }
            assert!(Instant::now() < deadline, "in flight stayed at {now}");
            tokio::task::yield_now().await;
        }
        mock.inner.release.store(true, Ordering::SeqCst);
        let page = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .expect("detail page")
            .unwrap()
            .unwrap();
        assert_eq!(page.items.len(), 40);
        assert_eq!(page.items[0]["id"], "00000");
        assert_eq!(page.items[39]["id"], "00039");
        assert_eq!(page.items[0]["via"], "detail");
        assert!(mock.inner.high.load(Ordering::SeqCst) <= 2);
        assert_eq!(mock.inner.details.load(Ordering::SeqCst), 40);
    }

    #[tokio::test]
    async fn probe_once_per_admin_url_and_connection_failure_is_not_absent() {
        let first = Mock::start(MockOpts {
            buckets: 3,
            keys: 4,
            bucket_info: 404,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let second = Mock::start(MockOpts {
            buckets: 1,
            keys: 0,
            bucket_info: 404,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let first_app = app_at(&first.url).await;
        let page = list_buckets(&first_app, 0, 10).await.unwrap();
        assert_eq!(page.items.len(), 3);
        assert!(!page.more);
        assert_eq!(page.items[0]["via"], "detail");
        let again = list_buckets(&first_app, 0, 10).await.unwrap();
        assert_eq!(again.items.len(), 3);
        let keys = list_keys(&first_app, 0, 2).await.unwrap();
        assert_eq!(keys.items.len(), 2);
        assert!(keys.more);
        assert_eq!(keys.items[0]["via"], "detail");
        let keys_again = list_keys(&first_app, 2, 2).await.unwrap();
        assert_eq!(ids_of(&keys_again), ["00002", "00003"]);
        assert!(!keys_again.more);
        let keys_done = list_keys(&first_app, 4, 2).await.unwrap();
        assert!(keys_done.items.is_empty());
        assert!(!keys_done.more);
        let first_lines = first.lines();
        assert_eq!(
            first_lines
                .iter()
                .filter(|line| line.contains("ListBucketsInfo"))
                .count(),
            1
        );
        assert_eq!(
            first_lines
                .iter()
                .filter(|line| line.contains("ListKeysInfo"))
                .count(),
            1
        );
        assert_eq!(
            first_lines
                .iter()
                .filter(|line| line.contains("GetKeyInfo"))
                .count(),
            4
        );

        let second_app = app_at(&second.url).await;
        let other = list_buckets(&second_app, 0, 10).await.unwrap();
        assert_eq!(other.items.len(), 1);
        assert_eq!(
            second
                .lines()
                .iter()
                .filter(|line| line.contains("ListBucketsInfo"))
                .count(),
            1
        );

        let flaky = Mock::start(MockOpts {
            buckets: 1,
            keys: 0,
            bucket_info: 200,
            key_info: 404,
            hold_details: false,
            info_failures: 1,
            local_alias: None,
        })
        .await;
        let flaky_app = app_at(&flaky.url).await;
        assert!(list_buckets(&flaky_app, 0, 10).await.is_err());
        let recovered = list_buckets(&flaky_app, 0, 10).await.unwrap();
        assert_eq!(recovered.items[0]["via"], "info");
        assert_eq!(recovered.items[0]["id"], "00000");
        let flaky_lines = flaky.lines();
        assert_eq!(
            flaky_lines
                .iter()
                .filter(|line| line.contains("ListBucketsInfo"))
                .count(),
            2
        );
        assert!(
            flaky_lines
                .iter()
                .all(|line| !line.contains("ListBuckets "))
        );
    }

    #[tokio::test]
    async fn unknown_endpoint_list_falls_back_to_id_lists() {
        let mock = Mock::start(MockOpts {
            buckets: 2,
            keys: 3,
            bucket_info: 400,
            key_info: 400,
            hold_details: false,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let app = app_at(&mock.url).await;
        let buckets = list_buckets(&app, 0, 10).await.unwrap();
        assert_eq!(ids_of(&buckets), ["00000", "00001"]);
        assert!(!buckets.more);
        assert_eq!(buckets.items[0]["via"], "detail");
        let keys = list_keys(&app, 0, 10).await.unwrap();
        assert_eq!(ids_of(&keys), ["00000", "00001", "00002"]);
        assert!(!keys.more);
        assert_eq!(keys.items[0]["via"], "detail");
        let probes = list_probes(app.settings.garage_admin_url.as_deref());
        assert!(probes.buckets == Probe::Absent);
        assert!(probes.keys == Probe::Absent);
        let lines = mock.lines();
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("ListBucketsInfo"))
                .count(),
            1
        );
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("ListKeysInfo"))
                .count(),
            1
        );
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("ListBuckets "))
                .count(),
            1
        );
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("ListKeys "))
                .count(),
            1
        );
        let again = list_buckets(&app, 0, 10).await.unwrap();
        assert_eq!(ids_of(&again), ["00000", "00001"]);
        assert_eq!(again.items[0]["via"], "detail");
        assert_eq!(
            mock.lines()
                .iter()
                .filter(|line| line.contains("ListBucketsInfo"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn unknown_endpoint_list_falls_back_leaves_other_400_down() {
        let mock = Mock::start(MockOpts {
            buckets: 2,
            keys: 0,
            bucket_info: 422,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let app = app_at(&mock.url).await;
        assert!(list_buckets(&app, 0, 10).await.is_err());
        let lines = mock.lines();
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("ListBucketsInfo"))
                .count(),
            1
        );
        assert!(lines.iter().all(|line| !line.contains("ListBuckets ")));
        assert!(lines.iter().all(|line| !line.contains("GetBucketInfo")));
        let probes = list_probes(app.settings.garage_admin_url.as_deref());
        assert!(probes.buckets != Probe::Absent);
        assert!(probes.keys != Probe::Absent);
    }

    #[tokio::test]
    async fn health_and_metrics_stay_unversioned_and_keep_the_query() {
        let mock = Mock::start(MockOpts {
            buckets: 0,
            keys: 0,
            bucket_info: 404,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
            local_alias: None,
        })
        .await;
        let app = app_at(&mock.url).await;
        let health = send(&app, "health", &Method::GET, "ready=1", &[])
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        let metrics = send(&app, "metrics", &Method::GET, "job=ui", &[])
            .await
            .unwrap();
        assert_eq!(metrics.status(), StatusCode::OK);
        let node = send(&app, "GetNodeInfo", &Method::GET, "node=self", &[])
            .await
            .unwrap();
        assert_eq!(node.status(), StatusCode::OK);
        assert_eq!(
            mock.lines(),
            [
                "GET /health?ready=1 HTTP/1.1".to_string(),
                "GET /metrics?job=ui HTTP/1.1".to_string(),
                "GET /v2/GetNodeInfo?node=self HTTP/1.1".to_string(),
            ]
        );
        assert_eq!(
            mock.auths(),
            [AuthKind::None, AuthKind::Metrics, AuthKind::Admin]
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(ADMIN_TOKEN));
        assert!(!sink.contains(METRICS_TOKEN));
        assert!(mock.lines().iter().all(|line| !line.contains(ADMIN_TOKEN)));
        assert!(
            mock.lines()
                .iter()
                .all(|line| !line.contains(METRICS_TOKEN))
        );
    }

    const CACHED_SECRET: &str = "secret-key-do-not-log";

    struct RawAdmin {
        url: String,
        lines: Arc<Mutex<Vec<String>>>,
        codes: Arc<Mutex<std::collections::HashMap<String, u16>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for RawAdmin {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl RawAdmin {
        async fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let lines = Arc::new(Mutex::new(Vec::new()));
            let codes = Arc::new(Mutex::new(std::collections::HashMap::new()));
            let serve_lines = Arc::clone(&lines);
            let serve_codes = Arc::clone(&codes);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let lines = Arc::clone(&serve_lines);
                    let codes = Arc::clone(&serve_codes);
                    tokio::spawn(async move {
                        let header = consume_request(&mut socket).await.unwrap_or_default();
                        let request_line = header.lines().next().unwrap_or("").to_string();
                        lines.lock().expect("lines").push(request_line.clone());
                        let path = request_line
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or("")
                            .split('?')
                            .next()
                            .unwrap_or("");
                        let name = path.rsplit('/').next().unwrap_or("");
                        let code = if name == "GetNodeInfo" {
                            200
                        } else {
                            codes
                                .lock()
                                .expect("codes")
                                .get(name)
                                .copied()
                                .unwrap_or(404)
                        };
                        let status = match code {
                            200 => "200 OK",
                            500 => "500 Internal Server Error",
                            _ => "404 Not Found",
                        };
                        let body = if name == "GetNodeInfo" {
                            r#"{"garageVersion":"v2.3.0"}"#
                        } else {
                            "{}"
                        };
                        let _ = write_json(&mut socket, status, body).await;
                        let _ = socket.shutdown().await;
                    });
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                lines,
                codes,
                task,
            }
        }

        fn set(&self, name: &str, code: u16) {
            self.codes
                .lock()
                .expect("codes")
                .insert(name.to_string(), code);
        }

        fn lines(&self) -> Vec<String> {
            self.lines.lock().expect("lines").clone()
        }
    }

    async fn consume_request(socket: &mut tokio::net::TcpStream) -> std::io::Result<String> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        let header_end = loop {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                break None;
            }
            buf.extend_from_slice(&tmp[..read]);
            if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                break Some(pos + 4);
            }
            if buf.len() > 65536 {
                break None;
            }
        };
        let Some(header_end) = header_end else {
            return Ok(String::from_utf8_lossy(&buf).into_owned());
        };
        let header = String::from_utf8_lossy(&buf[..header_end]).into_owned();
        let length = content_length(&header);
        let mut have = buf.len() - header_end;
        while have < length {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                break;
            }
            have += read;
        }
        Ok(header)
    }

    fn content_length(header: &str) -> usize {
        header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0)
    }

    fn bucket_sources(id: &str) -> crate::state::credentials::CredentialSources {
        use crate::state::credentials::{BucketCredential, CredentialSources};
        CredentialSources {
            project_key: None,
            explicit_key: Some(BucketCredential::new(id, CACHED_SECRET)),
            read_write_keys: Vec::new(),
        }
    }

    async fn admin_user(app: &App) -> crate::db::User {
        crate::db::insert_user(&app.db, "ada", "hash", "admin", false, false)
            .await
            .unwrap();
        crate::db::find_user_by_name(&app.db, "ada")
            .await
            .unwrap()
            .unwrap()
    }

    async fn post_admin(
        app: &App,
        user: &crate::db::User,
        path: &str,
        query: Option<&str>,
        body: &[u8],
    ) -> Response<Body> {
        dispatch(
            app,
            user,
            "127.0.0.1",
            &Method::POST,
            path,
            query,
            body,
            &HeaderMap::new(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn successful_deny_drops_the_cached_credential_and_a_500_keeps_it() {
        let upstream = RawAdmin::start().await;
        upstream.set("DenyBucketKey", 200);
        let app = app_at(&upstream.url).await;
        let user = admin_user(&app).await;
        assert_eq!(
            app.resolve_bucket_credential("photos", 0, &bucket_sources("KEYA"))
                .await
                .unwrap()
                .access_key_id(),
            "KEYA"
        );
        assert_eq!(
            app.resolve_bucket_credential("other", 0, &bucket_sources("KEEP"))
                .await
                .unwrap()
                .access_key_id(),
            "KEEP"
        );
        let body = br#"{"bucketId":"photos","accessKeyId":"KEYA","permissions":{"read":true}}"#;
        let ok = post_admin(&app, &user, "v2/DenyBucketKey", None, body).await;
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(
            app.resolve_bucket_credential("photos", 1, &bucket_sources("KEYB"))
                .await
                .unwrap()
                .access_key_id(),
            "KEYB"
        );
        assert_eq!(
            app.resolve_bucket_credential("other", 1, &bucket_sources("CHANGED"))
                .await
                .unwrap()
                .access_key_id(),
            "KEEP"
        );

        assert_eq!(
            app.resolve_bucket_credential("photos", 61, &bucket_sources("KEYA"))
                .await
                .unwrap()
                .access_key_id(),
            "KEYA"
        );
        upstream.set("DenyBucketKey", 500);
        let failed = post_admin(&app, &user, "v2/DenyBucketKey", None, body).await;
        assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            app.resolve_bucket_credential("photos", 62, &bucket_sources("KEYB"))
                .await
                .unwrap()
                .access_key_id(),
            "KEYA"
        );
        let lines = upstream.lines();
        assert!(
            lines
                .iter()
                .any(|line| line.contains("POST /v2/DenyBucketKey "))
        );
        assert!(lines.iter().all(|line| !line.contains(ADMIN_TOKEN)));
        assert!(lines.iter().all(|line| !line.contains(CACHED_SECRET)));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(ADMIN_TOKEN));
        assert!(!sink.contains(CACHED_SECRET));
    }

    #[tokio::test]
    async fn delete_and_update_clear_the_key_named_in_the_query() {
        let upstream = RawAdmin::start().await;
        upstream.set("DeleteKey", 200);
        upstream.set("UpdateKey", 200);
        let app = app_at(&upstream.url).await;
        let user = admin_user(&app).await;
        let key = bucket_sources("KEYA");
        assert_eq!(
            app.resolve_bucket_credential("photos", 0, &key)
                .await
                .unwrap()
                .access_key_id(),
            "KEYA"
        );
        assert_eq!(
            app.resolve_bucket_credential("album", 0, &key)
                .await
                .unwrap()
                .access_key_id(),
            "KEYA"
        );
        assert_eq!(
            app.resolve_bucket_credential("other", 0, &bucket_sources("KEEP"))
                .await
                .unwrap()
                .access_key_id(),
            "KEEP"
        );
        let deleted = post_admin(&app, &user, "v2/DeleteKey", Some("id=KEYA"), b"").await;
        assert_eq!(deleted.status(), StatusCode::OK);
        assert_eq!(
            app.resolve_bucket_credential("photos", 1, &bucket_sources("KEYB"))
                .await
                .unwrap()
                .access_key_id(),
            "KEYB"
        );
        assert_eq!(
            app.resolve_bucket_credential("album", 1, &bucket_sources("KEYB"))
                .await
                .unwrap()
                .access_key_id(),
            "KEYB"
        );
        assert_eq!(
            app.resolve_bucket_credential("other", 1, &bucket_sources("CHANGED"))
                .await
                .unwrap()
                .access_key_id(),
            "KEEP"
        );

        assert_eq!(
            app.resolve_bucket_credential("photos", 61, &key)
                .await
                .unwrap()
                .access_key_id(),
            "KEYA"
        );
        let updated = post_admin(
            &app,
            &user,
            "v2/UpdateKey",
            Some("id=KEYA"),
            br#"{"name":"renamed"}"#,
        )
        .await;
        assert_eq!(updated.status(), StatusCode::OK);
        assert_eq!(
            app.resolve_bucket_credential("photos", 62, &bucket_sources("KEYC"))
                .await
                .unwrap()
                .access_key_id(),
            "KEYC"
        );
        let lines = upstream.lines();
        assert!(
            lines
                .iter()
                .any(|line| line.contains("POST /v2/DeleteKey?id=KEYA "))
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("POST /v2/UpdateKey?id=KEYA "))
        );
        assert!(lines.iter().all(|line| !line.contains(ADMIN_TOKEN)));
        assert!(lines.iter().all(|line| !line.contains(CACHED_SECRET)));
    }

    struct Reply {
        status: &'static str,
        content_type: &'static str,
        body: Vec<u8>,
    }

    struct Scripted {
        url: String,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Scripted {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl Scripted {
        async fn start(replies: Vec<(&'static str, Reply)>) -> Self {
            let replies = Arc::new(std::collections::HashMap::<_, _>::from_iter(replies));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let replies = Arc::clone(&replies);
                    tokio::spawn(async move {
                        let header = consume_request(&mut socket).await.unwrap_or_default();
                        let name = header
                            .lines()
                            .next()
                            .unwrap_or("")
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or("")
                            .split('?')
                            .next()
                            .unwrap_or("")
                            .rsplit('/')
                            .next()
                            .unwrap_or("");
                        let Some(reply) = replies.get(name) else {
                            let _ =
                                write_raw(&mut socket, "404 Not Found", "text/plain", b"missing")
                                    .await;
                            return;
                        };
                        let _ =
                            write_raw(&mut socket, reply.status, reply.content_type, &reply.body)
                                .await;
                    });
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                task,
            }
        }
    }

    async fn write_raw(
        socket: &mut tokio::net::TcpStream,
        status: &str,
        content_type: &str,
        body: &[u8],
    ) -> std::io::Result<()> {
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        socket.write_all(head.as_bytes()).await?;
        socket.write_all(body).await?;
        let _ = socket.shutdown().await;
        Ok(())
    }

    async fn taken(response: Response<Body>) -> (StatusCode, Option<String>, Vec<u8>) {
        let status = response.status();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        (status, content_type, bytes)
    }

    #[tokio::test]
    async fn non_json_upstream_errors_keep_status_and_json_bodies_pass_through() {
        let mut long = vec![b'a'; 1023];
        long.extend_from_slice(&[0xC3, 0xA9, b'Z']);
        assert_eq!(long.len(), 1026);
        let json_400 = br#"{"error":"Bad request","detail":1}"#.to_vec();
        let json_200 = br#"{"id":"bkt","ok":true}"#.to_vec();
        let upstream = Scripted::start(vec![
            (
                "Plain403",
                Reply {
                    status: "403 Forbidden",
                    content_type: "text/plain",
                    body: b"nope".to_vec(),
                },
            ),
            (
                "Empty403",
                Reply {
                    status: "403 Forbidden",
                    content_type: "text/plain",
                    body: Vec::new(),
                },
            ),
            (
                "Long403",
                Reply {
                    status: "403 Forbidden",
                    content_type: "text/plain",
                    body: long,
                },
            ),
            (
                "Json400",
                Reply {
                    status: "400 Bad Request",
                    content_type: "application/json",
                    body: json_400.clone(),
                },
            ),
            (
                "Json200",
                Reply {
                    status: "200 OK",
                    content_type: "application/json",
                    body: json_200.clone(),
                },
            ),
            (
                "Text200",
                Reply {
                    status: "200 OK",
                    content_type: "text/plain",
                    body: b"raw-ok".to_vec(),
                },
            ),
        ])
        .await;
        let app = app_at(&upstream.url).await;

        let (status, content_type, bytes) =
            taken(send(&app, "Plain403", &Method::GET, "", &[]).await.unwrap()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(content_type.as_deref(), Some("application/json"));
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({
                "code": "upstream_error",
                "message": "nope",
                "garageStatus": 403
            })
        );

        let (status, _, bytes) =
            taken(send(&app, "Empty403", &Method::GET, "", &[]).await.unwrap()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({
                "code": "upstream_error",
                "message": "",
                "garageStatus": 403
            })
        );

        let (status, _, bytes) =
            taken(send(&app, "Long403", &Method::GET, "", &[]).await.unwrap()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let message = format!("{}{}", "a".repeat(1023), "\u{FFFD}");
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({
                "code": "upstream_error",
                "message": message,
                "garageStatus": 403
            })
        );

        let (status, content_type, bytes) =
            taken(send(&app, "Json400", &Method::GET, "", &[]).await.unwrap()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(content_type.as_deref(), Some("application/json"));
        assert_eq!(bytes, json_400);

        let (status, content_type, bytes) =
            taken(send(&app, "Json200", &Method::GET, "", &[]).await.unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type.as_deref(), Some("application/json"));
        assert_eq!(bytes, json_200);

        let (status, content_type, bytes) =
            taken(send(&app, "Text200", &Method::GET, "", &[]).await.unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type.as_deref(), Some("text/plain"));
        assert_eq!(bytes, b"raw-ok");

        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(ADMIN_TOKEN));
        assert!(!sink.contains("nope"));
        assert!(!sink.contains("raw-ok"));
    }
}
