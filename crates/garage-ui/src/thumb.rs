use std::collections::{HashMap, VecDeque};
use std::io::Cursor;
use std::pin::Pin;
use std::sync::{LazyLock, Mutex};

use aws_sdk_s3::primitives::SdkBody;
use axum::body::{Body, HttpBody};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use tokio::sync::Semaphore;

use crate::error::ApiError;
use crate::objects::{self, ObjectMeta};
use crate::preview::preview_policy;
use crate::state::App;

const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PIXELS: u64 = 40_000_000;
const DECODE_SLOTS: usize = 2;
// 规格写了 LRU 总大小可配置，但没有配置字段。32 MiB 是进程内上限。
const CACHE_BYTES: usize = 32 * 1024 * 1024;
const THUMB_EDGE: u32 = 256;

static SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(DECODE_SLOTS));
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));

struct Stored {
    content_type: &'static str,
    bytes: Vec<u8>,
}

struct Made {
    content_type: &'static str,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct Cache {
    used: usize,
    order: VecDeque<String>,
    map: HashMap<String, Stored>,
}

pub(crate) async fn deliver(app: &App, bucket: &str, key: &str) -> Result<Response, ApiError> {
    let meta = match objects::metadata(app, bucket, key).await {
        Ok(meta) => meta,
        Err(error) => return Ok(crate::error::single_error(error).await),
    };
    if !bitmap_declared(&meta) || meta.size > i64::try_from(MAX_SOURCE_BYTES).unwrap_or(i64::MAX) {
        return Ok(skip());
    }
    if let Some(hit) = lookup(&meta.etag) {
        return Ok(image_response(hit));
    }
    let _permit = SLOTS.acquire().await.map_err(|_| ApiError::internal())?;
    if let Some(hit) = lookup(&meta.etag) {
        return Ok(image_response(hit));
    }
    let opened = objects::open(app, bucket, key).await?;
    let Some(bytes) = read_capped(opened.body, MAX_SOURCE_BYTES).await? else {
        return Ok(skip());
    };
    let made = match tokio::task::spawn_blocking(move || encode(bytes)).await {
        Ok(made) => made,
        Err(_) => return Err(ApiError::internal()),
    };
    let Some(made) = made else {
        return Ok(skip());
    };
    store(&meta.etag, &made);
    Ok(image_response(made))
}

fn bitmap_declared(meta: &ObjectMeta) -> bool {
    let declared = meta.content_type.as_deref().unwrap_or("");
    let policy = preview_policy(declared, "thumb");
    policy.content_disposition.is_none() && policy.content_type.starts_with("image/")
}

fn lookup(etag: &str) -> Option<Made> {
    if etag.is_empty() {
        return None;
    }
    let mut cache = CACHE.lock().expect("thumbnail cache");
    let hit = cache.map.get(etag)?;
    let made = Made {
        content_type: hit.content_type,
        bytes: hit.bytes.clone(),
    };
    if let Some(index) = cache.order.iter().position(|key| key == etag) {
        let key = cache.order.remove(index).expect("lru index");
        cache.order.push_back(key);
    }
    Some(made)
}

fn store(etag: &str, made: &Made) {
    if etag.is_empty() || made.bytes.len() > CACHE_BYTES {
        return;
    }
    let mut cache = CACHE.lock().expect("thumbnail cache");
    if let Some(old) = cache.map.remove(etag) {
        cache.used = cache.used.saturating_sub(old.bytes.len());
        cache.order.retain(|key| key != etag);
    }
    while cache.used + made.bytes.len() > CACHE_BYTES {
        let Some(old_key) = cache.order.pop_front() else {
            break;
        };
        if let Some(old) = cache.map.remove(&old_key) {
            cache.used = cache.used.saturating_sub(old.bytes.len());
        }
    }
    if cache.used + made.bytes.len() > CACHE_BYTES {
        return;
    }
    cache.used += made.bytes.len();
    cache.order.push_back(etag.to_string());
    cache.map.insert(
        etag.to_string(),
        Stored {
            content_type: made.content_type,
            bytes: made.bytes.clone(),
        },
    );
}

fn encode(bytes: Vec<u8>) -> Option<Made> {
    let format = image::guess_format(&bytes).ok()?;
    let content_type = media_type(format)?;
    let mut header = image::ImageReader::with_format(Cursor::new(bytes.as_slice()), format);
    header.limits(decode_limits());
    let (width, height) = header.into_dimensions().ok()?;
    // (u32::MAX)^2 不进 u64。溢出按超限，不能进入解码。
    let pixels = u64::from(width).checked_mul(u64::from(height))?;
    if pixels > MAX_PIXELS {
        return None;
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes.as_slice()), format);
    reader.limits(decode_limits());
    let image = reader.decode().ok()?;
    let thumb = image.thumbnail(THUMB_EDGE, THUMB_EDGE);
    let mut encoded = Vec::new();
    thumb
        .write_to(Cursor::new(&mut encoded), format)
        .ok()?;
    if encoded.is_empty() {
        return None;
    }
    Some(Made {
        content_type,
        bytes: encoded,
    })
}

fn decode_limits() -> image::Limits {
    let mut limits = image::Limits::no_limits();
    limits.max_alloc = Some(MAX_PIXELS.saturating_mul(4));
    limits
}

fn media_type(format: image::ImageFormat) -> Option<&'static str> {
    Some(match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Gif => "image/gif",
        image::ImageFormat::WebP => "image/webp",
        image::ImageFormat::Avif => "image/avif",
        image::ImageFormat::Bmp => "image/bmp",
        image::ImageFormat::Ico => "image/x-icon",
        _ => return None,
    })
}

async fn read_capped(mut body: SdkBody, cap: u64) -> Result<Option<Vec<u8>>, ApiError> {
    let cap = usize::try_from(cap).unwrap_or(usize::MAX);
    let mut out = Vec::new();
    loop {
        let next = std::future::poll_fn(|cx| HttpBody::poll_frame(Pin::new(&mut body), cx)).await;
        let Some(frame) = next else {
            return Ok(Some(out));
        };
        let frame = frame.map_err(|_| ApiError::internal())?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        if out.len().saturating_add(data.len()) > cap {
            return Ok(None);
        }
        out.extend_from_slice(&data);
    }
}

fn image_response(made: Made) -> Response {
    let mut response = Response::new(Body::from(made.bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(made.content_type),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; frame-ancestors 'self'"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("SAMEORIGIN"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

fn skip() -> Response {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .expect("empty 204")
}
