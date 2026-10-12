use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, RawQuery, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde::Serialize;
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
use super::page_window;
use super::percent_encode;
use super::post_garage;
use super::record;
use super::status;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminTokenListItem {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    expiration: Option<String>,
    expired: bool,
    scope: Vec<String>,
    #[serde(default, skip_deserializing)]
    from_config: bool,
}

// id 是 bearer 的前缀。本机正在使用的令牌不能把这个前缀送进浏览器。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CurrentAdminToken {
    name: String,
    created: Option<String>,
    expiration: Option<String>,
    expired: bool,
    scope: Vec<String>,
    from_config: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct CreateAdminTokenBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expiration: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    never_expires: Option<bool>,
}

pub(crate) async fn create_admin_token(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
    Json(body): Json<CreateAdminTokenBody>,
) -> Result<Response, ApiError> {
    let bytes = serde_json::to_vec(&body).map_err(|_| ApiError::internal())?;
    let response = post_garage(&app, &current, &headers, "CreateAdminToken", None, &bytes).await?;
    finish_created_admin_token(&app, &current, response).await
}

async fn finish_created_admin_token(
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
        && let Some(id) = created_admin_token_id(&bytes)
    {
        record(
            app,
            &current.user.username,
            &current.ip,
            "success",
            "ok",
            "POST",
            "/api/admin-tokens",
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

fn created_admin_token_id(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let id = value.get("id")?.as_str()?;
    (!id.is_empty()).then(|| id.to_string())
}

pub(crate) async fn update_admin_token(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreateAdminTokenBody>,
) -> Result<Response, ApiError> {
    let bytes = serde_json::to_vec(&body).map_err(|_| ApiError::internal())?;
    let query = format!("id={}", percent_encode(&id));
    let response = post_garage(
        &app,
        &current,
        &headers,
        "UpdateAdminToken",
        Some(&query),
        &bytes,
    )
    .await?;
    finish_updated_admin_token(&app, &current, &id, response).await
}

async fn finish_updated_admin_token(
    app: &App,
    current: &Current,
    id: &str,
    response: Response,
) -> Result<Response, ApiError> {
    let status = response.status();
    if !status.is_success() {
        return Ok(response);
    }
    let mut headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    // 更新成功时上游仍可能带回 secret。这次之后的响应里不能再有它。
    let bytes = without_admin_token_secret(&bytes)?;
    record(
        app,
        &current.user.username,
        &current.ip,
        "success",
        "ok",
        "PATCH",
        &format!("/api/admin-tokens/{id}"),
        id,
        i64::from(status.as_u16()),
    )
    .await?;
    headers.insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    let mut out = Response::new(Body::from(bytes));
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    Ok(out)
}

pub(crate) async fn delete_admin_token(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let query = format!("id={}", percent_encode(&id));
    let response = post_garage(
        &app,
        &current,
        &headers,
        "DeleteAdminToken",
        Some(&query),
        &[],
    )
    .await?;
    finish_deleted_admin_token(&app, &current, &id, response).await
}

async fn finish_deleted_admin_token(
    app: &App,
    current: &Current,
    id: &str,
    response: Response,
) -> Result<Response, ApiError> {
    let status = response.status();
    if !status.is_success() {
        return Ok(response);
    }
    let mut headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    // 删除成功时上游仍可能带回 secret。这次之后的响应里不能再有它。
    let bytes = without_admin_token_secret(&bytes)?;
    record(
        app,
        &current.user.username,
        &current.ip,
        "success",
        "ok",
        "DELETE",
        &format!("/api/admin-tokens/{id}"),
        id,
        i64::from(status.as_u16()),
    )
    .await?;
    headers.insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    let mut out = Response::new(Body::from(bytes));
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    Ok(out)
}

fn without_admin_token_secret(bytes: &[u8]) -> Result<Vec<u8>, ApiError> {
    let Ok(mut value) = serde_json::from_slice::<Value>(bytes) else {
        return Ok(bytes.to_vec());
    };
    let Some(object) = value.as_object_mut() else {
        return Ok(bytes.to_vec());
    };
    if object.remove("secretToken").is_none() {
        return Ok(bytes.to_vec());
    }
    serde_json::to_vec(&value).map_err(|_| ApiError::internal())
}

fn admin_token_info(bytes: &[u8]) -> Result<AdminTokenListItem, ApiError> {
    let mut item: AdminTokenListItem =
        serde_json::from_slice(bytes).map_err(|_| ApiError::internal())?;
    mark_admin_token_from_config(&mut item);
    Ok(item)
}

fn admin_token_list(bytes: &[u8]) -> Result<Vec<AdminTokenListItem>, ApiError> {
    let mut items: Vec<AdminTokenListItem> =
        serde_json::from_slice(bytes).map_err(|_| ApiError::internal())?;
    for item in &mut items {
        mark_admin_token_from_config(item);
    }
    Ok(items)
}

fn mark_admin_token_from_config(item: &mut AdminTokenListItem) {
    // 配置文件里的 admin_token 和 metrics_token 没有 id。null 表示之后不能改。
    item.from_config = item.id.is_none();
}

fn current_admin_token_view(item: AdminTokenListItem) -> CurrentAdminToken {
    CurrentAdminToken {
        name: item.name,
        created: item.created,
        expiration: item.expiration,
        expired: item.expired,
        scope: item.scope,
        from_config: item.from_config,
    }
}

pub(crate) async fn current_admin_token(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let response = proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/GetCurrentAdminTokenInfo",
        None,
        &[],
        &headers,
    )
    .await?;
    let status = response.status();
    if !status.is_success() {
        return Ok(response);
    }
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    let item = admin_token_info(&bytes)?;
    let mut out = Json(current_admin_token_view(item)).into_response();
    *out.status_mut() = status;
    out.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    Ok(out)
}

pub(crate) async fn get_admin_token(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let query = format!("id={}", percent_encode(&id));
    let response = proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/GetAdminTokenInfo",
        Some(&query),
        &[],
        &headers,
    )
    .await?;
    let status = response.status();
    if !status.is_success() {
        return Ok(response);
    }
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    let item = admin_token_info(&bytes)?;
    let mut out = Json(item).into_response();
    *out.status_mut() = status;
    out.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    Ok(out)
}

pub(crate) async fn list_admin_tokens(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<PageQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    // 没权限时仍交给 dispatch 记拒绝。坏窗口不能抢在这次拒绝前面。
    let bounds = if access::permits(current.user.actor(), Op::AdminTokens) {
        Some(page_bounds(&query)?)
    } else {
        None
    };
    let response = proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/ListAdminTokens",
        None,
        &[],
        &headers,
    )
    .await?;
    let status = response.status();
    if !status.is_success() {
        return Ok(response);
    }
    let (offset, limit) = bounds.ok_or_else(ApiError::internal)?;
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    let items = admin_token_list(&bytes)?;
    let (page, more) = page_window(items, offset, limit);
    let mut out = Json(json!({
        "items": page,
        "hasMore": more,
    }))
    .into_response();
    *out.status_mut() = status;
    Ok(out)
}
