use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, RawQuery, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};
use crate::access::{self, Op};
use crate::db::{self, AuditEvent, User};
use crate::error::ApiError;
use crate::objects;
use crate::proxy::{self, confirmed};
use crate::session::{
    self, Current, apply_login_cookies, clear_cookies, client_ip, cookie, csrf_exempt, csrf_matches,
};
use crate::state::{self, App};
use super::Authed;
use super::PageQuery;
use super::is_json_ws;
use super::page_bounds;
use super::page_json;
use super::percent_encode;
use super::post_garage;
use super::record;
use super::require;

pub(crate) async fn list_buckets(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    require(&current.user, Op::ViewBuckets)?;
    let (offset, limit) = page_bounds(&query)?;
    let page = proxy::list_buckets(&app, offset, limit).await?;
    Ok(page_json(page))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct CreateBucketBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    global_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local_alias: Option<CreateLocalAlias>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateLocalAlias {
    access_key_id: String,
    alias: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    allow: Option<BucketPerm>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BucketPerm {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    read: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    write: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct AliasBody {
    bucket_id: Option<String>,
    global_alias: Option<String>,
    local_alias: Option<String>,
    access_key_id: Option<String>,
}

pub(crate) async fn create_bucket(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
    Json(body): Json<CreateBucketBody>,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeBuckets) {
        let target = body.global_alias.as_deref().unwrap_or("");
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "POST",
            "/api/buckets",
            target,
            403,
        )
        .await?;
        return Err(error);
    }
    let bytes = serde_json::to_vec(&body).map_err(|_| ApiError::internal())?;
    post_garage(&app, &current, &headers, "CreateBucket", None, &bytes).await
}

pub(crate) async fn get_bucket(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewBuckets)?;
    let query = format!("id={}", percent_encode(&id));
    proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/GetBucketInfo",
        Some(&query),
        &[],
        &headers,
    )
    .await
}

pub(crate) async fn get_bucket_cors(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let response = get_bucket(State(app.clone()), Authed(current), Path(id), headers).await?;
    if !response.status().is_success() {
        return Ok(response);
    }
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    let rules = cors_rules_from_bucket(&bytes)?;
    Ok(Json(json!({ "corsRules": rules })).into_response())
}

pub(crate) async fn get_bucket_lifecycle(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let response = get_bucket(State(app.clone()), Authed(current), Path(id), headers).await?;
    if !response.status().is_success() {
        return Ok(response);
    }
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    let rules = lifecycle_rules_from_bucket(&bytes)?;
    Ok(Json(json!({ "lifecycleRules": rules })).into_response())
}

pub(crate) async fn delete_bucket(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeBuckets) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "DELETE",
            "/api/buckets",
            &id,
            403,
        )
        .await?;
        return Err(error);
    }
    let query = format!("id={}", percent_encode(&id));
    post_garage(&app, &current, &headers, "DeleteBucket", Some(&query), &[]).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BucketCredentialBody {
    access_key_id: String,
}

pub(crate) async fn put_bucket_credential(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    Json(body): Json<BucketCredentialBody>,
) -> Result<Json<Value>, ApiError> {
    require(&current.user, Op::ChangeBucketKeys)?;
    db::set_bucket_key(&app.db, &id, &body.access_key_id)
        .await
        .map_err(|_| ApiError::internal())?;
    app.clear_credential_cache(&state::credentials::KeyMutation::AllowBucketKey {
        bucket_id: id,
    })
    .await;
    Ok(Json(json!({ "access_key_id": body.access_key_id })))
}

pub(crate) async fn put_bucket_quotas(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeBuckets) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "PUT",
            "/api/buckets/quotas",
            &id,
            403,
        )
        .await?;
        return Err(error);
    }
    let bytes = match quota_update(&body) {
        Ok(bytes) => bytes,
        Err(error) => {
            record(
                &app,
                &current.user.username,
                &current.ip,
                "error",
                "invalid_quota",
                "PUT",
                "/api/buckets/quotas",
                &id,
                400,
            )
            .await?;
            return Err(error);
        }
    };
    let query = format!("id={}", percent_encode(&id));
    post_garage(
        &app,
        &current,
        &headers,
        "UpdateBucket",
        Some(&query),
        &bytes,
    )
    .await
}

pub(crate) async fn put_bucket_cors(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeBuckets) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "PUT",
            "/api/buckets/cors",
            &id,
            403,
        )
        .await?;
        return Err(error);
    }
    let bytes = match cors_update(&body) {
        Ok(bytes) => bytes,
        Err(error) => {
            record(
                &app,
                &current.user.username,
                &current.ip,
                "error",
                "invalid_cors",
                "PUT",
                "/api/buckets/cors",
                &id,
                400,
            )
            .await?;
            return Err(error);
        }
    };
    let query = format!("id={}", percent_encode(&id));
    post_garage(
        &app,
        &current,
        &headers,
        "UpdateBucket",
        Some(&query),
        &bytes,
    )
    .await
}

pub(crate) async fn put_bucket_lifecycle(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeBuckets) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "PUT",
            "/api/buckets/lifecycle",
            &id,
            403,
        )
        .await?;
        return Err(error);
    }
    let bytes = match lifecycle_update(&body) {
        Ok(bytes) => bytes,
        Err(error) => {
            record(
                &app,
                &current.user.username,
                &current.ip,
                "error",
                "invalid_lifecycle",
                "PUT",
                "/api/buckets/lifecycle",
                &id,
                400,
            )
            .await?;
            return Err(error);
        }
    };
    let query = format!("id={}", percent_encode(&id));
    post_garage(
        &app,
        &current,
        &headers,
        "UpdateBucket",
        Some(&query),
        &bytes,
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorsUpdate {
    #[serde(rename = "corsRules")]
    cors_rules: Vec<Value>,
}

fn invalid_cors() -> ApiError {
    ApiError::bad_request("invalid_cors", "corsRules must be an array")
}

fn cors_update(body: &[u8]) -> Result<Vec<u8>, ApiError> {
    let update: CorsUpdate = serde_json::from_slice(body).map_err(|_| invalid_cors())?;
    serde_json::to_vec(&json!({ "corsRules": update.cors_rules })).map_err(|_| ApiError::internal())
}

// A missing or null corsRules is an empty rule list. This route always returns an array.
fn cors_rules_from_bucket(bytes: &[u8]) -> Result<Value, ApiError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        ApiError::unavailable(
            "invalid_bucket",
            "Bucket info did not include a CORS rule array",
        )
    })?;
    match value.get("corsRules") {
        None | Some(Value::Null) => Ok(Value::Array(Vec::new())),
        Some(Value::Array(rules)) => Ok(Value::Array(rules.clone())),
        Some(_) => Err(ApiError::unavailable(
            "invalid_bucket",
            "Bucket info did not include a CORS rule array",
        )),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LifecycleUpdate {
    #[serde(rename = "lifecycleRules")]
    lifecycle_rules: Vec<Value>,
}

fn invalid_lifecycle() -> ApiError {
    ApiError::bad_request("invalid_lifecycle", "lifecycleRules must be an array")
}

fn lifecycle_update(body: &[u8]) -> Result<Vec<u8>, ApiError> {
    let update: LifecycleUpdate = serde_json::from_slice(body).map_err(|_| invalid_lifecycle())?;
    serde_json::to_vec(&json!({ "lifecycleRules": update.lifecycle_rules }))
        .map_err(|_| ApiError::internal())
}

// A missing or null lifecycleRules is an empty rule list. This route always returns an array.
fn lifecycle_rules_from_bucket(bytes: &[u8]) -> Result<Value, ApiError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        ApiError::unavailable(
            "invalid_bucket",
            "Bucket info did not include a lifecycle rule array",
        )
    })?;
    match value.get("lifecycleRules") {
        None | Some(Value::Null) => Ok(Value::Array(Vec::new())),
        Some(Value::Array(rules)) => Ok(Value::Array(rules.clone())),
        Some(_) => Err(ApiError::unavailable(
            "invalid_bucket",
            "Bucket info did not include a lifecycle rule array",
        )),
    }
}

pub(crate) async fn list_multipart_uploads(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require(&current.user, Op::ReadObjects)?;
    let uploads = objects::list_multipart_uploads(&app, &id).await?;
    Ok(Json(json!({ "uploads": uploads })))
}

enum AbortTarget {
    All,
    One { key: String, upload_id: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AbortOne {
    key: String,
    #[serde(rename = "uploadId")]
    upload_id: String,
}

fn invalid_upload() -> ApiError {
    ApiError::bad_request("invalid_upload", "key and uploadId are required")
}

fn abort_target(body: &[u8]) -> Result<AbortTarget, ApiError> {
    if body.is_empty() {
        return Ok(AbortTarget::All);
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid_upload())?;
    match value {
        Value::Object(map) if map.is_empty() => Ok(AbortTarget::All),
        Value::Object(map) => {
            let one: AbortOne =
                serde_json::from_value(Value::Object(map)).map_err(|_| invalid_upload())?;
            Ok(AbortTarget::One {
                key: one.key,
                upload_id: one.upload_id,
            })
        }
        _ => Err(invalid_upload()),
    }
}

pub(crate) async fn abort_multipart_uploads(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    require(&current.user, Op::WriteObjects)?;
    let aborted = match abort_target(&body)? {
        AbortTarget::All => {
            let uploads = objects::list_multipart_uploads(&app, &id).await?;
            let mut aborted = 0u64;
            for upload in uploads {
                // One failed AbortMultipartUpload must not fail the rest, and it does not count.
                if objects::abort_incomplete_upload(&app, &id, &upload.key, &upload.upload_id)
                    .await
                    .is_ok()
                {
                    aborted += 1;
                }
            }
            aborted
        }
        AbortTarget::One { key, upload_id } => {
            objects::abort_incomplete_upload(&app, &id, &key, &upload_id).await?;
            1
        }
    };
    Ok(Json(json!({ "aborted": aborted })))
}

pub(crate) async fn cleanup_uploads(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    require(&current.user, Op::WriteObjects)?;
    let older_than_secs = cleanup_age(&body)?;
    let bytes = serde_json::to_vec(&json!({
        "bucketId": id,
        "olderThanSecs": older_than_secs,
    }))
    .map_err(|_| ApiError::internal())?;
    post_garage(
        &app,
        &current,
        &headers,
        "CleanupIncompleteUploads",
        None,
        &bytes,
    )
    .await
}

fn invalid_age() -> ApiError {
    ApiError::bad_request(
        "invalid_age",
        "olderThanSecs must be an integer that is at least 0",
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupAge {
    #[serde(rename = "olderThanSecs")]
    older_than_secs: i64,
}

fn cleanup_age(body: &[u8]) -> Result<i64, ApiError> {
    let parsed: CleanupAge = serde_json::from_slice(body).map_err(|_| invalid_age())?;
    if parsed.older_than_secs < 0 {
        return Err(invalid_age());
    }
    Ok(parsed.older_than_secs)
}

pub(crate) async fn grant_bucket_permissions(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    change_bucket_permissions(
        &app,
        &current,
        &headers,
        &id,
        &body,
        "POST",
        "AllowBucketKey",
    )
    .await
}

pub(crate) async fn revoke_bucket_permissions(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    change_bucket_permissions(
        &app,
        &current,
        &headers,
        &id,
        &body,
        "DELETE",
        "DenyBucketKey",
    )
    .await
}

async fn change_bucket_permissions(
    app: &App,
    current: &Current,
    headers: &HeaderMap,
    id: &str,
    body: &[u8],
    method: &'static str,
    endpoint: &'static str,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeBucketKeys) {
        record(
            app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            method,
            "/api/buckets/permissions",
            id,
            403,
        )
        .await?;
        return Err(error);
    }
    let bytes = match permission_bytes(id, body) {
        Ok(bytes) => bytes,
        Err(error) => {
            if error.status_code() == StatusCode::BAD_REQUEST {
                record(
                    app,
                    &current.user.username,
                    &current.ip,
                    "error",
                    error.code(),
                    method,
                    "/api/buckets/permissions",
                    id,
                    400,
                )
                .await?;
            }
            return Err(error);
        }
    };
    post_garage(app, current, headers, endpoint, None, &bytes).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PermissionChange {
    #[serde(default)]
    bucket_id: Option<String>,
    access_key_id: String,
    permissions: PermissionBits,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionBits {
    owner: bool,
    read: bool,
    write: bool,
}

fn invalid_permission() -> ApiError {
    ApiError::bad_request(
        "invalid_permission",
        "accessKeyId and boolean permissions are required",
    )
}

fn permission_bytes(path_id: &str, body: &[u8]) -> Result<Vec<u8>, ApiError> {
    let change: PermissionChange =
        serde_json::from_slice(body).map_err(|_| invalid_permission())?;
    if change.access_key_id.is_empty() {
        return Err(invalid_permission());
    }
    if change
        .bucket_id
        .as_deref()
        .is_some_and(|bucket_id| bucket_id != path_id)
    {
        return Err(ApiError::bad_request(
            "bucket_id_mismatch",
            "Bucket id does not match",
        ));
    }
    let bits = change.permissions;
    if !bits.owner && !bits.read && !bits.write {
        return Err(ApiError::bad_request(
            "invalid_permission",
            "Select at least one permission",
        ));
    }
    let bucket_id = serde_json::to_string(path_id).map_err(|_| ApiError::internal())?;
    let access_key_id =
        serde_json::to_string(&change.access_key_id).map_err(|_| ApiError::internal())?;
    let owner = json_bool(bits.owner);
    let read = json_bool(bits.read);
    let write = json_bool(bits.write);
    Ok(format!(
        r#"{{"bucketId":{bucket_id},"accessKeyId":{access_key_id},"permissions":{{"owner":{owner},"read":{read},"write":{write}}}}}"#
    )
    .into_bytes())
}

fn json_bool(value: bool) -> &'static str {
    if value { "true" } else { "false" }
}

pub(crate) async fn add_bucket_alias(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<AliasBody>,
) -> Result<Response, ApiError> {
    change_alias(
        &app,
        &current,
        &headers,
        &id,
        body,
        "POST",
        "AddBucketAlias",
    )
    .await
}

pub(crate) async fn remove_bucket_alias(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<AliasBody>,
) -> Result<Response, ApiError> {
    change_alias(
        &app,
        &current,
        &headers,
        &id,
        body,
        "DELETE",
        "RemoveBucketAlias",
    )
    .await
}

async fn change_alias(
    app: &App,
    current: &Current,
    headers: &HeaderMap,
    id: &str,
    body: AliasBody,
    method: &'static str,
    endpoint: &'static str,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeBuckets) {
        record(
            app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            method,
            "/api/buckets/aliases",
            id,
            403,
        )
        .await?;
        return Err(error);
    }
    let bytes = match alias_bytes(id, body) {
        Ok(bytes) => bytes,
        Err(error) => {
            record(
                app,
                &current.user.username,
                &current.ip,
                "error",
                error.code(),
                method,
                "/api/buckets/aliases",
                id,
                400,
            )
            .await?;
            return Err(error);
        }
    };
    post_garage(app, current, headers, endpoint, None, &bytes).await
}

fn alias_bytes(path_id: &str, body: AliasBody) -> Result<Vec<u8>, ApiError> {
    if body.bucket_id.as_deref().is_some_and(|id| id != path_id) {
        return Err(ApiError::bad_request(
            "bucket_id_mismatch",
            "Bucket id does not match",
        ));
    }
    let value = match (body.global_alias, body.local_alias, body.access_key_id) {
        (Some(global_alias), None, None) => json!({
            "bucketId": path_id,
            "globalAlias": global_alias,
        }),
        (None, Some(local_alias), Some(access_key_id)) => json!({
            "bucketId": path_id,
            "localAlias": local_alias,
            "accessKeyId": access_key_id,
        }),
        _ => {
            return Err(ApiError::bad_request(
                "invalid_alias",
                "Alias must be global or local",
            ));
        }
    };
    Ok(value.to_string().into_bytes())
}

struct QuotaWire<'a> {
    max_size: &'a str,
    max_objects: &'a str,
}

fn invalid_quota() -> ApiError {
    ApiError::bad_request(
        "invalid_quota",
        "maxSize and maxObjects must be non-negative integers or null",
    )
}

// Quota integers stay in the request's original digits. Parsing through f64 would turn 9007199254740993 into 9007199254740992.
fn quota_update(body: &[u8]) -> Result<Vec<u8>, ApiError> {
    let wire = parse_quota_body(body)?;
    let mut out = Vec::new();
    out.extend_from_slice(br#"{"quotas":{"maxSize":"#);
    out.extend_from_slice(wire.max_size.as_bytes());
    out.extend_from_slice(br#","maxObjects":"#);
    out.extend_from_slice(wire.max_objects.as_bytes());
    out.extend_from_slice(br#"}}"#);
    Ok(out)
}

fn parse_quota_body(body: &[u8]) -> Result<QuotaWire<'_>, ApiError> {
    let mut scan = Scan { input: body, at: 0 };
    if !scan.eat(b'{') {
        return Err(invalid_quota());
    }
    let mut max_size = None;
    let mut max_objects = None;
    scan.skip();
    if scan.peek() != Some(b'}') {
        loop {
            let key = scan.key()?;
            if !scan.eat(b':') {
                return Err(invalid_quota());
            }
            let literal = scan.literal()?;
            match key {
                "maxSize" if max_size.is_none() => max_size = Some(literal),
                "maxObjects" if max_objects.is_none() => max_objects = Some(literal),
                _ => return Err(invalid_quota()),
            }
            if !scan.eat(b',') {
                break;
            }
        }
    }
    if !scan.eat(b'}') {
        return Err(invalid_quota());
    }
    scan.skip();
    if scan.at != scan.input.len() {
        return Err(invalid_quota());
    }
    let (Some(max_size), Some(max_objects)) = (max_size, max_objects) else {
        return Err(invalid_quota());
    };
    Ok(QuotaWire {
        max_size,
        max_objects,
    })
}

struct Scan<'a> {
    input: &'a [u8],
    at: usize,
}

impl<'a> Scan<'a> {
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
        self.skip();
        if self.input.get(self.at) == Some(&byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn key(&mut self) -> Result<&'a str, ApiError> {
        self.skip();
        if self.input.get(self.at) != Some(&b'"') {
            return Err(invalid_quota());
        }
        self.at += 1;
        let start = self.at;
        while let Some(&byte) = self.input.get(self.at) {
            if byte == b'"' {
                let text = std::str::from_utf8(&self.input[start..self.at])
                    .map_err(|_| invalid_quota())?;
                self.at += 1;
                return Ok(text);
            }
            if byte == b'\\' || byte < 0x20 {
                return Err(invalid_quota());
            }
            self.at += 1;
        }
        Err(invalid_quota())
    }

    fn literal(&mut self) -> Result<&'a str, ApiError> {
        self.skip();
        let bytes = &self.input[self.at..];
        if bytes.starts_with(b"null") && bytes.get(4).is_none_or(|byte| is_literal_end(*byte)) {
            self.at += 4;
            return Ok("null");
        }
        if bytes
            .first()
            .is_some_and(|byte| *byte == b'-' || matches!(*byte, b'.' | b'+' | b'e' | b'E'))
        {
            return Err(invalid_quota());
        }
        if !bytes.first().is_some_and(u8::is_ascii_digit) {
            return Err(invalid_quota());
        }
        let mut end = 1;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        if bytes[0] == b'0' && end > 1 {
            return Err(invalid_quota());
        }
        if bytes
            .get(end)
            .is_some_and(|byte| matches!(*byte, b'.' | b'e' | b'E' | b'+' | b'-'))
        {
            return Err(invalid_quota());
        }
        if bytes.get(end).is_some_and(|byte| !is_literal_end(*byte)) {
            return Err(invalid_quota());
        }
        let digits = std::str::from_utf8(&bytes[..end]).map_err(|_| invalid_quota())?;
        self.at += end;
        Ok(digits)
    }
}

fn is_literal_end(byte: u8) -> bool {
    matches!(byte, b',' | b'}' | b' ' | b'\n' | b'\r' | b'\t')
}
