use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, RawQuery, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, patch, post, put};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};
use crate::access::{self, Op};
use crate::db::{self, AuditEvent, User};
use crate::error::ApiError;
use crate::objects;
use crate::preview::preview_policy;
use crate::proxy::{self, confirmed};
use crate::session::{
    self, Current, apply_login_cookies, clear_cookies, client_ip, cookie, csrf_exempt, csrf_matches,
};
use crate::state::{self, App};
use crate::util::{self, hex_encode, random_bytes};
use super::Authed;
use super::percent_encode;
use super::record;
use super::require;
use super::status;
use super::thumb;

#[derive(Deserialize)]
pub(crate) struct NameQuery {
    name: String,
}

#[derive(Deserialize)]
pub(crate) struct ShareBody {
    ttl_seconds: u64,
    bucket: String,
    key: String,
}

pub(crate) async fn preview_object(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<NameQuery>,
) -> Result<Response, ApiError> {
    object_body(&app, &current, &query.name, ObjectBody::Preview).await
}

pub(crate) async fn download_object(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<NameQuery>,
) -> Result<Response, ApiError> {
    object_body(&app, &current, &query.name, ObjectBody::Download).await
}

pub(crate) async fn thumbnail_object(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<NameQuery>,
) -> Result<Response, ApiError> {
    object_body(&app, &current, &query.name, ObjectBody::Preview).await
}

enum ObjectBody {
    Preview,
    Download,
}

async fn object_body(
    app: &App,
    current: &Current,
    name: &str,
    view: ObjectBody,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ReadObjects)?;
    let fixtures = app.fixtures.lock().expect("fixtures");
    let Some(fixture) = fixtures.get(name).cloned() else {
        return Err(ApiError::not_found());
    };
    drop(fixtures);
    let policy = preview_policy(&fixture.content_type, &fixture.filename);
    let filename = fixture.filename.clone();
    let mut response = Response::new(Body::from(fixture.body));
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&policy.content_type) {
        headers.insert("content-type", value);
    }
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static(policy.content_security_policy),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("SAMEORIGIN"));
    headers.insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    match view {
        ObjectBody::Download => {
            let disposition = util::content_disposition_attachment(&filename);
            let value = HeaderValue::from_str(&disposition).map_err(|_| ApiError::internal())?;
            headers.insert("content-disposition", value);
        }
        ObjectBody::Preview => {
            if let Some(disposition) = policy.content_disposition
                && let Ok(value) = HeaderValue::from_str(&disposition)
            {
                headers.insert("content-disposition", value);
            }
        }
    }
    Ok(response)
}

#[derive(Deserialize)]
pub(crate) struct ArchiveTokenQuery {
    token: String,
}

pub(crate) async fn create_archive_token(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ReadObjects)?;
    let keys = archive_keys(&body)?;
    let token = hex_encode(&random_bytes(32).map_err(|_| ApiError::internal())?);
    let keys_json = serde_json::to_string(&keys).map_err(|_| ApiError::internal())?;
    db::insert_zip(&app.db, &token, current.user.id, &id, &keys_json)
        .await
        .map_err(|_| ApiError::internal())?;
    let mut response = Json(json!({ "token": token })).into_response();
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

pub(crate) async fn download_archive(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    Query(query): Query<ArchiveTokenQuery>,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ReadObjects)?;
    let Some(row) = db::load_zip(&app.db, &query.token)
        .await
        .map_err(|_| ApiError::internal())?
    else {
        return Err(ApiError::not_found());
    };
    if row.user_id != current.user.id {
        return Err(ApiError::forbidden("forbidden", "Not allowed"));
    }
    if row.bucket_id != id || row.used != 0 {
        return Err(ApiError::not_found());
    }
    let age = crate::util::now_secs().saturating_sub(row.created_at);
    if !crate::zip::token_is_fresh(age) {
        return Err(ApiError::not_found());
    }
    let keys: Vec<String> =
        serde_json::from_str(&row.keys_json).map_err(|_| ApiError::internal())?;
    let claimed = db::claim_zip(&app.db, &query.token, current.user.id)
        .await
        .map_err(|_| ApiError::internal())?;
    if !claimed {
        return Err(ApiError::not_found());
    }
    let planned = crate::zip::archive_names(&keys);
    let mut files = Vec::new();
    let mut errors = Vec::new();
    for entry in planned {
        match objects::read_all(&app, &id, &entry.key).await {
            Ok(bytes) => files.push((entry.name, bytes)),
            Err(_) => errors.push(entry.key),
        }
    }
    let bytes = crate::zip::pack_zip(&files, &errors)?;
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        "content-type",
        HeaderValue::from_static("application/zip"),
    );
    headers.insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    let disposition = util::content_disposition_attachment("archive.zip");
    let value = HeaderValue::from_str(&disposition).map_err(|_| ApiError::internal())?;
    headers.insert("content-disposition", value);
    Ok(response)
}

fn archive_keys(body: &[u8]) -> Result<Vec<String>, ApiError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid_keys())?;
    let Some(keys) = value.get("keys").and_then(Value::as_array) else {
        return Err(invalid_keys());
    };
    if keys.is_empty() {
        return Err(ApiError::bad_request(
            "keys_required",
            "At least one key is required",
        ));
    }
    keys.iter()
        .map(|key| {
            key.as_str()
                .map(str::to_string)
                .ok_or_else(invalid_keys)
        })
        .collect()
}

#[derive(Serialize)]
struct ShareLink {
    url: String,
    expires_in: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    website_url: Option<String>,
}

pub(crate) async fn share(
    State(app): State<App>,
    Authed(current): Authed,
    Json(body): Json<ShareBody>,
) -> Result<Response, ApiError> {
    if let Err(wait) = app.limits.share(&current.user.username) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "rate_limited",
            "rate_limited",
            "POST",
            "/api/share",
            "",
            429,
        )
        .await?;
        return Err(ApiError::rate_limited(wait.as_secs()));
    }
    if !access::permits(current.user.actor(), Op::Share) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "POST",
            "/api/share",
            "",
            403,
        )
        .await?;
        return Err(ApiError::forbidden("forbidden", "Not allowed"));
    }
    if !app.settings.share_enabled() {
        return Err(ApiError::not_implemented(
            "share_unavailable",
            "Public S3 address is not configured",
        ));
    }
    // 超过 7 天的秒数在签名前截断，审计记截断后的值。
    let ttl = access::cap_share_ttl(body.ttl_seconds);
    let url = objects::presign_get(&app, &body.bucket, &body.key, ttl).await?;
    let website_url = share_website(&app, &current, &body.bucket).await;
    let target = format!("{}\n{}\n{ttl}", body.bucket, body.key);
    record(
        &app,
        &current.user.username,
        &current.ip,
        "success",
        "ok",
        "POST",
        "/api/share",
        &target,
        200,
    )
    .await?;
    Ok(Json(ShareLink {
        url,
        expires_in: ttl,
        website_url,
    })
    .into_response())
}

async fn share_website(app: &App, current: &Current, bucket_id: &str) -> Option<String> {
    let template = app.settings.website_root_domain.as_str();
    // 没有 {bucket} 的根域名不是网站模板，不把它当成公开地址。
    if !template.contains("{bucket}") {
        return None;
    }
    let query = format!("id={}", percent_encode(bucket_id));
    let response = proxy::dispatch(
        app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/GetBucketInfo",
        Some(&query),
        &[],
        &HeaderMap::new(),
    )
    .await
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .ok()?;
    let value = serde_json::from_slice::<Value>(&bytes).ok()?;
    if !website_enabled(&value) {
        return None;
    }
    Some(template.replace("{bucket}", bucket_id))
}

fn website_enabled(value: &Value) -> bool {
    match &value["websiteAccess"] {
        Value::Bool(enabled) => *enabled,
        Value::Object(fields) => fields.get("enabled").and_then(Value::as_bool) == Some(true),
        _ => false,
    }
}

fn upload_content_type(headers: &HeaderMap) -> Option<String> {
    headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn upload_length(headers: &HeaderMap, limit: u64) -> Result<u64, ApiError> {
    let Some(length) = headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return Err(ApiError::bad_request(
            "length_required",
            "Content-Length is required",
        ));
    };
    if length > limit {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Upload is too large",
        ));
    }
    Ok(length)
}

pub(crate) async fn upload_object(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::WriteObjects)?;
    upload_length(&headers, app.settings.max_upload_bytes)?;
    Err(ApiError::not_implemented(
        "not_implemented",
        "Object upload is not available",
    ))
}

// 参数就是审计表的列。和 record 一样不另做结构，reason 保持 'static。
#[allow(clippy::too_many_arguments)]
async fn audit_object(
    app: &App,
    current: &Current,
    result: &'static str,
    reason: &'static str,
    method: &'static str,
    path: &str,
    target: &str,
    status: StatusCode,
) -> Result<(), ApiError> {
    record(
        app,
        &current.user.username,
        &current.ip,
        result,
        reason,
        method,
        path,
        target,
        i64::from(status.as_u16()),
    )
    .await
}

async fn reject_object<T>(
    app: &App,
    current: &Current,
    result: &'static str,
    method: &'static str,
    path: &str,
    target: &str,
    error: ApiError,
) -> Result<T, ApiError> {
    let reason = error.code();
    let status = error.status_code();
    audit_object(app, current, result, reason, method, path, target, status).await?;
    Err(error)
}

pub(crate) async fn put_bucket_object(
    State(app): State<App>,
    Authed(current): Authed,
    Path((id, key)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<(StatusCode, Json<objects::PutResult>), ApiError> {
    let path = format!("/api/buckets/{id}/objects/{key}");
    let target = format!("{id}/{key}");
    if let Err(error) = require(&current.user, Op::WriteObjects) {
        return reject_object(&app, &current, "denied", "PUT", &path, &target, error).await;
    }
    let size = match upload_length(&headers, app.settings.max_upload_bytes) {
        Ok(size) => size,
        Err(error) => {
            return reject_object(&app, &current, "error", "PUT", &path, &target, error).await;
        }
    };
    let content_type = upload_content_type(&headers);
    match put_object(
        &app,
        &id,
        &key,
        size,
        content_type,
        body,
        objects::PartPlan {
            threshold: 64 * 1024 * 1024,
            part_bytes: 16 * 1024 * 1024,
        },
    )
    .await
    {
        Ok(stored) => {
            audit_object(
                &app, &current, "success", "ok", "PUT", &path, &target, stored.0,
            )
            .await?;
            Ok(stored)
        }
        Err(error) => reject_object(&app, &current, "error", "PUT", &path, &target, error).await,
    }
}

pub(crate) async fn put_object(
    app: &App,
    id: &str,
    key: &str,
    size: u64,
    content_type: Option<String>,
    body: Body,
    plan: objects::PartPlan,
) -> Result<(StatusCode, Json<objects::PutResult>), ApiError> {
    // 权限和长度失败停在 put_bucket_object，这里才计入在途上传。
    let _in_flight = app.begin_upload();
    let stored = objects::put(app, id, key, size, content_type, body, plan).await?;
    Ok((StatusCode::CREATED, Json(stored)))
}

#[derive(Deserialize)]
pub(crate) struct ObjectListQuery {
    prefix: Option<String>,
    limit: Option<i64>,
    next: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct ObjectSearchQuery {
    q: Option<String>,
    prefix: Option<String>,
}

pub(crate) async fn list_bucket_objects(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    Query(query): Query<ObjectListQuery>,
) -> Result<Json<objects::ListPage>, ApiError> {
    require(&current.user, Op::ViewObjects)?;
    let page = objects::list(
        &app,
        &id,
        query.prefix.as_deref().unwrap_or(""),
        query.limit,
        query.next.as_deref().unwrap_or(""),
    )
    .await?;
    Ok(Json(page))
}

pub(crate) async fn search_bucket_objects(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    Query(query): Query<ObjectSearchQuery>,
) -> Result<Json<objects::SearchPage>, ApiError> {
    require(&current.user, Op::ViewObjects)?;
    let page = objects::search(
        &app,
        &id,
        query.q.as_deref().unwrap_or(""),
        query.prefix.as_deref().unwrap_or(""),
    )
    .await?;
    Ok(Json(page))
}

pub(crate) async fn inspect_object(
    State(app): State<App>,
    Authed(current): Authed,
    Path((id, key)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::InspectObject)?;
    let query = format!(
        "bucketId={}&key={}",
        percent_encode(&id),
        percent_encode(&key)
    );
    proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/InspectObject",
        Some(&query),
        &[],
        &headers,
    )
    .await
}

#[derive(Deserialize)]
pub(crate) struct ObjectViewQuery {
    preview: Option<String>,
    download: Option<String>,
}

enum ObjectIntent {
    Meta,
    Transfer(Transfer),
}

#[derive(Clone, Copy)]
enum Transfer {
    Preview,
    Download,
}

fn object_intent(query: &ObjectViewQuery) -> Result<ObjectIntent, ApiError> {
    match (query.preview.as_deref(), query.download.as_deref()) {
        (None, None) => Ok(ObjectIntent::Meta),
        (Some("1"), None) => Ok(ObjectIntent::Transfer(Transfer::Preview)),
        (None, Some("1")) => Ok(ObjectIntent::Transfer(Transfer::Download)),
        _ => Err(ApiError::bad_request(
            "invalid_view",
            "Choose preview or download",
        )),
    }
}

fn object_filename(key: &str) -> &str {
    key.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("object")
}

fn stream_object(
    transfer: Transfer,
    key: &str,
    opened: objects::ObjectStream,
) -> Result<Response, ApiError> {
    let filename = object_filename(key);
    let policy = preview_policy(&opened.content_type, filename);
    let mut response = Response::new(Body::new(opened.body));
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&policy.content_type) {
        headers.insert("content-type", value);
    }
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static(policy.content_security_policy),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("SAMEORIGIN"));
    headers.insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    let disposition = match transfer {
        Transfer::Download => Some(util::content_disposition_attachment(filename)),
        Transfer::Preview => policy.content_disposition,
    };
    if let Some(disposition) = disposition {
        let value = HeaderValue::from_str(&disposition).map_err(|_| ApiError::internal())?;
        headers.insert("content-disposition", value);
    }
    Ok(response)
}

pub(crate) async fn object_metadata(
    State(app): State<App>,
    Authed(current): Authed,
    Path((id, key)): Path<(String, String)>,
    Query(query): Query<ObjectViewQuery>,
) -> Result<Response, ApiError> {
    // matchit 不允许 `{*key}` 后再接 `/thumbnail`，会和本路由冲突。
    // 末段是 thumbnail 时 key 取前面的路径，axum 已按路径段解码。
    if let Some(object_key) = key.strip_suffix("/thumbnail")
        && !object_key.is_empty()
    {
        require(&current.user, Op::ReadObjects)?;
        return thumb::deliver(&app, &id, object_key).await;
    }
    match object_intent(&query)? {
        ObjectIntent::Meta => {
            require(&current.user, Op::ViewObjects)?;
            let meta = objects::metadata(&app, &id, &key).await?;
            let mut response = Json(meta).into_response();
            response.headers_mut().insert(
                "cache-control",
                HeaderValue::from_static("private, no-store"),
            );
            Ok(response)
        }
        ObjectIntent::Transfer(transfer) => {
            require(&current.user, Op::ReadObjects)?;
            let opened = objects::open(&app, &id, &key).await?;
            stream_object(transfer, &key, opened)
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct DeleteObjectQuery {
    recursive: Option<bool>,
}

pub(crate) async fn delete_bucket_object(
    State(app): State<App>,
    Authed(current): Authed,
    Path((id, key)): Path<(String, String)>,
    Query(query): Query<DeleteObjectQuery>,
) -> Result<Response, ApiError> {
    let path = format!("/api/buckets/{id}/objects/{key}");
    let target = format!("{id}/{key}");
    if let Err(error) = require(&current.user, Op::WriteObjects) {
        return reject_object(&app, &current, "denied", "DELETE", &path, &target, error).await;
    }
    if query.recursive == Some(true) {
        let outcome = match objects::delete_prefix(&app, &id, &key).await {
            Ok(outcome) => outcome,
            Err(error) => {
                return reject_object(&app, &current, "error", "DELETE", &path, &target, error)
                    .await;
            }
        };
        audit_object(
            &app,
            &current,
            "success",
            "ok",
            "DELETE",
            &path,
            &target,
            StatusCode::OK,
        )
        .await?;
        return Ok(Json(outcome).into_response());
    }
    if let Err(error) = objects::delete(&app, &id, &key).await {
        return reject_object(&app, &current, "error", "DELETE", &path, &target, error).await;
    }
    audit_object(
        &app,
        &current,
        "success",
        "ok",
        "DELETE",
        &path,
        &target,
        StatusCode::NO_CONTENT,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub(crate) async fn delete_bucket_objects(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<objects::DeleteMany>, ApiError> {
    let path = format!("/api/buckets/{id}/objects:delete");
    let target = id.as_str();
    if let Err(error) = require(&current.user, Op::WriteObjects) {
        return reject_object(&app, &current, "denied", "POST", &path, target, error).await;
    }
    let keys = match delete_keys(&body) {
        Ok(keys) => keys,
        Err(error) => {
            return reject_object(&app, &current, "error", "POST", &path, target, error).await;
        }
    };
    match objects::delete_many(&app, &id, keys).await {
        Ok(result) => {
            audit_object(
                &app,
                &current,
                "success",
                "ok",
                "POST",
                &path,
                target,
                StatusCode::OK,
            )
            .await?;
            Ok(Json(result))
        }
        Err(error) => reject_object(&app, &current, "error", "POST", &path, target, error).await,
    }
}

fn invalid_keys() -> ApiError {
    ApiError::bad_request("invalid_keys", "keys must be an array of strings")
}

fn delete_keys(body: &[u8]) -> Result<Vec<String>, ApiError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid_keys())?;
    let Some(keys) = value.get("keys").and_then(Value::as_array) else {
        return Err(invalid_keys());
    };
    if keys.is_empty() {
        return Err(ApiError::bad_request(
            "keys_required",
            "At least one key is required",
        ));
    }
    if keys.len() > 1000 {
        return Err(ApiError::bad_request(
            "too_many_keys",
            "At most 1000 keys can be deleted at once",
        ));
    }
    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        let Some(key) = key.as_str() else {
            return Err(invalid_keys());
        };
        out.push(key.to_string());
    }
    Ok(out)
}
