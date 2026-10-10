use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use aws_sdk_s3::Client;
use aws_sdk_s3::config::retry::RetryConfig;
use aws_sdk_s3::config::{
    Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::primitives::{ByteStream, DateTime, DateTimeFormat, SdkBody};
use axum::body::HttpBody;
use axum::http::{HeaderValue, StatusCode};
use serde::Serialize;

use crate::error::ApiError;
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
    let etag = drive(app, bucket.clone(), {
        let bucket = bucket.clone();
        let key = key.clone();
        let source = Arc::clone(&source);
        move |client| {
            let bucket = bucket.clone();
            let key = key.clone();
            let source = Arc::clone(&source);
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
    // 不把对象读进 Vec。SdkBody 直接成为响应体，大文件按块流出。
    Ok(ObjectStream {
        content_type: output.content_type().unwrap_or("").to_string(),
        body: output.body.into_inner(),
    })
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

async fn send_parts(
    client: &Client,
    bucket: &str,
    key: &str,
    size: u64,
    part_size: u64,
    content_type: Option<String>,
    source: &Mutex<Option<axum::body::Body>>,
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
        let bytes = match reader.read_exact(want).await {
            Ok(bytes) => bytes,
            Err(error) => {
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
                let etag = upload_one(&client, &bucket, &key, &upload_id, number, bytes).await?;
                Ok((number, etag))
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
    let endpoint = app
        .settings
        .s3_endpoint_url
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::unavailable("garage_unavailable", "Garage is unavailable"))?;
    let region = app.settings.s3_region.clone();
    let sources = sources(app);
    let notes = Arc::new(Mutex::new(None::<String>));
    let notes_for_call = Arc::clone(&notes);
    let attempted = app
        .read_credential(&bucket_id, sources, move |credential| {
            let client = s3_client(&region, &endpoint, &credential);
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

fn sources(app: &App) -> CredentialSources {
    CredentialSources {
        project_key: app.settings.project_key.as_ref().map(|key| {
            BucketCredential::new(key.access_key_id.clone(), key.secret_access_key.clone())
        }),
        explicit_key: None,
        read_write_keys: Vec::new(),
    }
}

fn s3_client(region: &str, endpoint: &str, credential: &BucketCredential) -> Client {
    let credentials = Credentials::new(
        credential.access_key_id(),
        credential.secret_key(),
        None,
        None,
        "garage-ui",
    );
    // latest 默认校验响应校验和。Garage 不回这些头，开启后正常列表会被判失败。
    // 同一把密钥只打一次 HTTP。403 的第二次尝试由 CredentialCache::read 发起。
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(aws_config::BehaviorVersion::latest())
        .region(Region::new(region.to_string()))
        .endpoint_url(endpoint)
        .force_path_style(true)
        .credentials_provider(credentials)
        .retry_config(RetryConfig::standard().with_max_attempts(1))
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
        .build();
    Client::from_conf(config)
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
