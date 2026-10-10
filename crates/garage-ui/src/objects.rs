use std::sync::{Arc, Mutex};

use aws_sdk_s3::Client;
use aws_sdk_s3::config::retry::RetryConfig;
use aws_sdk_s3::config::{
    Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::primitives::{DateTime, DateTimeFormat};
use axum::http::{HeaderValue, StatusCode};
use serde::Serialize;

use crate::error::ApiError;
use crate::state::App;
use crate::state::credentials::{self, BucketCredential, CredentialSources, Operation};

const SEARCH_MATCHES: usize = 200;
const SEARCH_PAGES: usize = 20;
const SEARCH_PAGE_KEYS: i32 = 1000;

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

enum S3Failure {
    Forbidden(String),
    NotFound,
    Upstream { status: u16, message: String },
    Down,
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
