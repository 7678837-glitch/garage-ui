use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, RawQuery, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use crate::access::{self, Op};
use crate::error::ApiError;
use crate::proxy::{self, confirmed};
use crate::session::{
    self, Current, apply_login_cookies, clear_cookies, client_ip, cookie, csrf_exempt, csrf_matches,
};
use crate::state::{self, App};
use crate::util::{self, hex_encode, random_bytes};
use super::Authed;
use super::is_json_ws;
use super::percent_encode;
use super::post_garage;
use super::record;
use super::require;
use super::status;
use axum::Router;
use axum::routing::{any, get, post, put};

pub(crate) async fn cluster_health(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    read_cluster(&app, &current, &headers, "v2/GetClusterHealth").await
}

pub(crate) async fn cluster_status(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    read_cluster(&app, &current, &headers, "v2/GetClusterStatus").await
}

pub(crate) async fn cluster_statistics(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewStats)?;
    proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/GetClusterStatistics",
        None,
        &[],
        &headers,
    )
    .await
}

pub(crate) async fn node_statistics(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewStats)?;
    let query = format!("node={}", percent_encode(&id));
    proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/GetNodeStatistics",
        Some(&query),
        &[],
        &headers,
    )
    .await
}

pub(crate) async fn node_block_errors(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewOps)?;
    let query = format!("node={}", percent_encode(&id));
    let listed = proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/ListBlockErrors",
        Some(&query),
        &[],
        &headers,
    )
    .await?;
    worker_node(&app, listed, &id).await
}

const METRICS_NOTICE: &str = "No metrics token or admin token can be used.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricsSummary {
    s3_requests: u64,
    s3_errors: u64,
    block_read_bytes: u64,
    block_write_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<&'static str>,
}

pub(crate) async fn cluster_metrics(
    State(app): State<App>,
    Authed(current): Authed,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewMetrics)?;
    Ok(Json(load_metrics_summary(&app).await?).into_response())
}

async fn load_metrics_summary(app: &App) -> Result<MetricsSummary, ApiError> {
    let tokens = metrics_bearers(app);
    if tokens.is_empty() {
        return Ok(notice_summary());
    }
    let Some(base) = app.settings.garage_admin_url.as_deref() else {
        return Err(ApiError::unavailable(
            "garage_unavailable",
            "Garage admin API is not configured",
        ));
    };
    let url = crate::config::join(base, "metrics");
    for token in &tokens {
        if let Some(metrics) = fetch_garage_metrics(&app.http, &url, token).await? {
            return Ok(summary_from(metrics, None));
        }
    }
    Ok(notice_summary())
}

fn metrics_bearers(app: &App) -> Vec<String> {
    let mut tokens = Vec::new();
    if let Some(token) = app.settings.metrics_token.clone() {
        tokens.push(token);
    }
    if let Some(token) = app.settings.garage_admin_token.clone()
        && !tokens.iter().any(|have| util::ct_eq(have, &token))
    {
        tokens.push(token);
    }
    tokens
}

fn notice_summary() -> MetricsSummary {
    summary_from(
        crate::prometheus::parse_garage_metrics(""),
        Some(METRICS_NOTICE),
    )
}

fn summary_from(
    metrics: crate::prometheus::GarageMetrics,
    notice: Option<&'static str>,
) -> MetricsSummary {
    MetricsSummary {
        s3_requests: metrics.s3_requests,
        s3_errors: metrics.s3_errors,
        block_read_bytes: metrics.block_read_bytes,
        block_write_bytes: metrics.block_write_bytes,
        notice,
    }
}

fn garage_metrics_down() -> ApiError {
    ApiError::unavailable(
        "garage_unavailable",
        "Garage admin API is not reachable",
    )
}

async fn fetch_garage_metrics(
    http: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<Option<crate::prometheus::GarageMetrics>, ApiError> {
    let response = match http.get(url).bearer_auth(token).send().await {
        Ok(response) => response,
        Err(_) => return Err(garage_metrics_down()),
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        let _ = response.bytes().await;
        return Ok(None);
    }
    if !status.is_success() {
        let _ = response.bytes().await;
        return Err(garage_metrics_down());
    }
    let bytes = response.bytes().await.map_err(|_| garage_metrics_down())?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(Some(crate::prometheus::parse_garage_metrics(&text)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerVariableAssignment {
    variable: String,
    value: String,
}

fn invalid_variable() -> ApiError {
    ApiError::bad_request("invalid_variable", "variable and value are required")
}

fn worker_assignment(body: &[u8]) -> Result<WorkerVariableAssignment, ApiError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid_variable())?;
    // serde_json accepts a JSON array as a struct, field by field. The request must be an object.
    if !value.is_object() {
        return Err(invalid_variable());
    }
    serde_json::from_value(value).map_err(|_| invalid_variable())
}

#[derive(Deserialize)]
pub(crate) struct WorkerVariableQuery {
    variable: Option<String>,
}

pub(crate) async fn put_worker_variable(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    require(&current.user, Op::RunOps)?;
    let assigned = worker_assignment(&body)?;
    let payload = serde_json::to_vec(&json!({
        "variable": assigned.variable,
        "value": assigned.value,
    }))
    .map_err(|_| ApiError::internal())?;
    let query = format!("node={}", percent_encode(&id));
    let posted = post_garage(
        &app,
        &current,
        &headers,
        "SetWorkerVariable",
        Some(&query),
        &payload,
    )
    .await?;
    worker_node(&app, posted, &id).await
}

pub(crate) async fn get_worker_variable(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    Query(query): Query<WorkerVariableQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewOps)?;
    let payload = serde_json::to_vec(&json!({ "variable": query.variable }))
        .map_err(|_| ApiError::internal())?;
    let query = format!("node={}", percent_encode(&id));
    let posted = post_garage(
        &app,
        &current,
        &headers,
        "GetWorkerVariable",
        Some(&query),
        &payload,
    )
    .await?;
    worker_node(&app, posted, &id).await
}

fn invalid_repair() -> ApiError {
    ApiError::bad_request("invalid_repair", "repairType is required")
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RepairBody {
    #[serde(rename = "repairType")]
    repair_type: RepairType,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum RepairType {
    Kind(RepairKind),
    Scrub(ScrubRepair),
}

#[derive(Deserialize, Serialize)]
enum RepairKind {
    #[serde(rename = "tables")]
    Tables,
    #[serde(rename = "blocks")]
    Blocks,
    #[serde(rename = "versions")]
    Versions,
    #[serde(rename = "multipartUploads")]
    MultipartUploads,
    #[serde(rename = "blockRefs")]
    BlockRefs,
    #[serde(rename = "blockRc")]
    BlockRc,
    #[serde(rename = "rebalance")]
    Rebalance,
    #[serde(rename = "aliases")]
    Aliases,
    #[serde(rename = "clearResyncQueue")]
    ClearResyncQueue,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ScrubRepair {
    scrub: ScrubCommand,
}

#[derive(Deserialize, Serialize)]
enum ScrubCommand {
    #[serde(rename = "start")]
    Start,
    #[serde(rename = "pause")]
    Pause,
    #[serde(rename = "resume")]
    Resume,
    #[serde(rename = "cancel")]
    Cancel,
}

fn repair_body(body: &[u8]) -> Result<RepairBody, ApiError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid_repair())?;
    // serde_json accepts a JSON array as a struct, field by field. The request must be an object.
    if !value.is_object() {
        return Err(invalid_repair());
    }
    serde_json::from_value(value).map_err(|_| invalid_repair())
}

pub(crate) async fn post_repair(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    require(&current.user, Op::RunOps)?;
    let accepted = repair_body(&body)?;
    let payload = serde_json::to_vec(&accepted).map_err(|_| ApiError::internal())?;
    let query = format!("node={}", percent_encode(&id));
    let posted = post_garage(
        &app,
        &current,
        &headers,
        "LaunchRepairOperation",
        Some(&query),
        &payload,
    )
    .await?;
    worker_node(&app, posted, &id).await
}

fn invalid_blocks() -> ApiError {
    ApiError::bad_request("invalid_blocks", "block hashes are required")
}

fn block_hashes(body: &[u8]) -> Result<Vec<String>, ApiError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid_blocks())?;
    if !value.is_array() {
        return Err(invalid_blocks());
    }
    let hashes: Vec<String> = serde_json::from_value(value).map_err(|_| invalid_blocks())?;
    if hashes.is_empty() || hashes.iter().any(String::is_empty) {
        return Err(invalid_blocks());
    }
    Ok(hashes)
}

pub(crate) async fn post_purge_blocks(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    require(&current.user, Op::RunOps)?;
    let hashes = block_hashes(&body)?;
    let payload = serde_json::to_vec(&hashes).map_err(|_| ApiError::internal())?;
    let query = format!("node={}", percent_encode(&id));
    let posted = post_garage(
        &app,
        &current,
        &headers,
        "PurgeBlocks",
        Some(&query),
        &payload,
    )
    .await?;
    worker_node(&app, posted, &id).await
}

enum RetryBlocks {
    Hashes(Vec<String>),
    All,
}

fn retry_blocks(body: &[u8]) -> Result<RetryBlocks, ApiError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid_blocks())?;
    let Some(object) = value.as_object() else {
        return Err(invalid_blocks());
    };
    if object.len() != 1 {
        return Err(invalid_blocks());
    }
    if let Some(hashes) = object.get("blockHashes") {
        let Some(list) = hashes.as_array() else {
            return Err(invalid_blocks());
        };
        if list.is_empty() {
            return Err(invalid_blocks());
        }
        let mut block_hashes = Vec::with_capacity(list.len());
        for hash in list {
            let Some(text) = hash.as_str() else {
                return Err(invalid_blocks());
            };
            if text.is_empty() {
                return Err(invalid_blocks());
            }
            block_hashes.push(text.to_string());
        }
        return Ok(RetryBlocks::Hashes(block_hashes));
    }
    if matches!(object.get("all"), Some(Value::Bool(true))) {
        return Ok(RetryBlocks::All);
    }
    Err(invalid_blocks())
}

pub(crate) async fn post_retry_blocks(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    require(&current.user, Op::RunOps)?;
    let accepted = retry_blocks(&body)?;
    let forwarded = match &accepted {
        RetryBlocks::Hashes(hashes) => json!({ "blockHashes": hashes }),
        RetryBlocks::All => json!({ "all": true }),
    };
    let payload = serde_json::to_vec(&forwarded).map_err(|_| ApiError::internal())?;
    let query = format!("node={}", percent_encode(&id));
    let posted = post_garage(
        &app,
        &current,
        &headers,
        "RetryBlockResync",
        Some(&query),
        &payload,
    )
    .await?;
    worker_node(&app, posted, &id).await
}

async fn worker_node(app: &App, response: Response, id: &str) -> Result<Response, ApiError> {
    if !response.status().is_success() {
        return Ok(response);
    }
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::internal())?;
    if let Some(node) = value
        .get("success")
        .and_then(Value::as_object)
        .and_then(|nodes| nodes.get(id))
    {
        return Ok(Json(node.clone()).into_response());
    }
    if let Some(message) = value
        .get("error")
        .and_then(Value::as_object)
        .and_then(|nodes| nodes.get(id))
        .and_then(Value::as_str)
    {
        return Ok((
            StatusCode::BAD_GATEWAY,
            Json(json!({ "code": "garage_error", "message": message })),
        )
            .into_response());
    }
    Err(ApiError::internal())
}

pub(crate) async fn connect_cluster(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeLayout) {
        let target = String::from_utf8_lossy(&body);
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "POST",
            "/api/cluster/connect",
            &target,
            403,
        )
        .await?;
        return Err(error);
    }
    post_garage(&app, &current, &headers, "ConnectClusterNodes", None, &body).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StageCapacityBody {
    id: String,
    capacity: String,
}

struct StatusRole<'a> {
    id: String,
    capacity: Option<&'a str>,
    zone: Option<&'a [u8]>,
    tags: Option<&'a [u8]>,
}

pub(crate) async fn layout_history(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    read_cluster(&app, &current, &headers, "v2/GetClusterLayoutHistory").await
}

pub(crate) async fn preview_layout(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ChangeLayout)?;
    post_garage(
        &app,
        &current,
        &headers,
        "PreviewClusterLayoutChanges",
        None,
        b"",
    )
    .await
}

pub(crate) async fn stage_layout(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeLayout) {
        let target = String::from_utf8_lossy(&body);
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "POST",
            "/api/layout/stage",
            &target,
            403,
        )
        .await?;
        return Err(error);
    }
    let staged = staged_capacity(&body)?;
    let status = read_cluster(&app, &current, &headers, "v2/GetClusterStatus").await?;
    if !status.status().is_success() {
        return Ok(status);
    }
    let bytes = axum::body::to_bytes(status.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    let roles = status_roles(&bytes)?;
    let Some(role) = roles.iter().find(|role| role.id == staged.id) else {
        return Err(ApiError::not_found());
    };
    let Some(current_capacity) = role.capacity else {
        return Err(ApiError::bad_request(
            "capacity_unavailable",
            "Node capacity is not a whole number of bytes",
        ));
    };
    if current_capacity == staged.capacity {
        return Ok(Json(json!({ "updated": 0 })).into_response());
    }
    let (Some(zone), Some(tags)) = (role.zone, role.tags) else {
        return Err(ApiError::bad_request(
            "capacity_unavailable",
            "Node role is missing zone or tags",
        ));
    };
    let update = layout_update_body(&staged.id, zone, tags, &staged.capacity);
    let posted = post_garage(
        &app,
        &current,
        &headers,
        "UpdateClusterLayout",
        None,
        &update,
    )
    .await?;
    if !posted.status().is_success() {
        return Ok(posted);
    }
    Ok(Json(json!({ "updated": 1 })).into_response())
}

fn staged_capacity(body: &[u8]) -> Result<StageCapacityBody, ApiError> {
    let staged: StageCapacityBody = serde_json::from_slice(body).map_err(|_| {
        ApiError::bad_request("invalid_capacity", "Capacity must be a decimal string")
    })?;
    if staged.id.is_empty()
        || staged
            .id
            .bytes()
            .any(|byte| byte < 0x20 || byte == b'"' || byte == b'\\')
    {
        return Err(ApiError::bad_request("invalid_node", "Node id is invalid"));
    }
    if util::bucket::Capacity::from_byte_string(&staged.capacity).is_err() {
        return Err(ApiError::bad_request(
            "invalid_capacity",
            "Capacity must be a whole number of bytes",
        ));
    }
    Ok(staged)
}

fn unreadable_status() -> ApiError {
    ApiError::unavailable(
        "garage_unavailable",
        "Garage cluster status is unreadable",
    )
}

// serde_json rewrites a number past 2^53-1, so copy the digit characters.
fn status_roles(input: &[u8]) -> Result<Vec<StatusRole<'_>>, ApiError> {
    let mut cursor = JsonCursor::new(input);
    if !cursor.eat(b'{') {
        return Err(unreadable_status());
    }
    let mut roles = None;
    if cursor.peek() != Some(b'}') {
        loop {
            let key = cursor.string().map_err(|_| unreadable_status())?;
            if !cursor.eat(b':') {
                return Err(unreadable_status());
            }
            if key == "nodes" {
                roles = Some(cursor.node_array()?);
            } else {
                cursor.skip_value().map_err(|_| unreadable_status())?;
            }
            if !cursor.eat(b',') {
                break;
            }
        }
    }
    if !cursor.eat(b'}') {
        return Err(unreadable_status());
    }
    cursor.skip();
    if cursor.at != cursor.input.len() {
        return Err(unreadable_status());
    }
    roles.ok_or_else(unreadable_status)
}

fn layout_update_body(id: &str, zone: &[u8], tags: &[u8], capacity: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(br#"{"roles":[{"id":""#);
    out.extend_from_slice(id.as_bytes());
    out.extend_from_slice(br#"","zone":"#);
    out.extend_from_slice(zone);
    out.extend_from_slice(br#","capacity":"#);
    out.extend_from_slice(capacity.as_bytes());
    out.extend_from_slice(br#","tags":"#);
    out.extend_from_slice(tags);
    out.extend_from_slice(br#"}]}"#);
    out
}

struct JsonCursor<'a> {
    input: &'a [u8],
    at: usize,
}

impl<'a> JsonCursor<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, at: 0 }
    }

    fn skip(&mut self) {
        while self.input.get(self.at).is_some_and(is_json_ws) {
            self.at += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip();
        self.input.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn string(&mut self) -> Result<String, ()> {
        let raw = self.raw_string()?;
        let inner = &raw[1..raw.len() - 1];
        if inner.contains(&b'\\') {
            return Err(());
        }
        std::str::from_utf8(inner).map(str::to_string).map_err(|_| ())
    }

    fn raw_string(&mut self) -> Result<&'a [u8], ()> {
        self.skip();
        if self.input.get(self.at) != Some(&b'"') {
            return Err(());
        }
        let start = self.at;
        self.at += 1;
        while let Some(&byte) = self.input.get(self.at) {
            if byte == b'\\' {
                self.at += 2;
                if self.at > self.input.len() {
                    return Err(());
                }
                continue;
            }
            if byte == b'"' {
                self.at += 1;
                return Ok(&self.input[start..self.at]);
            }
            if byte < 0x20 {
                return Err(());
            }
            self.at += 1;
        }
        Err(())
    }

    fn raw_value(&mut self) -> Result<&'a [u8], ()> {
        self.skip();
        let start = self.at;
        self.skip_value()?;
        Ok(&self.input[start..self.at])
    }

    fn capacity_token(&mut self) -> Result<Option<&'a str>, ()> {
        if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.skip_value()?;
            return Ok(None);
        }
        let bytes = &self.input[self.at..];
        let mut end = 0;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        if bytes
            .get(end)
            .is_some_and(|byte| matches!(*byte, b'.' | b'e' | b'E'))
        {
            self.skip_number()?;
            return Ok(None);
        }
        if bytes.get(end).is_some_and(|byte| !is_value_end(*byte)) {
            return Err(());
        }
        let digits = std::str::from_utf8(&bytes[..end]).map_err(|_| ())?;
        self.at += end;
        Ok(Some(digits))
    }

    fn node_array(&mut self) -> Result<Vec<StatusRole<'a>>, ApiError> {
        if !self.eat(b'[') {
            return Err(unreadable_status());
        }
        let mut roles = Vec::new();
        if self.peek() != Some(b']') {
            loop {
                roles.push(self.node_object()?);
                if !self.eat(b',') {
                    break;
                }
            }
        }
        if !self.eat(b']') {
            return Err(unreadable_status());
        }
        Ok(roles)
    }

    fn node_object(&mut self) -> Result<StatusRole<'a>, ApiError> {
        if !self.eat(b'{') {
            return Err(unreadable_status());
        }
        let mut id = None;
        let mut capacity = None;
        let mut zone = None;
        let mut tags = None;
        if self.peek() != Some(b'}') {
            loop {
                let key = self.string().map_err(|_| unreadable_status())?;
                if !self.eat(b':') {
                    return Err(unreadable_status());
                }
                match key.as_str() {
                    "id" => id = Some(self.string().map_err(|_| unreadable_status())?),
                    "role" if self.peek() == Some(b'{') => {
                        let role = self.role_object()?;
                        capacity = role.capacity;
                        zone = role.zone;
                        tags = role.tags;
                    }
                    _ => self.skip_value().map_err(|_| unreadable_status())?,
                }
                if !self.eat(b',') {
                    break;
                }
            }
        }
        if !self.eat(b'}') {
            return Err(unreadable_status());
        }
        let Some(id) = id else {
            return Err(unreadable_status());
        };
        Ok(StatusRole {
            id,
            capacity,
            zone,
            tags,
        })
    }

    fn role_object(&mut self) -> Result<StatusRole<'a>, ApiError> {
        if !self.eat(b'{') {
            return Err(unreadable_status());
        }
        let mut capacity = None;
        let mut zone = None;
        let mut tags = None;
        if self.peek() != Some(b'}') {
            loop {
                let key = self.string().map_err(|_| unreadable_status())?;
                if !self.eat(b':') {
                    return Err(unreadable_status());
                }
                match key.as_str() {
                    "capacity" => capacity = self.capacity_token().map_err(|_| unreadable_status())?,
                    "zone" => zone = Some(self.raw_value().map_err(|_| unreadable_status())?),
                    "tags" => tags = Some(self.raw_value().map_err(|_| unreadable_status())?),
                    _ => self.skip_value().map_err(|_| unreadable_status())?,
                }
                if !self.eat(b',') {
                    break;
                }
            }
        }
        if !self.eat(b'}') {
            return Err(unreadable_status());
        }
        Ok(StatusRole {
            id: String::new(),
            capacity,
            zone,
            tags,
        })
    }

    fn skip_value(&mut self) -> Result<(), ()> {
        match self.peek() {
            Some(b'"') => {
                self.raw_string()?;
                Ok(())
            }
            Some(b'{') => self.skip_container(b'{', b'}'),
            Some(b'[') => self.skip_container(b'[', b']'),
            Some(b't') => self.eat_lit(b"true"),
            Some(b'f') => self.eat_lit(b"false"),
            Some(b'n') => self.eat_lit(b"null"),
            Some(b'-') | Some(b'0'..=b'9') => self.skip_number(),
            _ => Err(()),
        }
    }

    fn skip_container(&mut self, open: u8, close: u8) -> Result<(), ()> {
        if !self.eat(open) {
            return Err(());
        }
        if self.peek() == Some(close) {
            self.at += 1;
            return Ok(());
        }
        loop {
            if open == b'{' {
                self.string()?;
                if !self.eat(b':') {
                    return Err(());
                }
            }
            self.skip_value()?;
            if !self.eat(b',') {
                break;
            }
        }
        if self.eat(close) { Ok(()) } else { Err(()) }
    }

    fn eat_lit(&mut self, literal: &[u8]) -> Result<(), ()> {
        self.skip();
        if self.input[self.at..].starts_with(literal) {
            self.at += literal.len();
            Ok(())
        } else {
            Err(())
        }
    }

    fn skip_number(&mut self) -> Result<(), ()> {
        self.skip();
        if self.input.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        if !self.input.get(self.at).is_some_and(u8::is_ascii_digit) {
            return Err(());
        }
        while self.input.get(self.at).is_some_and(u8::is_ascii_digit) {
            self.at += 1;
        }
        if self.input.get(self.at) == Some(&b'.') {
            self.at += 1;
            if !self.input.get(self.at).is_some_and(u8::is_ascii_digit) {
                return Err(());
            }
            while self.input.get(self.at).is_some_and(u8::is_ascii_digit) {
                self.at += 1;
            }
        }
        if self
            .input
            .get(self.at)
            .is_some_and(|byte| *byte == b'e' || *byte == b'E')
        {
            self.at += 1;
            if self
                .input
                .get(self.at)
                .is_some_and(|byte| *byte == b'+' || *byte == b'-')
            {
                self.at += 1;
            }
            if !self.input.get(self.at).is_some_and(u8::is_ascii_digit) {
                return Err(());
            }
            while self.input.get(self.at).is_some_and(u8::is_ascii_digit) {
                self.at += 1;
            }
        }
        Ok(())
    }
}

fn is_value_end(byte: u8) -> bool {
    matches!(byte, b',' | b'}' | b']' | b' ' | b'\n' | b'\r' | b'\t')
}

async fn read_cluster(
    app: &App,
    current: &Current,
    headers: &HeaderMap,
    path: &'static str,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewCluster)?;
    proxy::dispatch(
        app,
        &current.user,
        &current.ip,
        &Method::GET,
        path,
        None,
        &[],
        headers,
    )
    .await
}

pub(crate) async fn garage(
    State(app): State<App>,
    Authed(current): Authed,
    method: Method,
    Path(path): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &method,
        &path,
        query.as_deref(),
        &body,
        &headers,
    )
    .await
}

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route("/api/cluster/health", get(cluster_health))
        .route("/api/cluster/status", get(cluster_status))
        .route("/api/cluster/statistics", get(cluster_statistics))
        .route("/api/metrics", get(cluster_metrics))
        .route("/api/nodes/{id}/statistics", get(node_statistics))
        .route("/api/nodes/{id}/block-errors", get(node_block_errors))
        .route(
            "/api/nodes/{id}/worker-variables",
            get(get_worker_variable).put(put_worker_variable),
        )
        .route("/api/nodes/{id}/blocks/purge", post(post_purge_blocks))
        .route("/api/nodes/{id}/blocks/retry", post(post_retry_blocks))
        .route("/api/nodes/{id}/repair", post(post_repair))
        .route("/api/cluster/connect", post(connect_cluster))
        .route("/api/layout/history", get(layout_history))
        .route("/api/layout/preview", post(preview_layout))
        .route("/api/layout/stage", post(stage_layout))
        .route("/api/garage/{*path}", any(garage))
}
