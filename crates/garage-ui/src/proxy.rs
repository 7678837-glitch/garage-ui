use axum::body::Body;
use axum::http::{HeaderMap, Method, Response, StatusCode};
use serde_json::Value;

use crate::access::{self, Op};
use crate::config;
use crate::db::{self, AuditEvent, User};
use crate::error::ApiError;
use crate::state::{App, GarageLink};

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
            return Err(ApiError::conflict(
                "garage_too_old",
                "Garage v2.3.0 or newer is required",
            ));
        }
    }
    let filtered = forwarded_query(name, query);
    let response = send(app, name, method, &filtered, body).await?;
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
    GarageLink::from_reported(
        value
            .get("garageVersion")
            .and_then(|version| version.as_str()),
    )
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
    let upstream = exchange(app, name, method, query, body).await?;
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

async fn exchange(
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
    let upstream = request.send().await.map_err(|_| garage_down())?;
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .cloned();
    let bytes = upstream.bytes().await.map_err(|_| garage_down())?.to_vec();
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

// api 接入前库目标看不到分页入口，整段会变成死代码。
#[allow(dead_code)]
mod lists {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

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

    #[derive(Clone, Copy, PartialEq, Eq, Default)]
    enum Probe {
        #[default]
        Unknown,
        Present,
        Absent,
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
        let key = format!("{base}\n{}", catalog.info);
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
        let items = fetch_details(app, catalog.detail, ids).await?;
        let more = items.len() == limit;
        Ok(Page { items, more })
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
        let results = limit::fan_out(limit::DEFAULT_FANOUT_IN_FLIGHT, ids, move |id| {
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
            .map_err(|_| garage_down())?;
        let status =
            StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let bytes = upstream.bytes().await.map_err(|_| garage_down())?;
        if !status.is_success() {
            return Err(garage_down());
        }
        serde_json::from_slice(&bytes).map_err(|_| garage_unreadable())
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
}

#[allow(dead_code, unused_imports)]
pub use lists::{Page, list_buckets, list_keys};

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
            "/v2/ListBuckets" => ("200 OK", id_page(inner.opts.buckets)),
            "/v2/ListKeys" => ("200 OK", id_page(inner.opts.keys)),
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

    fn id_page(count: usize) -> String {
        let items: Vec<_> = (0..count)
            .map(|index| json!({"id": row_id(index), "via": "ids"}))
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

    #[tokio::test]
    async fn short_page_has_no_more_and_full_page_does() {
        let mock = Mock::start(MockOpts {
            buckets: 0,
            keys: 2,
            bucket_info: 404,
            key_info: 200,
            hold_details: false,
            info_failures: 0,
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
    async fn probe_once_per_admin_url_and_connection_failure_is_not_absent() {
        let first = Mock::start(MockOpts {
            buckets: 3,
            keys: 4,
            bucket_info: 404,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
        })
        .await;
        let second = Mock::start(MockOpts {
            buckets: 1,
            keys: 0,
            bucket_info: 404,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
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
        assert!(keys_again.more);
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
    async fn health_and_metrics_stay_unversioned_and_keep_the_query() {
        let mock = Mock::start(MockOpts {
            buckets: 0,
            keys: 0,
            bucket_info: 404,
            key_info: 404,
            hold_details: false,
            info_failures: 0,
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
}
