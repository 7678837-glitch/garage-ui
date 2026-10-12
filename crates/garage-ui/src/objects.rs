use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use aws_sdk_s3::Client;
use aws_sdk_s3::config::retry::RetryConfig;
use aws_sdk_s3::config::{
    Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::primitives::{ByteStream, DateTime, DateTimeFormat, SdkBody};
use axum::body::HttpBody;
use axum::http::{HeaderValue, StatusCode};
use serde::Serialize;
use tokio::sync::Semaphore;

use crate::db;
use crate::error::ApiError;
use crate::proxy;
use crate::state::App;
use crate::state::credentials::{self, BucketCredential, CredentialSources, Operation};

const SEARCH_MATCHES: usize = 200;
const SEARCH_PAGES: usize = 20;
const SEARCH_PAGE_KEYS: i32 = 1000;
const DELETE_PAGE_KEYS: i32 = 1000;
const PARTS_IN_FLIGHT: usize = 2;

#[derive(Serialize)]
pub struct ListPage {
    pub prefix: String,
    pub entries: Vec<ListEntry>,
    pub next: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ListEntry {
    Prefix {
        prefix: String,
    },
    Object {
        key: String,
        size: i64,
        etag: String,
        #[serde(rename = "lastModified")]
        last_modified: String,
    },
}

#[derive(Clone, Serialize)]
pub struct ObjectMatch {
    pub key: String,
    pub size: i64,
    pub etag: String,
    #[serde(rename = "lastModified")]
    pub last_modified: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitReason {
    ResultLimit,
    PageLimit,
}

#[derive(Serialize)]
pub struct SearchPage {
    pub matches: Vec<ObjectMatch>,
    pub truncated: bool,
    pub reason: Option<LimitReason>,
}

#[derive(Serialize)]
pub struct ObjectMeta {
    pub key: String,
    pub size: i64,
    pub etag: String,
    #[serde(rename = "lastModified")]
    pub last_modified: String,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
}

#[derive(Serialize)]
pub struct PutResult {
    pub key: String,
    pub etag: String,
    pub size: u64,
}

pub struct PartPlan {
    pub threshold: u64,
    pub part_bytes: u64,
}

#[derive(Serialize)]
pub struct DeleteMany {
    pub deleted: Vec<String>,
    pub failed: Vec<DeleteFailure>,
}

#[derive(Serialize)]
pub struct DeleteFailure {
    pub key: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct PrefixDelete {
    pub deleted: u64,
    pub errors: Vec<DeleteFailure>,
}

enum S3Failure {
    Forbidden(String),
    NotFound,
    Upstream { status: u16, message: String },
    Down,
    Local,
}

struct Page {
    objects: Vec<ObjectMatch>,
    prefixes: Vec<String>,
    next: Option<String>,
}

pub async fn list(
    app: &App,
    bucket_id: &str,
    prefix: &str,
    limit: Option<i64>,
    next: &str,
) -> Result<ListPage, ApiError> {
    let bucket = bucket_id.to_string();
    let prefix = prefix.to_string();
    let token = next.to_string();
    let limit = page_size(limit);
    let page = drive(app, bucket.clone(), {
        let prefix = prefix.clone();
        move |client| {
            let bucket = bucket.clone();
            let prefix = prefix.clone();
            let token = token.clone();
            async move {
                list_v2(
                    &client,
                    &bucket,
                    &prefix,
                    limit,
                    nonempty(&token),
                    Some("/"),
                )
                .await
            }
        }
    })
    .await?;
    Ok(ListPage {
        prefix,
        entries: merge(page.prefixes, page.objects),
        next: page.next,
    })
}

pub async fn search(
    app: &App,
    bucket_id: &str,
    query: &str,
    prefix: &str,
) -> Result<SearchPage, ApiError> {
    if query.chars().count() < 2 {
        return Err(ApiError::bad_request(
            "query_too_short",
            "Search needs at least 2 characters",
        ));
    }
    let bucket = bucket_id.to_string();
    let query = query.to_string();
    let prefix = prefix.to_string();
    drive(app, bucket.clone(), move |client| {
        let bucket = bucket.clone();
        let query = query.clone();
        let prefix = prefix.clone();
        async move { search_flat(&client, &bucket, &query, &prefix).await }
    })
    .await
}

pub async fn metadata(app: &App, bucket_id: &str, key: &str) -> Result<ObjectMeta, ApiError> {
    let bucket = bucket_id.to_string();
    let key = key.to_string();
    drive(app, bucket.clone(), move |client| {
        let bucket = bucket.clone();
        let key = key.clone();
        async move { head(&client, &bucket, &key).await }
    })
    .await
}

pub struct ObjectStream {
    pub content_type: String,
    pub body: SdkBody,
}

pub async fn presign_get(
    app: &App,
    bucket_id: &str,
    key: &str,
    ttl_secs: u64,
) -> Result<String, ApiError> {
    // 发出去的链接必须签在公共地址上。内网端点不能出现在这个 URL 里。
    let endpoint = app
        .settings
        .public_s3_url
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::not_implemented(
                "share_unavailable",
                "Public S3 address is not configured",
            )
        })?;
    let (_, region) = proxy::s3_origin(app).await;
    let bucket = bucket_id.to_string();
    let object_key = key.to_string();
    let sources = sources(app, bucket_id).await;
    let tls_insecure = app.settings.tls_insecure;
    let tls_ca_pem = app.settings.tls_ca_pem.clone();
    let signed_bucket = bucket.clone();
    let attempted = app
        .read_credential(&bucket, sources, move |credential| {
            let client = s3_client(
                &region,
                &endpoint,
                &credential,
                tls_insecure,
                tls_ca_pem.as_deref(),
            );
            let bucket = signed_bucket.clone();
            let object_key = object_key.clone();
            async move {
                match sign_get(&client, &bucket, &object_key, ttl_secs).await {
                    Ok(url) => Operation::Done(Ok(url)),
                    Err(failure) => Operation::Done(Err(failure)),
                }
            }
        })
        .await;
    match attempted {
        Ok(Ok(url)) => Ok(url),
        Ok(Err(_)) => Err(ApiError::internal()),
        Err(credentials::ReadFailure::NoUsableKey(missing)) => Err(ApiError::new(
            StatusCode::from_u16(missing.status()).expect("412"),
            missing.code(),
            missing.message(),
        )),
        Err(credentials::ReadFailure::Forbidden) => Err(ApiError::internal()),
    }
}

async fn sign_get(
    client: &Client,
    bucket: &str,
    key: &str,
    ttl_secs: u64,
) -> Result<String, S3Failure> {
    let config = aws_sdk_s3::presigning::PresigningConfig::expires_in(
        std::time::Duration::from_secs(ttl_secs),
    )
    .map_err(|_| S3Failure::Local)?;
    let signed = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .presigned(config)
        .await
        .map_err(|_| S3Failure::Local)?;
    Ok(signed.uri().to_string())
}

pub async fn read_all(app: &App, bucket_id: &str, key: &str) -> Result<Vec<u8>, ApiError> {
    let opened = open(app, bucket_id, key).await?;
    let mut body = std::pin::pin!(opened.body);
    let mut data = Vec::new();
    while let Some(next) =
        std::future::poll_fn(|cx| HttpBody::poll_frame(body.as_mut(), cx)).await
    {
        let frame = next.map_err(|_| ApiError::internal())?;
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

pub async fn open(app: &App, bucket_id: &str, key: &str) -> Result<ObjectStream, ApiError> {
    let bucket = bucket_id.to_string();
    let key = key.to_string();
    drive(app, bucket.clone(), move |client| {
        let bucket = bucket.clone();
        let key = key.clone();
        async move { fetch_object(&client, &bucket, &key).await }
    })
    .await
}

pub async fn put(
    app: &App,
    bucket_id: &str,
    key: &str,
    size: u64,
    content_type: Option<String>,
    body: axum::body::Body,
    plan: PartPlan,
) -> Result<PutResult, ApiError> {
    if size <= plan.threshold {
        return put_whole(app, bucket_id, key, size, content_type, body).await;
    }
    put_multipart(
        app,
        bucket_id,
        key,
        size,
        content_type,
        body,
        plan.part_bytes,
    )
    .await
}

async fn put_whole(
    app: &App,
    bucket_id: &str,
    key: &str,
    size: u64,
    content_type: Option<String>,
    body: axum::body::Body,
) -> Result<PutResult, ApiError> {
    let bucket = bucket_id.to_string();
    let key = key.to_string();
    let length = i64::try_from(size).unwrap_or(i64::MAX);
    // drive 在 403 时会再请求一次。请求体只能读一遍，按块落盘后两次都从文件建 ByteStream。
    let replay = ReplayBody::new(app.settings.data_dir.clone(), size, body);
    let etag = drive(app, bucket.clone(), {
        let bucket = bucket.clone();
        let key = key.clone();
        let replay = Arc::clone(&replay);
        move |client| {
            let bucket = bucket.clone();
            let key = key.clone();
            let replay = Arc::clone(&replay);
            let content_type = content_type.clone();
            async move {
                let stream = replay.byte_stream().await?;
                put_with(&client, &bucket, &key, length, content_type, stream).await
            }
        }
    })
    .await?;
    Ok(PutResult { key, etag, size })
}

async fn put_multipart(
    app: &App,
    bucket_id: &str,
    key: &str,
    size: u64,
    content_type: Option<String>,
    body: axum::body::Body,
    part_size: u64,
) -> Result<PutResult, ApiError> {
    let bucket = bucket_id.to_string();
    let key = key.to_string();
    // Create 返回 403 时 drive 会重试，这时请求体还不能被读走。
    let source = Arc::new(Mutex::new(Some(body)));
    let upload_buffer = Arc::clone(&app.upload_buffer);
    let etag = drive(app, bucket.clone(), {
        let bucket = bucket.clone();
        let key = key.clone();
        let source = Arc::clone(&source);
        let upload_buffer = Arc::clone(&upload_buffer);
        move |client| {
            let bucket = bucket.clone();
            let key = key.clone();
            let source = Arc::clone(&source);
            let upload_buffer = Arc::clone(&upload_buffer);
            let content_type = content_type.clone();
            async move {
                send_parts(
                    &client,
                    &bucket,
                    &key,
                    size,
                    part_size,
                    content_type,
                    &source,
                    upload_buffer,
                )
                .await
            }
        }
    })
    .await?;
    Ok(PutResult { key, etag, size })
}

pub async fn delete(app: &App, bucket_id: &str, key: &str) -> Result<(), ApiError> {
    let bucket = bucket_id.to_string();
    let key = key.to_string();
    drive(app, bucket.clone(), move |client| {
        let bucket = bucket.clone();
        let key = key.clone();
        async move {
            // 已不存在的 key 也算删完。drive 会把 404 转成接口 404。
            match remove_object(&client, &bucket, &key).await {
                Err(S3Failure::NotFound) => Ok(()),
                other => other,
            }
        }
    })
    .await
}

pub async fn delete_many(
    app: &App,
    bucket_id: &str,
    keys: Vec<String>,
) -> Result<DeleteMany, ApiError> {
    let bucket = bucket_id.to_string();
    drive(app, bucket.clone(), move |client| {
        let bucket = bucket.clone();
        let keys = keys.clone();
        async move { remove_objects(&client, &bucket, &keys).await }
    })
    .await
}

pub async fn delete_prefix(
    app: &App,
    bucket_id: &str,
    prefix: &str,
) -> Result<PrefixDelete, ApiError> {
    let mut deleted = 0u64;
    let mut errors = Vec::new();
    let mut token = String::new();
    loop {
        let bucket = bucket_id.to_string();
        let prefix = prefix.to_string();
        let listed = token.clone();
        let page = drive(app, bucket.clone(), move |client| {
            let bucket = bucket.clone();
            let prefix = prefix.clone();
            let listed = listed.clone();
            async move {
                list_v2(
                    &client,
                    &bucket,
                    &prefix,
                    DELETE_PAGE_KEYS,
                    nonempty(&listed),
                    None,
                )
                .await
            }
        })
        .await?;
        let keys: Vec<String> = page.objects.into_iter().map(|object| object.key).collect();
        if !keys.is_empty() {
            let batch = delete_many(app, bucket_id, keys).await?;
            deleted += batch.deleted.len() as u64;
            errors.extend(batch.failed);
        }
        // 下一页只跟 IsTruncated 给出的续页令牌走。满 1000 条但未截断时不再列一次。
        let Some(next) = page.next else {
            break;
        };
        token = next;
    }
    Ok(PrefixDelete { deleted, errors })
}

fn page_size(limit: Option<i64>) -> i32 {
    match limit {
        Some(value) if (1..=1000).contains(&value) => i32::try_from(value).unwrap_or(1000),
        Some(value) if value > 1000 => 1000,
        _ => 100,
    }
}

fn nonempty(token: &str) -> Option<&str> {
    if token.is_empty() { None } else { Some(token) }
}

fn merge(prefixes: Vec<String>, objects: Vec<ObjectMatch>) -> Vec<ListEntry> {
    let mut prefixes = prefixes.into_iter().peekable();
    let mut objects = objects.into_iter().peekable();
    let mut entries = Vec::new();
    loop {
        let take_prefix = match (prefixes.peek(), objects.peek()) {
            (Some(prefix), Some(object)) => prefix.as_str() <= object.key.as_str(),
            (Some(_), None) => true,
            _ => false,
        };
        if take_prefix {
            let Some(prefix) = prefixes.next() else {
                break;
            };
            entries.push(ListEntry::Prefix { prefix });
            continue;
        }
        let Some(object) = objects.next() else {
            break;
        };
        entries.push(ListEntry::Object {
            key: object.key,
            size: object.size,
            etag: object.etag,
            last_modified: object.last_modified,
        });
    }
    entries
}

async fn search_flat(
    client: &Client,
    bucket: &str,
    query: &str,
    prefix: &str,
) -> Result<SearchPage, S3Failure> {
    let mut matches = Vec::new();
    let mut token = String::new();
    let mut scanned = 0usize;
    loop {
        if scanned == SEARCH_PAGES {
            return Ok(SearchPage {
                matches,
                truncated: true,
                reason: Some(LimitReason::PageLimit),
            });
        }
        let page = list_v2(
            client,
            bucket,
            prefix,
            SEARCH_PAGE_KEYS,
            nonempty(&token),
            None,
        )
        .await?;
        scanned += 1;
        for (index, object) in page.objects.iter().enumerate() {
            if !object.key.contains(query) {
                continue;
            }
            matches.push(object.clone());
            if matches.len() == SEARCH_MATCHES {
                let more = index + 1 < page.objects.len() || page.next.is_some();
                if !more {
                    return Ok(SearchPage {
                        matches,
                        truncated: false,
                        reason: None,
                    });
                }
                return Ok(SearchPage {
                    matches,
                    truncated: true,
                    reason: Some(LimitReason::ResultLimit),
                });
            }
        }
        let Some(next) = page.next else {
            return Ok(SearchPage {
                matches,
                truncated: false,
                reason: None,
            });
        };
        token = next;
    }
}

async fn list_v2(
    client: &Client,
    bucket: &str,
    prefix: &str,
    limit: i32,
    token: Option<&str>,
    delimiter: Option<&str>,
) -> Result<Page, S3Failure> {
    let mut request = client.list_objects_v2().bucket(bucket).max_keys(limit);
    if !prefix.is_empty() {
        request = request.prefix(prefix);
    }
    if let Some(token) = token {
        request = request.continuation_token(token);
    }
    if let Some(delimiter) = delimiter {
        request = request.delimiter(delimiter);
    }
    let output = request.send().await.map_err(|error| {
        classify(
            error
                .raw_response()
                .map(|response| response.status().as_u16()),
            error.to_string(),
        )
    })?;
    let objects = output.contents().iter().filter_map(match_from).collect();
    let prefixes = output
        .common_prefixes()
        .iter()
        .filter_map(|entry| entry.prefix().map(str::to_string))
        .filter(|prefix| !prefix.is_empty())
        .collect();
    let next = if output.is_truncated() == Some(true) {
        output
            .next_continuation_token()
            .filter(|token| !token.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    Ok(Page {
        objects,
        prefixes,
        next,
    })
}

fn match_from(object: &aws_sdk_s3::types::Object) -> Option<ObjectMatch> {
    Some(ObjectMatch {
        key: object.key()?.to_string(),
        size: object.size().unwrap_or(0),
        etag: plain_etag(object.e_tag().unwrap_or("")),
        last_modified: object
            .last_modified()
            .copied()
            .map(stamp)
            .unwrap_or_default(),
    })
}

async fn fetch_object(client: &Client, bucket: &str, key: &str) -> Result<ObjectStream, S3Failure> {
    let output = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|error| {
            classify(
                error
                    .raw_response()
                    .map(|response| response.status().as_u16()),
                error.to_string(),
            )
        })?;
    // 不把对象读进 Vec。外层仍按块流出，提前丢弃才会取消上游读取。
    Ok(ObjectStream {
        content_type: output.content_type().unwrap_or("").to_string(),
        body: cancel_when_dropped(output.body.into_inner()),
    })
}

struct DownloadBody {
    inner: Pin<Box<SdkBody>>,
    // 已知长度时，响应端读满字节后可能不再 poll 出结束帧。
    remaining: Option<u64>,
    finished: bool,
}

fn cancel_when_dropped(body: SdkBody) -> SdkBody {
    let hint = HttpBody::size_hint(&body);
    let remaining = hint.upper().filter(|upper| *upper == hint.lower());
    let finished = remaining == Some(0) || HttpBody::is_end_stream(&body);
    SdkBody::from_body_1_x(DownloadBody {
        inner: Box::pin(body),
        remaining,
        finished,
    })
}

impl DownloadBody {
    fn note(&mut self, len: u64) {
        let Some(remaining) = self.remaining.as_mut() else {
            return;
        };
        *remaining = remaining.saturating_sub(len);
        if *remaining == 0 {
            self.finished = true;
        }
    }
}

impl HttpBody for DownloadBody {
    type Data = <SdkBody as HttpBody>::Data;
    type Error = <SdkBody as HttpBody>::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        match this.inner.as_mut().poll_frame(cx) {
            Poll::Ready(None) => {
                this.finished = true;
                Poll::Ready(None)
            }
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(len) = frame.data_ref().map(|data| data.len() as u64) {
                    this.note(len);
                }
                Poll::Ready(Some(Ok(frame)))
            }
            other => other,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.finished || HttpBody::is_end_stream(&*self.inner)
    }

    fn size_hint(&self) -> http_body::SizeHint {
        HttpBody::size_hint(&*self.inner)
    }
}

impl Drop for DownloadBody {
    fn drop(&mut self) {
        if self.finished || HttpBody::is_end_stream(&*self.inner) {
            return;
        }
        tracing::info!("download cancelled");
    }
}

async fn head(client: &Client, bucket: &str, key: &str) -> Result<ObjectMeta, S3Failure> {
    let output = client
        .head_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|error| {
            classify(
                error
                    .raw_response()
                    .map(|response| response.status().as_u16()),
                error.to_string(),
            )
        })?;
    Ok(ObjectMeta {
        key: key.to_string(),
        size: output.content_length().unwrap_or(0),
        etag: plain_etag(output.e_tag().unwrap_or("")),
        last_modified: output
            .last_modified()
            .copied()
            .map(stamp)
            .unwrap_or_default(),
        content_type: output.content_type().map(str::to_string),
    })
}

async fn put_with(
    client: &Client,
    bucket: &str,
    key: &str,
    length: i64,
    content_type: Option<String>,
    body: ByteStream,
) -> Result<String, S3Failure> {
    let omit_default_type = content_type.is_none();
    let mut operation = client
        .put_object()
        .bucket(bucket)
        .key(key)
        .content_length(length)
        .set_content_type(content_type)
        .body(body)
        .customize();
    // SDK 在没收到类型时会补 application/octet-stream。调用方没给类型时，签名前去掉这个默认头。
    if omit_default_type {
        operation = operation.mutate_request(|request| {
            request.headers_mut().remove("content-type");
        });
    }
    let output = operation.send().await.map_err(|error| {
        classify(
            error
                .raw_response()
                .map(|response| response.status().as_u16()),
            error.to_string(),
        )
    })?;
    Ok(plain_etag(output.e_tag().unwrap_or("")))
}

struct InflightPart {
    task: tokio::task::JoinHandle<Result<(i32, String), S3Failure>>,
}

struct PartReader {
    body: Pin<Box<axum::body::Body>>,
    pending: Vec<u8>,
}

impl PartReader {
    fn new(body: axum::body::Body) -> Self {
        Self {
            body: Box::pin(body),
            pending: Vec::new(),
        }
    }

    async fn read_exact(&mut self, want: usize) -> Result<Vec<u8>, S3Failure> {
        let mut out = Vec::with_capacity(want);
        while out.len() < want {
            if !self.pending.is_empty() {
                let need = want - out.len();
                let take = need.min(self.pending.len());
                out.extend(self.pending.drain(..take));
                continue;
            }
            let Some(next) =
                std::future::poll_fn(|cx| HttpBody::poll_frame(self.body.as_mut(), cx)).await
            else {
                // 客户端断开或体比 Content-Length 短时不能完成分片。
                return Err(S3Failure::Local);
            };
            let frame = next.map_err(|_| S3Failure::Local)?;
            let Ok(data) = frame.into_data() else {
                continue;
            };
            self.pending.extend_from_slice(&data);
        }
        Ok(out)
    }
}

#[allow(clippy::too_many_arguments)]
async fn send_parts(
    client: &Client,
    bucket: &str,
    key: &str,
    size: u64,
    part_size: u64,
    content_type: Option<String>,
    source: &Mutex<Option<axum::body::Body>>,
    upload_buffer: Arc<Semaphore>,
) -> Result<String, S3Failure> {
    if part_size == 0 {
        return Err(S3Failure::Local);
    }
    let upload_id = open_multipart(client, bucket, key, content_type).await?;
    let body = source.lock().expect("multipart body").take();
    let Some(body) = body else {
        abort_multipart(client, bucket, key, &upload_id).await;
        return Err(S3Failure::Local);
    };
    let mut reader = PartReader::new(body);
    let mut flights = VecDeque::new();
    let mut done = Vec::new();
    let mut next_number = 1i32;
    let mut left = size;
    while left > 0 || !flights.is_empty() {
        if flights.len() >= PARTS_IN_FLIGHT || left == 0 {
            if let Err(error) = take_part(&mut flights, &mut done).await {
                return stop_parts(client, bucket, key, &upload_id, &mut flights, error).await;
            }
            continue;
        }
        let want = usize::try_from(part_size.min(left)).unwrap_or(usize::MAX);
        // 这一版 tokio 在申请数大于创建时的许可数时不会返回错误，只会一直等。
        // 大于进程上限的分片永远排不上，先中止。
        let permits = match u32::try_from(want) {
            Ok(permits) if want <= crate::state::UPLOAD_BUFFER_BYTES => permits,
            _ => {
                return stop_parts(
                    client,
                    bucket,
                    key,
                    &upload_id,
                    &mut flights,
                    S3Failure::Local,
                )
                .await;
            }
        };
        let permit = match Arc::clone(&upload_buffer).acquire_many_owned(permits).await {
            Ok(permit) => permit,
            Err(_) => {
                return stop_parts(
                    client,
                    bucket,
                    key,
                    &upload_id,
                    &mut flights,
                    S3Failure::Local,
                )
                .await;
            }
        };
        let bytes = match reader.read_exact(want).await {
            Ok(bytes) => bytes,
            Err(error) => {
                drop(permit);
                return stop_parts(client, bucket, key, &upload_id, &mut flights, error).await;
            }
        };
        left = left.saturating_sub(u64::try_from(bytes.len()).unwrap_or(left));
        let number = next_number;
        next_number = next_number.saturating_add(1);
        let task = tokio::spawn({
            let client = client.clone();
            let bucket = bucket.to_string();
            let key = key.to_string();
            let upload_id = upload_id.clone();
            async move {
                let result = upload_one(&client, &bucket, &key, &upload_id, number, bytes).await;
                // 许可跟着分片任务走。父任务停在 acquire 上时，占满额度的分片仍要能结束并归还。
                drop(permit);
                result.map(|etag| (number, etag))
            }
        });
        flights.push_back(InflightPart { task });
    }
    match finish_multipart(client, bucket, key, &upload_id, done).await {
        Ok(etag) => Ok(etag),
        Err(error) => stop_parts(client, bucket, key, &upload_id, &mut flights, error).await,
    }
}

async fn take_part(
    flights: &mut VecDeque<InflightPart>,
    done: &mut Vec<(i32, String)>,
) -> Result<(), S3Failure> {
    let Some(flight) = flights.pop_front() else {
        return Ok(());
    };
    match flight.task.await {
        Ok(Ok(part)) => {
            done.push(part);
            Ok(())
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err(S3Failure::Local),
    }
}

async fn stop_parts(
    client: &Client,
    bucket: &str,
    key: &str,
    upload_id: &str,
    flights: &mut VecDeque<InflightPart>,
    error: S3Failure,
) -> Result<String, S3Failure> {
    for flight in flights.drain(..) {
        flight.task.abort();
    }
    abort_multipart(client, bucket, key, upload_id).await;
    Err(multipart_failure(error))
}

fn multipart_failure(error: S3Failure) -> S3Failure {
    // 分片已经开始读请求体。再把 Forbidden 交回 drive 会重跑整段，第二次体是空的。
    match error {
        S3Failure::Forbidden(message) => S3Failure::Upstream {
            status: 403,
            message,
        },
        other => other,
    }
}

async fn open_multipart(
    client: &Client,
    bucket: &str,
    key: &str,
    content_type: Option<String>,
) -> Result<String, S3Failure> {
    let omit_default_type = content_type.is_none();
    let mut operation = client
        .create_multipart_upload()
        .bucket(bucket)
        .key(key)
        .set_content_type(content_type)
        .customize();
    if omit_default_type {
        operation = operation.mutate_request(|request| {
            request.headers_mut().remove("content-type");
        });
    }
    let output = operation.send().await.map_err(|error| {
        classify(
            error
                .raw_response()
                .map(|response| response.status().as_u16()),
            error.to_string(),
        )
    })?;
    match output.upload_id() {
        Some(id) if !id.is_empty() => Ok(id.to_string()),
        _ => Err(S3Failure::Local),
    }
}

async fn upload_one(
    client: &Client,
    bucket: &str,
    key: &str,
    upload_id: &str,
    number: i32,
    bytes: Vec<u8>,
) -> Result<String, S3Failure> {
    let length = i64::try_from(bytes.len()).map_err(|_| S3Failure::Local)?;
    let output = client
        .upload_part()
        .bucket(bucket)
        .key(key)
        .upload_id(upload_id)
        .part_number(number)
        .content_length(length)
        .body(ByteStream::from(bytes))
        .send()
        .await
        .map_err(|error| {
            classify(
                error
                    .raw_response()
                    .map(|response| response.status().as_u16()),
                error.to_string(),
            )
        })?;
    Ok(plain_etag(output.e_tag().unwrap_or("")))
}

async fn finish_multipart(
    client: &Client,
    bucket: &str,
    key: &str,
    upload_id: &str,
    mut parts: Vec<(i32, String)>,
) -> Result<String, S3Failure> {
    parts.sort_by_key(|(number, _)| *number);
    let mut completed = aws_sdk_s3::types::CompletedMultipartUpload::builder();
    for (number, etag) in parts {
        completed = completed.parts(
            aws_sdk_s3::types::CompletedPart::builder()
                .part_number(number)
                .e_tag(etag)
                .build(),
        );
    }
    let output = client
        .complete_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(upload_id)
        .multipart_upload(completed.build())
        .send()
        .await
        .map_err(|error| {
            classify(
                error
                    .raw_response()
                    .map(|response| response.status().as_u16()),
                error.to_string(),
            )
        })?;
    Ok(plain_etag(output.e_tag().unwrap_or("")))
}

async fn abort_multipart(client: &Client, bucket: &str, key: &str, upload_id: &str) {
    let _ = client
        .abort_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(upload_id)
        .send()
        .await;
}

async fn remove_object(client: &Client, bucket: &str, key: &str) -> Result<(), S3Failure> {
    client
        .delete_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map(|_| ())
        .map_err(|error| {
            classify(
                error
                    .raw_response()
                    .map(|response| response.status().as_u16()),
                error.to_string(),
            )
        })
}

async fn remove_objects(
    client: &Client,
    bucket: &str,
    keys: &[String],
) -> Result<DeleteMany, S3Failure> {
    let mut delete = aws_sdk_s3::types::Delete::builder();
    for key in keys {
        let id = aws_sdk_s3::types::ObjectIdentifier::builder()
            .key(key.as_str())
            .build()
            .map_err(|_| S3Failure::Local)?;
        delete = delete.objects(id);
    }
    let delete = delete.build().map_err(|_| S3Failure::Local)?;
    let output = client
        .delete_objects()
        .bucket(bucket)
        .delete(delete)
        .send()
        .await
        .map_err(|error| {
            classify(
                error
                    .raw_response()
                    .map(|response| response.status().as_u16()),
                error.to_string(),
            )
        })?;
    Ok(DeleteMany {
        deleted: output
            .deleted()
            .iter()
            .filter_map(|item| item.key().map(str::to_string))
            .collect(),
        failed: output
            .errors()
            .iter()
            .filter_map(|item| {
                item.key().map(|key| DeleteFailure {
                    key: key.to_string(),
                    message: item.message().unwrap_or("").to_string(),
                })
            })
            .collect(),
    })
}

struct ReplayBody {
    source: Mutex<Option<axum::body::Body>>,
    path: Mutex<Option<PathBuf>>,
    dir: PathBuf,
    size: u64,
}

impl ReplayBody {
    fn new(dir: PathBuf, size: u64, body: axum::body::Body) -> Arc<Self> {
        Arc::new(Self {
            source: Mutex::new(Some(body)),
            path: Mutex::new(None),
            dir,
            size,
        })
    }

    async fn byte_stream(&self) -> Result<ByteStream, S3Failure> {
        let ready = self.path.lock().expect("put spool").clone();
        let path = if let Some(path) = ready {
            path
        } else {
            let body = self
                .source
                .lock()
                .expect("put body")
                .take()
                .ok_or(S3Failure::Local)?;
            let path = write_body(&self.dir, self.size, body).await?;
            *self.path.lock().expect("put spool") = Some(path.clone());
            path
        };
        ByteStream::from_path(&path)
            .await
            .map_err(|_| S3Failure::Local)
    }
}

impl Drop for ReplayBody {
    fn drop(&mut self) {
        let Ok(path) = self.path.lock() else {
            return;
        };
        if let Some(path) = path.as_ref() {
            let _ = std::fs::remove_file(path);
        }
    }
}

async fn write_body(dir: &Path, size: u64, body: axum::body::Body) -> Result<PathBuf, S3Failure> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let path = dir.join(format!(
        ".put-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = std::fs::File::create(&path).map_err(|_| S3Failure::Local)?;
    let mut written = 0u64;
    let mut body = std::pin::pin!(body);
    loop {
        if written >= size {
            break;
        }
        let Some(next) = std::future::poll_fn(|cx| HttpBody::poll_frame(body.as_mut(), cx)).await
        else {
            break;
        };
        let frame = match next {
            Ok(frame) => frame,
            Err(_) => return Err(discard_spool(&path)),
        };
        let Ok(data) = frame.into_data() else {
            continue;
        };
        let room = usize::try_from(size - written).unwrap_or(usize::MAX);
        let take = data.len().min(room);
        if file.write_all(&data[..take]).is_err() {
            return Err(discard_spool(&path));
        }
        written = written.saturating_add(take as u64);
        if take < data.len() {
            break;
        }
    }
    if file.flush().is_err() {
        return Err(discard_spool(&path));
    }
    Ok(path)
}

fn discard_spool(path: &Path) -> S3Failure {
    let _ = std::fs::remove_file(path);
    S3Failure::Local
}

fn plain_etag(raw: &str) -> String {
    raw.strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(raw)
        .to_string()
}

fn stamp(when: DateTime) -> String {
    when.fmt(DateTimeFormat::DateTime).unwrap_or_default()
}

fn classify(status: Option<u16>, rendered: String) -> S3Failure {
    let message = cut(&rendered);
    match status {
        Some(403) => S3Failure::Forbidden(message),
        Some(404) => S3Failure::NotFound,
        Some(status) => S3Failure::Upstream { status, message },
        None => S3Failure::Down,
    }
}

fn cut(message: &str) -> String {
    message.chars().take(200).collect()
}

async fn drive<T, F, Fut>(app: &App, bucket_id: String, mut call: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnMut(Client) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, S3Failure>> + Send + 'static,
{
    let (endpoint, region) = proxy::s3_origin(app).await;
    let endpoint = endpoint
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::unavailable("garage_unavailable", "Garage is unavailable"))?;
    let sources = sources(app, &bucket_id).await;
    let tls_insecure = app.settings.tls_insecure;
    let tls_ca_pem = app.settings.tls_ca_pem.clone();
    let notes = Arc::new(Mutex::new(None::<String>));
    let notes_for_call = Arc::clone(&notes);
    let attempted = app
        .read_credential(&bucket_id, sources, move |credential| {
            let client = s3_client(
                &region,
                &endpoint,
                &credential,
                tls_insecure,
                tls_ca_pem.as_deref(),
            );
            let pending = call(client);
            let notes = Arc::clone(&notes_for_call);
            async move {
                match pending.await {
                    Ok(value) => Operation::Done(Ok(value)),
                    Err(S3Failure::Forbidden(message)) => {
                        *notes.lock().expect("403 note") = Some(message);
                        Operation::Forbidden
                    }
                    Err(failure) => Operation::Done(Err(failure)),
                }
            }
        })
        .await;
    match attempted {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(S3Failure::NotFound)) => Err(ApiError::not_found()),
        Ok(Err(S3Failure::Upstream { status, message })) => Err(s3_error(status, message)),
        Ok(Err(S3Failure::Forbidden(message))) => Err(s3_error(403, message)),
        Ok(Err(S3Failure::Down)) => Err(ApiError::unavailable(
            "garage_unavailable",
            "Garage is unavailable",
        )),
        Ok(Err(S3Failure::Local)) => Err(ApiError::internal()),
        Err(credentials::ReadFailure::NoUsableKey(missing)) => Err(ApiError::new(
            StatusCode::from_u16(missing.status()).expect("412"),
            missing.code(),
            missing.message(),
        )),
        Err(credentials::ReadFailure::Forbidden) => {
            let message = notes.lock().expect("403 note").take().unwrap_or_default();
            Err(s3_error(403, message))
        }
    }
}

async fn sources(app: &App, bucket_id: &str) -> CredentialSources {
    let project_key = app.settings.project_key.as_ref().map(|key| {
        BucketCredential::new(key.access_key_id.clone(), key.secret_access_key.clone())
    });
    // 项目 key 优先。没有它时才看 explicit_key，不从任意读写 key 里挑。
    let explicit_key = if project_key.is_some() {
        None
    } else {
        explicit_credential(app, bucket_id).await
    };
    CredentialSources {
        project_key,
        explicit_key,
        read_write_keys: Vec::new(),
    }
}

async fn explicit_credential(app: &App, bucket_id: &str) -> Option<BucketCredential> {
    // 库里只留 access key id。密钥每次向 Garage 现取，避免把 secret 写进 sqlite。
    let access_key_id = db::bucket_key(&app.db, bucket_id).await.ok().flatten()?;
    let secret = key_secret(app, &access_key_id).await?;
    Some(BucketCredential::new(access_key_id, secret))
}

async fn key_secret(app: &App, access_key_id: &str) -> Option<String> {
    let response = proxy::fetch_key_secret(app, access_key_id).await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("secretAccessKey")
        .and_then(serde_json::Value::as_str)
        .filter(|secret| !secret.is_empty())
        .map(str::to_string)
}

fn s3_client(
    region: &str,
    endpoint: &str,
    credential: &BucketCredential,
    tls_insecure: bool,
    tls_ca_pem: Option<&[u8]>,
) -> Client {
    let credentials = Credentials::new(
        credential.access_key_id(),
        credential.secret_key(),
        None,
        None,
        "garage-ui",
    );
    // latest 默认校验响应校验和。Garage 不回这些头，开启后正常列表会被判失败。
    // 同一把密钥只打一次 HTTP。403 的第二次尝试由 CredentialCache::read 发起。
    let mut config = aws_sdk_s3::Config::builder()
        .behavior_version(aws_config::BehaviorVersion::latest())
        .region(Region::new(region.to_string()))
        .endpoint_url(endpoint)
        .force_path_style(true)
        .credentials_provider(credentials)
        .retry_config(RetryConfig::standard().with_max_attempts(1))
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired);
    if tls_insecure {
        config = config.http_client(skip_verify_client());
    } else if let Some(pem) = tls_ca_pem {
        config = config.http_client(ca_trust_client(pem));
    }
    Client::from_conf(config.build())
}

fn ca_trust_client(
    pem: &[u8],
) -> aws_smithy_runtime_api::client::http::SharedHttpClient {
    use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};

    let trust = TrustStore::default().with_pem_certificate(pem.to_vec());
    let context = TlsContext::builder()
        .with_trust_store(trust)
        .build()
        .expect("tls context");
    aws_smithy_http_client::Builder::new()
        .tls_provider(tls::Provider::Rustls(
            tls::rustls_provider::CryptoMode::AwsLc,
        ))
        .tls_context(context)
        .build_https()
}

// smithy-http-client 1.5.0 keeps its certificate verifier private.
// The skip switch installs this one. Handshake signatures still have to check,
// or rustls aborts before the certificate decision matters.
struct AcceptAnyServerCert {
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl std::fmt::Debug for AcceptAnyServerCert {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AcceptAnyServerCert")
    }
}

impl rustls::client::danger::ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn skip_verify_client() -> SkipVerifyClient {
    let provider = rustls::crypto::aws_lc_rs::default_provider();
    let algorithms = provider.signature_verification_algorithms;
    let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(provider))
        .with_safe_default_protocol_versions()
        .expect("rustls default versions")
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(AcceptAnyServerCert { algorithms }))
        .with_no_client_auth();
    SkipVerifyClient {
        config: std::sync::Arc::new(config),
    }
}

#[derive(Debug)]
struct SkipVerifyClient {
    config: std::sync::Arc<rustls::ClientConfig>,
}

#[derive(Debug)]
struct SkipVerifyConnector {
    config: std::sync::Arc<rustls::ClientConfig>,
    connect_timeout: Option<std::time::Duration>,
    read_timeout: Option<std::time::Duration>,
}

impl aws_smithy_runtime_api::client::http::HttpClient for SkipVerifyClient {
    fn http_connector(
        &self,
        settings: &aws_smithy_runtime_api::client::http::HttpConnectorSettings,
        _components: &aws_smithy_runtime_api::client::runtime_components::RuntimeComponents,
    ) -> aws_smithy_runtime_api::client::http::SharedHttpConnector {
        aws_smithy_runtime_api::client::http::SharedHttpConnector::new(SkipVerifyConnector {
            config: std::sync::Arc::clone(&self.config),
            connect_timeout: settings.connect_timeout(),
            read_timeout: settings.read_timeout(),
        })
    }
}

impl aws_smithy_runtime_api::client::http::HttpConnector for SkipVerifyConnector {
    fn call(
        &self,
        mut request: aws_smithy_runtime_api::client::orchestrator::HttpRequest,
    ) -> aws_smithy_runtime_api::client::http::HttpConnectorFuture {
        let config = std::sync::Arc::clone(&self.config);
        let connect_timeout = self.connect_timeout;
        let read_timeout = self.read_timeout;
        aws_smithy_runtime_api::client::http::HttpConnectorFuture::new(async move {
            dispatch(&mut request, &config, connect_timeout, read_timeout)
                .await
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::TimedOut {
                        aws_smithy_runtime_api::client::result::ConnectorError::timeout(Box::new(
                            error,
                        ))
                    } else {
                        aws_smithy_runtime_api::client::result::ConnectorError::io(Box::new(error))
                    }
                })
        })
    }
}

async fn dispatch(
    request: &mut aws_smithy_runtime_api::client::orchestrator::HttpRequest,
    config: &std::sync::Arc<rustls::ClientConfig>,
    connect_timeout: Option<std::time::Duration>,
    read_timeout: Option<std::time::Duration>,
) -> std::io::Result<aws_smithy_runtime_api::http::Response> {
    let uri = request.uri().to_string();
    let (https, host, port, lookup) = endpoint_parts(&uri)?;
    let body = request_bytes(request).await?;
    let encoded = encode_request(request, &host, &port, https, &body)?;
    let work = async {
        let mut tcp = connect_tcp(&lookup, connect_timeout).await?;
        let raw = if https {
            tls_exchange(&mut tcp, config, &host, &encoded).await?
        } else {
            plain_exchange(&mut tcp, &encoded).await?
        };
        http_response(&raw)
    };
    match read_timeout {
        Some(limit) => match tokio::time::timeout(limit, work).await {
            Ok(result) => result,
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "read timeout",
            )),
        },
        None => work.await,
    }
}

fn endpoint_parts(uri: &str) -> std::io::Result<(bool, String, String, String)> {
    let https = uri.starts_with("https://");
    let rest = uri.split_once("://").map(|(_, rest)| rest).unwrap_or(uri);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if authority.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "missing authority",
        ));
    }
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let Some((host, rest)) = rest.split_once(']') else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "bad ipv6 authority",
            ));
        };
        (host.to_string(), rest.strip_prefix(':').filter(|port| !port.is_empty()).map(str::to_string))
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) if !host.is_empty() && !port.is_empty() => {
                (host.to_string(), Some(port.to_string()))
            }
            _ => (authority.to_string(), None),
        }
    };
    let port = port.unwrap_or_else(|| if https { "443" } else { "80" }.to_string());
    let lookup = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    Ok((https, host, port, lookup))
}

async fn connect_tcp(lookup: &str, timeout: Option<std::time::Duration>) -> std::io::Result<tokio::net::TcpStream> {
    let connect = async {
        let mut last = std::io::Error::new(std::io::ErrorKind::NotFound, "no address");
        let mut found = false;
        for address in tokio::net::lookup_host(lookup).await? {
            found = true;
            match tokio::net::TcpStream::connect(address).await {
                Ok(stream) => return Ok(stream),
                Err(error) => last = error,
            }
        }
        if found {
            Err(last)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no address",
            ))
        }
    };
    match timeout {
        Some(limit) => match tokio::time::timeout(limit, connect).await {
            Ok(result) => result,
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "connect timeout",
            )),
        },
        None => connect.await,
    }
}

async fn request_bytes(request: &mut aws_smithy_runtime_api::client::orchestrator::HttpRequest) -> std::io::Result<Vec<u8>> {
    let body = request.take_body();
    if let Some(bytes) = body.bytes() {
        return Ok(bytes.to_vec());
    }
    let mut out = Vec::new();
    let mut body = std::pin::pin!(body);
    while let Some(frame) = std::future::poll_fn(|cx| HttpBody::poll_frame(body.as_mut(), cx)).await {
        let frame = frame.map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        out.extend_from_slice(&data);
    }
    Ok(out)
}

fn encode_request(
    request: &mut aws_smithy_runtime_api::client::orchestrator::HttpRequest,
    host: &str,
    port: &str,
    https: bool,
    body: &[u8],
) -> std::io::Result<Vec<u8>> {
    let path = request.uri_mut().path().to_string();
    let query = request.uri_mut().query().unwrap_or("").to_string();
    let path = if path.is_empty() { "/" } else { path.as_str() };
    let target = if query.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{query}")
    };
    let mut head = format!("{} {target} HTTP/1.1\r\n", request.method());
    let mut saw_host = false;
    let mut saw_length = false;
    let mut saw_connection = false;
    for (name, value) in request.headers().iter() {
        if name.eq_ignore_ascii_case("host") {
            saw_host = true;
        } else if name.eq_ignore_ascii_case("content-length") {
            saw_length = true;
        } else if name.eq_ignore_ascii_case("connection") {
            saw_connection = true;
        }
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    if !saw_host {
        let value = if (https && port == "443") || (!https && port == "80") {
            if host.contains(':') {
                format!("[{host}]")
            } else {
                host.to_string()
            }
        } else if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        head.push_str("host: ");
        head.push_str(&value);
        head.push_str("\r\n");
    }
    if !saw_length {
        head.push_str(&format!("content-length: {}\r\n", body.len()));
    }
    if !saw_connection {
        head.push_str("connection: close\r\n");
    }
    head.push_str("\r\n");
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(body);
    Ok(bytes)
}

async fn plain_exchange(tcp: &mut tokio::net::TcpStream, request: &[u8]) -> std::io::Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tcp.write_all(request).await?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        if decode_http(&raw, false)?.is_some() {
            return Ok(raw);
        }
        let read = tcp.read(&mut buf).await?;
        if read == 0 {
            if decode_http(&raw, true)?.is_some() {
                return Ok(raw);
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "response closed",
            ));
        }
        raw.extend_from_slice(&buf[..read]);
    }
}

async fn tls_exchange(
    tcp: &mut tokio::net::TcpStream,
    config: &std::sync::Arc<rustls::ClientConfig>,
    host: &str,
    request: &[u8],
) -> std::io::Result<Vec<u8>> {
    let name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "server name"))?;
    let mut conn = rustls::ClientConnection::new(std::sync::Arc::clone(config), name)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    handshake(tcp, &mut conn).await?;
    write_plain(tcp, &mut conn, request).await?;
    read_plain_http(tcp, &mut conn).await
}

async fn handshake(
    tcp: &mut tokio::net::TcpStream,
    conn: &mut rustls::ClientConnection,
) -> std::io::Result<()> {
    while conn.is_handshaking() {
        flush_tls(tcp, conn).await?;
        if !conn.wants_read() {
            if conn.wants_write() {
                continue;
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "tls handshake stalled",
            ));
        }
        if pull_tls(tcp, conn).await? == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "tls handshake closed",
            ));
        }
    }
    flush_tls(tcp, conn).await
}

async fn flush_tls(
    tcp: &mut tokio::net::TcpStream,
    conn: &mut rustls::ClientConnection,
) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    while conn.wants_write() {
        let mut cipher = Vec::new();
        let wrote = conn.write_tls(&mut cipher)?;
        if wrote == 0 || cipher.is_empty() {
            break;
        }
        tcp.write_all(&cipher).await?;
    }
    Ok(())
}

async fn pull_tls(
    tcp: &mut tokio::net::TcpStream,
    conn: &mut rustls::ClientConnection,
) -> std::io::Result<usize> {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 16 * 1024];
    let read = tcp.read(&mut buf).await?;
    if read == 0 {
        let _ = conn.read_tls(&mut &[][..])?;
        return Ok(0);
    }
    let mut offset = 0;
    while offset < read {
        let wrote = conn.read_tls(&mut &buf[offset..read])?;
        if wrote == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "tls buffer full",
            ));
        }
        offset += wrote;
    }
    conn.process_new_packets()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    Ok(read)
}

async fn write_plain(
    tcp: &mut tokio::net::TcpStream,
    conn: &mut rustls::ClientConnection,
    data: &[u8],
) -> std::io::Result<()> {
    let mut offset = 0;
    while offset < data.len() {
        match conn.writer().write(&data[offset..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "tls writer",
                ))
            }
            Ok(wrote) => offset += wrote,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error),
        }
        flush_tls(tcp, conn).await?;
    }
    flush_tls(tcp, conn).await
}

async fn read_plain_http(
    tcp: &mut tokio::net::TcpStream,
    conn: &mut rustls::ClientConnection,
) -> std::io::Result<Vec<u8>> {
    let mut raw = Vec::new();
    loop {
        drain_plain(conn, &mut raw)?;
        if decode_http(&raw, false)?.is_some() {
            return Ok(raw);
        }
        if pull_tls(tcp, conn).await? == 0 {
            drain_plain(conn, &mut raw)?;
            if decode_http(&raw, true)?.is_some() {
                return Ok(raw);
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "response closed",
            ));
        }
    }
}

fn drain_plain(conn: &mut rustls::ClientConnection, out: &mut Vec<u8>) -> std::io::Result<()> {
    use std::io::Read;

    let mut buf = [0u8; 8192];
    loop {
        match conn.reader().read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(read) => out.extend_from_slice(&buf[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        }
    }
}

fn http_response(raw: &[u8]) -> std::io::Result<aws_smithy_runtime_api::http::Response> {
    let message = decode_http(raw, true)?.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "response closed")
    })?;
    let status = aws_smithy_runtime_api::http::StatusCode::try_from(message.status)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))?;
    let mut response = aws_smithy_runtime_api::http::Response::new(status, SdkBody::from(message.body));
    for (name, value) in message.headers {
        let _ = response.headers_mut().try_insert(name, value);
    }
    Ok(response)
}

struct HttpMessage {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn decode_http(raw: &[u8], eof: bool) -> std::io::Result<Option<HttpMessage>> {
    let Some(split) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
        if eof {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "http headers",
            ));
        }
        return Ok(None);
    };
    let head = std::str::from_utf8(&raw[..split])
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "http status"))?;
    let mut headers = Vec::new();
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse().ok();
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
        {
            chunked = true;
        }
        headers.push((name.to_string(), value.to_string()));
    }
    let rest = &raw[split + 4..];
    let body = if chunked {
        match decode_chunks(rest) {
            Some(body) => body,
            None if eof => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "http chunks",
                ))
            }
            None => return Ok(None),
        }
    } else if let Some(length) = length {
        if rest.len() < length {
            if eof {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "http body",
                ));
            }
            return Ok(None);
        }
        rest[..length].to_vec()
    } else if eof {
        rest.to_vec()
    } else {
        return Ok(None);
    };
    Ok(Some(HttpMessage {
        status,
        headers,
        body,
    }))
}

fn decode_chunks(mut rest: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = rest.windows(2).position(|window| window == b"\r\n")?;
        let line = std::str::from_utf8(&rest[..line_end]).ok()?;
        let size = usize::from_str_radix(line.split(';').next()?.trim(), 16).ok()?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            if rest.is_empty() || rest.starts_with(b"\r\n") {
                return Some(out);
            }
            return rest
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|_| out);
        }
        if rest.len() < size + 2 || &rest[size..size + 2] != b"\r\n" {
            return None;
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
}

fn s3_error(status: u16, message: String) -> ApiError {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let body = serde_json::to_vec(&serde_json::json!({
        "code": "s3_error",
        "message": message,
    }))
    .expect("s3 error json");
    ApiError::upstream(
        code,
        body,
        Some(HeaderValue::from_static("application/json")),
    )
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read};
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};

    use super::*;

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
        let output = Command::new("openssl").args(args).output().expect("openssl");
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

    fn error_chain(error: &dyn std::error::Error) -> String {
        let mut text = error.to_string();
        let mut source = error.source();
        while let Some(inner) = source {
            text.push_str(": ");
            text.push_str(&inner.to_string());
            source = inner.source();
        }
        text
    }

    async fn handshake_error(endpoint: &str, tls_insecure: bool, ca: Option<&[u8]>) -> String {
        let credential = BucketCredential::new("AKIATEST", "secret");
        let client = s3_client("garage", endpoint, &credential, tls_insecure, ca);
        match client.list_buckets().send().await {
            Ok(_) => String::new(),
            Err(error) => error_chain(&error),
        }
    }

    #[tokio::test]
    async fn s3_client_verifies_tls_unless_the_switch_is_one() {
        let probe = TlsProbe::start();
        let endpoint = format!("https://127.0.0.1:{}", probe.port);
        let ca = std::fs::read(&probe.ca).expect("ca pem");

        let denied = handshake_error(&endpoint, false, None).await;
        assert!(denied.contains("certificate"), "{denied}");

        let trusted = handshake_error(&endpoint, false, Some(ca.as_slice())).await;
        assert!(
            !trusted.contains("certificate"),
            "custom CA must pass the handshake: {trusted}"
        );

        let skipped = handshake_error(&endpoint, true, None).await;
        assert!(
            !skipped.contains("certificate"),
            "tls_insecure must pass the handshake: {skipped}"
        );
    }
}
