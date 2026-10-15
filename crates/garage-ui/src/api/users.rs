use super::Authed;
use super::PageQuery;
use super::hash_password;
use super::page_bounds;
use super::page_window;
use super::record;
use super::require;
use super::validate_password;
use super::validate_username;
use crate::access::Op;
use crate::db::{self, User};
use crate::error::ApiError;
use crate::proxy;
use crate::session::Current;
use crate::state::App;
use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};

const MAX_KEY_ID_LEN: usize = 128;

#[derive(Deserialize)]
pub(crate) struct NewUser {
    username: String,
    password: String,
    role: String,
    #[serde(default)]
    can_download: bool,
    #[serde(default)]
    can_share: bool,
    #[serde(default)]
    access_key_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct UserPatch {
    role: Option<String>,
    can_download: Option<bool>,
    can_share: Option<bool>,
    disabled: Option<bool>,
    // Absent keeps the bound key, null removes it, a string binds that key.
    #[serde(default, deserialize_with = "present")]
    access_key_id: Option<Option<String>>,
}

fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
pub(crate) struct ResetBody {
    password: String,
}

pub(crate) async fn list_users(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    require(&current.user, Op::ManageUsers)?;
    let (offset, limit) = page_bounds(&query)?;
    let users = db::list_users(&app.db)
        .await
        .map_err(|_| ApiError::internal())?;
    let created = db::list_user_created_at(&app.db)
        .await
        .map_err(|_| ApiError::internal())?;
    let (page, more) = page_window(users, offset, limit);
    let mut listed = Vec::with_capacity(page.len());
    for user in &page {
        // 对不上库里的创建时间就失败，不编一个时间。
        let created_at = created
            .iter()
            .find(|row| row.id == user.id)
            .map(|row| row.created_at)
            .ok_or_else(ApiError::internal)?;
        listed.push(public_user(user, created_at));
    }
    Ok(Json(json!({
        "items": listed,
        "hasMore": more,
    })))
}

pub(crate) async fn create_user(
    State(app): State<App>,
    Authed(current): Authed,
    Json(body): Json<NewUser>,
) -> Result<Response, ApiError> {
    if let Err(error) = require(&current.user, Op::ManageUsers) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "POST",
            "/api/users",
            &body.username,
            403,
        )
        .await?;
        return Err(error);
    }
    if let Err(error) = validate_username(&body.username) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "error",
            "invalid_username",
            "POST",
            "/api/users",
            &body.username,
            400,
        )
        .await?;
        return Err(error);
    }
    if let Err(error) = validate_password(&body.password) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "error",
            "password_invalid",
            "POST",
            "/api/users",
            &body.username,
            400,
        )
        .await?;
        return Err(error);
    }
    let role = match parse_role(&body.role) {
        Ok(role) => role,
        Err(error) => {
            record(
                &app,
                &current.user.username,
                &current.ip,
                "error",
                "invalid_role",
                "POST",
                "/api/users",
                &body.username,
                400,
            )
            .await?;
            return Err(error);
        }
    };
    let (download, share) = match normalize_bits(role, body.can_download, body.can_share) {
        Ok(bits) => bits,
        Err(error) => {
            record(
                &app,
                &current.user.username,
                &current.ip,
                "error",
                "share_requires_download",
                "POST",
                "/api/users",
                &body.username,
                400,
            )
            .await?;
            return Err(error);
        }
    };
    if let Some(key) = body.access_key_id.as_deref() {
        let checked = match check_key_shape(role, key) {
            Ok(()) => require_garage_key(&app, key).await,
            Err(error) => Err(error),
        };
        if let Err(error) = checked {
            return Err(reject(&app, &current, "POST", &body.username, error).await);
        }
    }
    let hash = hash_password(&body.password, app.settings.bcrypt_cost).await?;
    let _guard = app.write.lock().await;
    let user_id = match db::insert_user(
        &app.db,
        &body.username,
        &hash,
        role,
        download,
        share,
        body.access_key_id.as_deref(),
    )
    .await
    {
        Ok(id) => id,
        Err(error) if is_unique(&error) => {
            record(
                &app,
                &current.user.username,
                &current.ip,
                "error",
                "username_taken",
                "POST",
                "/api/users",
                &body.username,
                409,
            )
            .await?;
            return Err(ApiError::conflict(
                "username_taken",
                "Username is already in use",
            ));
        }
        Err(_) => return Err(ApiError::internal()),
    };
    let user = db::find_user_by_id(&app.db, user_id)
        .await
        .map_err(|_| ApiError::internal())?
        .ok_or_else(ApiError::internal)?;
    record(
        &app,
        &current.user.username,
        &current.ip,
        "success",
        "user_created",
        "POST",
        "/api/users",
        &user.username,
        201,
    )
    .await?;
    let created_at = stored_created_at(&app.db, user.id).await?;
    Ok((StatusCode::CREATED, Json(public_user(&user, created_at))).into_response())
}

pub(crate) async fn patch_user(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<i64>,
    Json(body): Json<UserPatch>,
) -> Result<Json<Value>, ApiError> {
    if let Err(error) = require(&current.user, Op::ManageUsers) {
        let target = id.to_string();
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "PATCH",
            "/api/users",
            &target,
            403,
        )
        .await?;
        return Err(error);
    }
    let _guard = app.write.lock().await;
    let target = match load_user(&app, id).await {
        Ok(user) => user,
        Err(error) => {
            if error.code() == "not_found" {
                let missing = id.to_string();
                record(
                    &app,
                    &current.user.username,
                    &current.ip,
                    "error",
                    "not_found",
                    "PATCH",
                    "/api/users",
                    &missing,
                    404,
                )
                .await?;
            }
            return Err(error);
        }
    };
    let role = match body.role.as_deref() {
        Some(role) => match parse_role(role) {
            Ok(role) => role,
            Err(error) => {
                record(
                    &app,
                    &current.user.username,
                    &current.ip,
                    "error",
                    "invalid_role",
                    "PATCH",
                    "/api/users",
                    &target.username,
                    400,
                )
                .await?;
                return Err(error);
            }
        },
        None => target.role.as_str(),
    };
    let download = body.can_download.unwrap_or(target.can_download);
    let share = match resolved_share(download, body.can_share, target.can_share) {
        Ok(share) => share,
        Err(error) => {
            record(
                &app,
                &current.user.username,
                &current.ip,
                "error",
                "share_requires_download",
                "PATCH",
                "/api/users",
                &target.username,
                400,
            )
            .await?;
            return Err(error);
        }
    };
    let disabled = body.disabled.unwrap_or(target.disabled);
    let (download, share) = normalize_bits(role, download, share)?;
    let key = match &body.access_key_id {
        Some(requested) => requested.clone(),
        None => target.access_key_id.clone(),
    };
    let key_changed = key != target.access_key_id;
    if let Some(key) = key.as_deref() {
        let checked = match check_key_shape(role, key) {
            Ok(()) if key_changed => require_garage_key(&app, key).await,
            other => other,
        };
        if let Err(error) = checked {
            return Err(reject(&app, &current, "PATCH", &target.username, error).await);
        }
    }
    if target.id == current.user.id && (disabled || role != current.user.role) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "error",
            "cannot_lock_self",
            "PATCH",
            "/api/users",
            &target.username,
            400,
        )
        .await?;
        return Err(ApiError::bad_request(
            "cannot_lock_self",
            "You cannot disable or demote yourself",
        ));
    }
    let admins = db::count_enabled_admins(&app.db)
        .await
        .map_err(|_| ApiError::internal())?;
    if target.is_admin() && !(role == "admin" && !disabled) && admins <= 1 {
        return Err(ApiError::bad_request(
            "last_admin",
            "The last enabled administrator cannot be removed",
        ));
    }
    let role_owned = role.to_string();
    db::update_user(
        &app.db,
        target.id,
        &role_owned,
        download,
        share,
        disabled,
        key.as_deref(),
        None,
    )
    .await
    .map_err(|_| ApiError::internal())?;
    if target.can_download && !download {
        db::delete_unused_zip(&app.db, target.id)
            .await
            .map_err(|_| ApiError::internal())?;
    }
    if disabled || role_owned != target.role || key_changed {
        db::delete_user_sessions(&app.db, target.id)
            .await
            .map_err(|_| ApiError::internal())?;
    }
    let updated = load_user(&app, id).await?;
    record(
        &app,
        &current.user.username,
        &current.ip,
        "success",
        "user_updated",
        "PATCH",
        "/api/users",
        &updated.username,
        200,
    )
    .await?;
    let created_at = stored_created_at(&app.db, updated.id).await?;
    Ok(Json(public_user(&updated, created_at)))
}

pub(crate) async fn remove_user(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    if let Err(error) = require(&current.user, Op::ManageUsers) {
        let target = id.to_string();
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "DELETE",
            "/api/users",
            &target,
            403,
        )
        .await?;
        return Err(error);
    }
    let _guard = app.write.lock().await;
    let target = match load_user(&app, id).await {
        Ok(user) => user,
        Err(error) => {
            if error.code() == "not_found" {
                let missing = id.to_string();
                record(
                    &app,
                    &current.user.username,
                    &current.ip,
                    "error",
                    "not_found",
                    "DELETE",
                    "/api/users",
                    &missing,
                    404,
                )
                .await?;
            }
            return Err(error);
        }
    };
    if target.id == current.user.id {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "error",
            "cannot_lock_self",
            "DELETE",
            "/api/users",
            &target.username,
            400,
        )
        .await?;
        return Err(ApiError::bad_request(
            "cannot_lock_self",
            "You cannot delete yourself",
        ));
    }
    let admins = db::count_enabled_admins(&app.db)
        .await
        .map_err(|_| ApiError::internal())?;
    if target.is_admin() && admins <= 1 {
        return Err(ApiError::bad_request(
            "last_admin",
            "The last enabled administrator cannot be removed",
        ));
    }
    db::delete_user(&app.db, target.id)
        .await
        .map_err(|_| ApiError::internal())?;
    record(
        &app,
        &current.user.username,
        &current.ip,
        "success",
        "user_deleted",
        "DELETE",
        "/api/users",
        &target.username,
        204,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn reset_password(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<i64>,
    Json(body): Json<ResetBody>,
) -> Result<StatusCode, ApiError> {
    if let Err(error) = require(&current.user, Op::ManageUsers) {
        let target = id.to_string();
        record(
            &app,
            &current.user.username,
            &current.ip,
            "denied",
            "forbidden",
            "POST",
            "/api/users/reset-password",
            &target,
            403,
        )
        .await?;
        return Err(error);
    }
    let target = match load_user(&app, id).await {
        Ok(user) => user,
        Err(error) => {
            if error.code() == "not_found" {
                let missing = id.to_string();
                record(
                    &app,
                    &current.user.username,
                    &current.ip,
                    "error",
                    "not_found",
                    "POST",
                    "/api/users/reset-password",
                    &missing,
                    404,
                )
                .await?;
            }
            return Err(error);
        }
    };
    if target.id == current.user.id {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "error",
            "cannot_reset_self",
            "POST",
            "/api/users/reset-password",
            &target.username,
            400,
        )
        .await?;
        return Err(ApiError::bad_request(
            "cannot_reset_self",
            "Use change-password for your own password",
        ));
    }
    if let Err(error) = validate_password(&body.password) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "error",
            "password_invalid",
            "POST",
            "/api/users/reset-password",
            &target.username,
            400,
        )
        .await?;
        return Err(error);
    }
    let hash = hash_password(&body.password, app.settings.bcrypt_cost).await?;
    let _guard = app.write.lock().await;
    if !db::reset_user_password(&app.db, target.id, &hash)
        .await
        .map_err(|_| ApiError::internal())?
    {
        return Err(ApiError::not_found());
    }
    record(
        &app,
        &current.user.username,
        &current.ip,
        "success",
        "password_reset",
        "POST",
        "/api/users/reset-password",
        &target.username,
        204,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn load_user(app: &App, id: i64) -> Result<User, ApiError> {
    db::find_user_by_id(&app.db, id)
        .await
        .map_err(|_| ApiError::internal())?
        .ok_or_else(ApiError::not_found)
}

fn public_user(user: &User, created_at: i64) -> Value {
    json!({
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "can_download": user.can_download,
        "can_share": user.can_share,
        "disabled": user.disabled,
        "access_key_id": user.access_key_id,
        "created_at": created_at,
    })
}

async fn stored_created_at(pool: &sqlx::SqlitePool, id: i64) -> Result<i64, ApiError> {
    let rows = db::list_user_created_at(pool)
        .await
        .map_err(|_| ApiError::internal())?;
    rows.into_iter()
        .find(|row| row.id == id)
        .map(|row| row.created_at)
        .ok_or_else(ApiError::internal)
}

fn parse_role(role: &str) -> Result<&str, ApiError> {
    match role {
        "admin" | "viewer" => Ok(role),
        _ => Err(ApiError::bad_request("invalid_role", "Role is invalid")),
    }
}

// A bound key must be a plausible Garage key ID and belong to a viewer (docs/security.md 3.20).
fn check_key_shape(role: &str, key: &str) -> Result<(), ApiError> {
    if key.is_empty() || key.len() > MAX_KEY_ID_LEN || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(ApiError::bad_request(
            "invalid_access_key_id",
            "Access key ID is invalid",
        ));
    }
    if role == "admin" {
        return Err(ApiError::bad_request(
            "tenant_admin",
            "An administrator cannot be bound to an access key",
        ));
    }
    Ok(())
}

async fn require_garage_key(app: &App, key: &str) -> Result<(), ApiError> {
    let status = proxy::fetch_key_info(app, key).await?.status();
    if status == StatusCode::NOT_FOUND {
        return Err(ApiError::bad_request(
            "key_not_found",
            "Garage has no such access key",
        ));
    }
    if !status.is_success() {
        return Err(ApiError::unavailable(
            "garage_unavailable",
            "Garage is unavailable",
        ));
    }
    Ok(())
}

async fn reject(
    app: &App,
    current: &Current,
    method: &str,
    target: &str,
    error: ApiError,
) -> ApiError {
    let status = i64::from(error.status_code().as_u16());
    match record(
        app,
        &current.user.username,
        &current.ip,
        "error",
        error.code(),
        method,
        "/api/users",
        target,
        status,
    )
    .await
    {
        Ok(()) => error,
        Err(failed) => failed,
    }
}

fn resolved_share(download: bool, requested: Option<bool>, stored: bool) -> Result<bool, ApiError> {
    if download {
        return Ok(requested.unwrap_or(stored));
    }
    // 没有下载权时分享位必须关掉。显式同时要求分享才是 400。
    if requested == Some(true) {
        return Err(ApiError::bad_request(
            "share_requires_download",
            "Share requires download",
        ));
    }
    Ok(false)
}

fn normalize_bits(role: &str, download: bool, share: bool) -> Result<(bool, bool), ApiError> {
    if role == "admin" {
        return Ok((false, false));
    }
    if share && !download {
        return Err(ApiError::bad_request(
            "share_requires_download",
            "Share requires download",
        ));
    }
    Ok((download, share))
}

fn is_unique(error: &sqlx::Error) -> bool {
    error.to_string().contains("UNIQUE")
}

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", patch(patch_user).delete(remove_user))
        .route("/api/users/{id}/reset-password", post(reset_password))
}
