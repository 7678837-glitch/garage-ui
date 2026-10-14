use std::collections::VecDeque;
use std::io::Write;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use super::Authed;
use super::percent_encode;
use super::record;
use super::require;
use super::thumb;
use crate::access::{self, Op};
use crate::db;
use crate::error::ApiError;
use crate::objects;
use crate::preview::preview_policy;
use crate::proxy;
use crate::session::Current;
use crate::state::App;
use crate::util::{self, hex_encode, random_bytes};
use axum::Json;
use axum::Router;
use axum::body::{Body, Bytes, HttpBody};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};

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
    let (tx, rx) = archive_queue();
    let bucket = id.clone();
    let app = app.clone();
    // The handler returns this response before the task opens the next object.
    tokio::spawn(async move {
        let _ = write_archive(app, bucket, planned, tx).await;
    });
    let mut response = Response::new(Body::new(ZipChunks { rx }));
    let headers = response.headers_mut();
    headers.insert("content-type", HeaderValue::from_static("application/zip"));
    headers.insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    let disposition = util::content_disposition_attachment("archive.zip");
    let value = HeaderValue::from_str(&disposition).map_err(|_| ApiError::internal())?;
    headers.insert("content-disposition", value);
    Ok(response)
}

async fn write_archive(
    app: App,
    bucket: String,
    planned: Vec<crate::zip::PlannedFile>,
    tx: ArchiveTx,
) -> Result<(), ApiError> {
    let mut archive = crate::zip::ArchiveSink::new(ChunkWriter { tx: tx.clone() });
    let mut errors = Vec::new();
    let mut names = Vec::new();
    for entry in planned {
        match objects::open(&app, &bucket, &entry.key).await {
            Ok(opened) => {
                tx.ready(crate::zip::header_room(&entry.name))
                    .await
                    .map_err(|_| ApiError::internal())?;
                archive.begin_file(&entry.name)?;
                names.push(entry.name);
                let mut object_body = std::pin::pin!(opened.body);
                while let Some(next) =
                    std::future::poll_fn(|cx| HttpBody::poll_frame(object_body.as_mut(), cx)).await
                {
                    let frame = next.map_err(|_| ApiError::internal())?;
                    let Ok(chunk) = frame.into_data() else {
                        continue;
                    };
                    write_queued(&mut archive, &tx, &chunk).await?;
                }
            }
            Err(_) => errors.push(entry.key),
        }
    }
    if !errors.is_empty() {
        tx.ready(crate::zip::header_room("_errors.txt"))
            .await
            .map_err(|_| ApiError::internal())?;
        archive.begin_file("_errors.txt")?;
        names.push("_errors.txt".to_string());
        let note = errors.join("\n");
        write_queued(&mut archive, &tx, note.as_bytes()).await?;
        write_queued(&mut archive, &tx, b"\n").await?;
    }
    tx.ready(crate::zip::closing_room(&names))
        .await
        .map_err(|_| ApiError::internal())?;
    archive.finish()
}

async fn write_queued(
    archive: &mut crate::zip::ArchiveSink<ChunkWriter>,
    tx: &ArchiveTx,
    bytes: &[u8],
) -> Result<(), ApiError> {
    let mut rest = bytes;
    while !rest.is_empty() {
        let n = rest.len().min(crate::zip::ARCHIVE_WRITE_MAX);
        tx.ready(n).await.map_err(|_| ApiError::internal())?;
        archive.write_bytes(&rest[..n])?;
        rest = &rest[n..];
    }
    Ok(())
}

const ARCHIVE_QUEUE_CAP: usize = 64 * 1024 * 1024;

fn archive_queue() -> (ArchiveTx, ArchiveRx) {
    let shared = Arc::new(Mutex::new(ArchiveQueue {
        chunks: VecDeque::new(),
        queued: 0,
        accepted: 0,
        senders: 1,
        closed: false,
        recv_waker: None,
        send_waker: None,
    }));
    (
        ArchiveTx {
            shared: Arc::clone(&shared),
        },
        ArchiveRx { shared },
    )
}

struct ArchiveQueue {
    chunks: VecDeque<Bytes>,
    queued: usize,
    // Bytes reserved by the current write before they sit in `chunks`.
    accepted: usize,
    senders: usize,
    closed: bool,
    recv_waker: Option<Waker>,
    send_waker: Option<Waker>,
}

#[derive(Debug)]
enum ArchivePush {
    Full,
    Closed,
}

struct ArchiveTx {
    shared: Arc<Mutex<ArchiveQueue>>,
}

struct ArchiveRx {
    shared: Arc<Mutex<ArchiveQueue>>,
}

impl Clone for ArchiveTx {
    fn clone(&self) -> Self {
        self.lock().senders += 1;
        Self {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl Drop for ArchiveTx {
    fn drop(&mut self) {
        let mut queue = self.lock();
        queue.senders -= 1;
        if queue.senders == 0 {
            queue.closed = true;
            let waker = queue.recv_waker.take();
            drop(queue);
            if let Some(waker) = waker {
                waker.wake();
            }
        }
    }
}

impl Drop for ArchiveRx {
    fn drop(&mut self) {
        let mut queue = self.lock();
        queue.closed = true;
        let waker = queue.send_waker.take();
        drop(queue);
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl ArchiveTx {
    fn lock(&self) -> std::sync::MutexGuard<'_, ArchiveQueue> {
        self.shared.lock().expect("archive queue")
    }

    fn retained(queue: &ArchiveQueue) -> usize {
        queue.queued.saturating_add(queue.accepted)
    }

    #[cfg(test)]
    fn try_push(&self, bytes: Bytes) -> Result<(), ArchivePush> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.reserve(bytes.len())?;
        self.commit(bytes);
        Ok(())
    }

    fn reserve(&self, n: usize) -> Result<(), ArchivePush> {
        if n > crate::zip::ARCHIVE_WRITE_MAX {
            return Err(ArchivePush::Full);
        }
        let mut queue = self.lock();
        if queue.closed {
            return Err(ArchivePush::Closed);
        }
        if Self::retained(&queue).saturating_add(n) > ARCHIVE_QUEUE_CAP {
            return Err(ArchivePush::Full);
        }
        queue.accepted += n;
        Ok(())
    }

    fn commit(&self, bytes: Bytes) {
        let mut queue = self.lock();
        let n = bytes.len();
        queue.accepted = queue.accepted.saturating_sub(n);
        queue.queued += n;
        queue.chunks.push_back(bytes);
        let waker = queue.recv_waker.take();
        drop(queue);
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    async fn ready(&self, n: usize) -> Result<(), ArchivePush> {
        std::future::poll_fn(|cx| self.poll_ready(cx, n)).await
    }

    fn poll_ready(&self, cx: &mut Context<'_>, n: usize) -> Poll<Result<(), ArchivePush>> {
        if n > ARCHIVE_QUEUE_CAP {
            return Poll::Ready(Err(ArchivePush::Full));
        }
        let mut queue = self.lock();
        if queue.closed {
            return Poll::Ready(Err(ArchivePush::Closed));
        }
        if Self::retained(&queue).saturating_add(n) <= ARCHIVE_QUEUE_CAP {
            return Poll::Ready(Ok(()));
        }
        queue.send_waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl ArchiveRx {
    fn lock(&self) -> std::sync::MutexGuard<'_, ArchiveQueue> {
        self.shared.lock().expect("archive queue")
    }

    fn poll_recv(&mut self, cx: &mut Context<'_>) -> Poll<Option<Bytes>> {
        let mut queue = self.lock();
        if let Some(bytes) = queue.chunks.pop_front() {
            queue.queued = queue.queued.saturating_sub(bytes.len());
            let waker = queue.send_waker.take();
            drop(queue);
            if let Some(waker) = waker {
                waker.wake();
            }
            return Poll::Ready(Some(bytes));
        }
        if queue.closed || queue.senders == 0 {
            return Poll::Ready(None);
        }
        queue.recv_waker = Some(cx.waker().clone());
        Poll::Pending
    }

    #[cfg(test)]
    async fn recv(&mut self) -> Option<Bytes> {
        std::future::poll_fn(|cx| self.poll_recv(cx)).await
    }
}

struct ZipChunks {
    rx: ArchiveRx,
}

impl HttpBody for ZipChunks {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        match self.get_mut().rx.poll_recv(cx) {
            Poll::Ready(Some(bytes)) => Poll::Ready(Some(Ok(http_body::Frame::data(bytes)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

struct ChunkWriter {
    tx: ArchiveTx,
}

impl Write for ChunkWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let n = buf.len().min(crate::zip::ARCHIVE_WRITE_MAX);
        // Count the copy before it is queued. A full queue returns here and does not wait.
        self.tx.reserve(n).map_err(push_error)?;
        self.tx.commit(Bytes::copy_from_slice(&buf[..n]));
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn push_error(error: ArchivePush) -> std::io::Error {
    match error {
        ArchivePush::Full => {
            std::io::Error::new(std::io::ErrorKind::WouldBlock, "archive queue full")
        }
        ArchivePush::Closed => {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "archive client closed")
        }
    }
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
        .map(|key| key.as_str().map(str::to_string).ok_or_else(invalid_keys))
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
    // Seconds beyond 7 days are truncated before signing. The audit row stores the truncated value.
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
    // A root domain without {bucket} is not a website template and is not a public address.
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

// The arguments are the audit table columns. Like record, this does not add a struct, and reason stays 'static.
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
    // Permission and length failures return from put_bucket_object. The in-flight upload count starts here.
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
    thumbnail: Option<String>,
}

enum ObjectIntent {
    Meta,
    Thumbnail,
    Transfer(Transfer),
}

#[derive(Clone, Copy)]
enum Transfer {
    Preview,
    Download,
}

fn object_intent(query: &ObjectViewQuery) -> Result<ObjectIntent, ApiError> {
    match (
        query.preview.as_deref(),
        query.download.as_deref(),
        query.thumbnail.as_deref(),
    ) {
        (None, None, None) => Ok(ObjectIntent::Meta),
        (Some("1"), None, None) => Ok(ObjectIntent::Transfer(Transfer::Preview)),
        (None, Some("1"), None) => Ok(ObjectIntent::Transfer(Transfer::Download)),
        (None, None, Some("1")) => Ok(ObjectIntent::Thumbnail),
        _ => Err(ApiError::bad_request(
            "invalid_view",
            "Choose preview, download, or thumbnail",
        )),
    }
}

fn object_filename(key: &str) -> &str {
    key.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("object")
}

fn invalid_range() -> ApiError {
    ApiError::new(
        StatusCode::RANGE_NOT_SATISFIABLE,
        "range_not_satisfiable",
        "range is invalid",
    )
}

fn byte_range(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let mut values = headers.get_all("range").iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(invalid_range());
    }
    let text = value.to_str().map_err(|_| invalid_range())?;
    one_byte_range(text)
        .map(|range| Some(range.to_string()))
        .ok_or_else(invalid_range)
}

fn one_byte_range(value: &str) -> Option<&str> {
    let rest = value.strip_prefix("bytes=")?;
    let (start, end) = rest.split_once('-')?;
    if start.contains(',') || end.contains('-') || end.contains(',') {
        return None;
    }
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    let ok = if start.is_empty() {
        digits(end) && !end.is_empty()
    } else if end.is_empty() {
        digits(start)
    } else {
        digits(start) && digits(end)
    };
    ok.then_some(value)
}

fn stream_object(
    transfer: Transfer,
    key: &str,
    opened: objects::ObjectStream,
) -> Result<Response, ApiError> {
    let filename = object_filename(key);
    let policy = preview_policy(&opened.content_type, filename);
    let mut response = Response::new(Body::new(opened.body));
    *response.status_mut() = opened.status;
    let headers = response.headers_mut();
    if let Some(content_range) = opened.content_range.as_deref() {
        let value = HeaderValue::from_str(content_range).map_err(|_| ApiError::internal())?;
        headers.insert("content-range", value);
    }
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
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    match object_intent(&query)? {
        ObjectIntent::Thumbnail => {
            require(&current.user, Op::ReadObjects)?;
            thumb::deliver(&app, &id, &key).await
        }
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
            let range = byte_range(&headers)?;
            let opened = objects::open_ranged(&app, &id, &key, range).await?;
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

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route("/api/buckets/{id}/objects", get(list_bucket_objects))
        .route(
            "/api/buckets/{id}/objects:delete",
            post(delete_bucket_objects),
        )
        .route(
            "/api/buckets/{id}/objects/{*key}",
            get(object_metadata).delete(delete_bucket_object),
        )
        .route("/api/buckets/{id}/search", get(search_bucket_objects))
        .route("/api/buckets/{id}/inspect/{*key}", get(inspect_object))
        .route("/api/objects/preview", get(preview_object))
        .route("/api/objects/download", get(download_object))
        .route(
            "/api/buckets/{id}/archive-token",
            post(create_archive_token),
        )
        .route("/api/buckets/{id}/archive", get(download_archive))
        .route("/api/share", post(share))
}
#[cfg(test)]
mod tests {
    use axum::body::Bytes;

    use super::archive_queue;

    #[tokio::test]
    async fn archive_queue_holds_at_most_64mb() {
        let (tx, mut rx) = archive_queue();
        let chunk = Bytes::from(vec![0_u8; 256 * 1024]);
        let cap = 67_108_864_usize;
        let mut accepted = 0_usize;
        while accepted < cap {
            tx.try_push(chunk.clone()).expect("chunk within 64 MiB");
            accepted += chunk.len();
        }
        assert!(accepted <= cap, "accepted {accepted} bytes");
        assert!(
            tx.try_push(chunk.clone()).is_err(),
            "extra chunk was accepted"
        );
        let taken = rx.recv().await.expect("queued chunk");
        assert_eq!(taken.len(), chunk.len());
        assert!(tx.try_push(chunk).is_ok());
    }
}
