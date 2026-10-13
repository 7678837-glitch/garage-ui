use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, RawQuery, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, patch, post, put};
use serde::Deserialize;
use serde_json::{Value, json};
use crate::access::{self, Op};
use crate::error::ApiError;
use crate::proxy::{self, confirmed};
use crate::session::{
    self, Current, apply_login_cookies, clear_cookies, client_ip, cookie, csrf_exempt, csrf_matches,
};
use crate::state::{self, App};
use super::Authed;
use super::PageQuery;
use super::page_bounds;
use super::page_json;
use super::percent_encode;
use super::post_garage;
use super::record;
use super::require;
use super::status;
use axum::Router;

pub(crate) async fn list_keys(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    require(&current.user, Op::ViewKeys)?;
    let (offset, limit) = page_bounds(&query)?;
    let page = proxy::list_keys(&app, offset, limit).await?;
    Ok(page_json(page))
}

pub(crate) async fn key_secret(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ViewSecret) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "POST",
            "/api/keys/secret",
            &id,
            403,
        )
        .await?;
        return Err(error);
    }
    if !confirmed(&headers) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "confirmation_required",
            "POST",
            "/api/keys/secret",
            &id,
            403,
        )
        .await?;
        return Err(ApiError::forbidden(
            "confirmation_required",
            "Confirmation required",
        ));
    }
    let mut response = proxy::fetch_key_secret(&app, &id).await?;
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    record(
        &app,
        &current.user.username,
        &current.ip,
        "success",
        "secret_view",
        "POST",
        "/api/keys/secret",
        &id,
        i64::from(response.status().as_u16()),
    )
    .await?;
    Ok(response)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateKeyBody {
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct PatchKeyBody {
    name: Option<String>,
    create_bucket: Option<bool>,
}

enum KeyPatch {
    Rename(String),
    CreateBucket(bool),
}

fn valid_new_key_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn key_patch(body: PatchKeyBody) -> Result<KeyPatch, ApiError> {
    match (body.name, body.create_bucket) {
        (Some(name), None) => Ok(KeyPatch::Rename(name)),
        (None, Some(allowed)) => Ok(KeyPatch::CreateBucket(allowed)),
        _ => Err(ApiError::bad_request(
            "invalid_key_patch",
            "Send a name or createBucket",
        )),
    }
}

fn key_patch_body(patch: KeyPatch) -> Value {
    match patch {
        KeyPatch::Rename(name) => json!({ "name": name }),
        KeyPatch::CreateBucket(true) => json!({ "allow": { "createBucket": true } }),
        KeyPatch::CreateBucket(false) => json!({ "deny": { "createBucket": true } }),
    }
}

pub(crate) async fn create_key(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
    Json(body): Json<CreateKeyBody>,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeKeys) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "POST",
            "/api/keys",
            &body.name,
            403,
        )
        .await?;
        return Err(error);
    }
    if !valid_new_key_name(&body.name) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "error",
            "invalid_key_name",
            "POST",
            "/api/keys",
            &body.name,
            400,
        )
        .await?;
        return Err(ApiError::bad_request(
            "invalid_key_name",
            "Key name is invalid",
        ));
    }
    let bytes =
        serde_json::to_vec(&json!({ "name": body.name })).map_err(|_| ApiError::internal())?;
    let response = post_garage(&app, &current, &headers, "CreateKey", None, &bytes).await?;
    finish_created_key(&app, &current, response).await
}

pub(crate) async fn get_key(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewKeys)?;
    let query = format!("id={}", percent_encode(&id));
    let response = proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/GetKeyInfo",
        Some(&query),
        &[],
        &headers,
    )
    .await?;
    hide_key_secret(&app, response).await
}

async fn hide_key_secret(app: &App, response: Response) -> Result<Response, ApiError> {
    let status = response.status();
    if !status.is_success() {
        return Ok(response);
    }
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    let bytes = without_secret_access_key(&bytes)?;
    let mut out = Response::new(Body::from(bytes));
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    Ok(out)
}

fn without_secret_access_key(bytes: &[u8]) -> Result<Vec<u8>, ApiError> {
    let Ok(mut value) = serde_json::from_slice::<Value>(bytes) else {
        return Ok(bytes.to_vec());
    };
    let Some(object) = value.as_object_mut() else {
        return Ok(bytes.to_vec());
    };
    if object.remove("secretAccessKey").is_none() {
        return Ok(bytes.to_vec());
    }
    serde_json::to_vec(&value).map_err(|_| ApiError::internal())
}

pub(crate) async fn patch_key(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PatchKeyBody>,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeKeys) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "PATCH",
            "/api/keys",
            &id,
            403,
        )
        .await?;
        return Err(error);
    }
    let patch = match key_patch(body) {
        Ok(patch) => patch,
        Err(error) => {
            record(
                &app,
                &current.user.username,
                &current.ip,
                "error",
                "invalid_key_patch",
                "PATCH",
                "/api/keys",
                &id,
                400,
            )
            .await?;
            return Err(error);
        }
    };
    let bytes = serde_json::to_vec(&key_patch_body(patch)).map_err(|_| ApiError::internal())?;
    let query = format!("id={}", percent_encode(&id));
    post_garage(&app, &current, &headers, "UpdateKey", Some(&query), &bytes).await
}

pub(crate) async fn delete_key(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ChangeKeys) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "DELETE",
            "/api/keys",
            &id,
            403,
        )
        .await?;
        return Err(error);
    }
    let query = format!("id={}", percent_encode(&id));
    post_garage(&app, &current, &headers, "DeleteKey", Some(&query), &[]).await
}

async fn finish_created_key(
    app: &App,
    current: &Current,
    response: Response,
) -> Result<Response, ApiError> {
    let status = response.status();
    let mut headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    if status.is_success()
        && let Some(id) = created_key_id(&bytes)
    {
        record(
            app,
            &current.user.username,
            &current.ip,
            "success",
            "ok",
            "POST",
            "/api/keys",
            &id,
            i64::from(status.as_u16()),
        )
        .await?;
    }
    headers.insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    let mut out = Response::new(Body::from(bytes));
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    Ok(out)
}

fn created_key_id(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    ["accessKeyId", "id"].into_iter().find_map(|field| {
        let id = value.get(field)?.as_str()?;
        (!id.is_empty()).then(|| id.to_string())
    })
}

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route("/api/keys", get(list_keys).post(create_key))
        .route(
            "/api/keys/{id}",
            get(get_key).patch(patch_key).delete(delete_key),
        )
        .route("/api/keys/{id}/secret", post(key_secret))
}
