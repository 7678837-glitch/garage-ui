use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};
use crate::db::{self, User};
use crate::error::ApiError;
use crate::password;
use crate::proxy;
use crate::session::{
    self, apply_login_cookies, clear_cookies, cookie,
};
use crate::state::App;
use crate::version;
use super::Authed;
use super::ClientIp;
use super::hash_password;
use super::record;
use super::validate_password;
use super::validate_username;
use axum::Router;
use axum::routing::{get, post};

#[derive(Deserialize)]
pub(crate) struct Credentials {
    username: String,
    password: String,
}

#[derive(Deserialize)]
pub(crate) struct PasswordChange {
    current_password: String,
    new_password: String,
}

#[derive(Serialize)]
pub(crate) struct PublicConfig {
    s3_region: String,
    website_root_domain: String,
    share_enabled: bool,
    version: String,
}

pub(crate) async fn setup(
    State(app): State<App>,
    ip: ClientIp,
    Json(body): Json<Credentials>,
) -> Result<Response, ApiError> {
    if let Err(wait) = app.limits.init(&ip.0) {
        record(
            &app,
            &body.username,
            &ip.0,
            "rate_limited",
            "rate_limited",
            "POST",
            "/api/setup",
            "",
            429,
        )
        .await?;
        return Err(ApiError::rate_limited(wait.as_secs()));
    }
    let _guard = app.write.lock().await;
    if db::count_users(&app.db)
        .await
        .map_err(|_| ApiError::internal())?
        > 0
    {
        record(
            &app,
            &body.username,
            &ip.0,
            "error",
            "already_initialized",
            "POST",
            "/api/setup",
            "",
            409,
        )
        .await?;
        return Err(ApiError::conflict(
            "already_initialized",
            "Setup is already complete",
        ));
    }
    if let Err(error) = validate_username(&body.username) {
        record(
            &app,
            &body.username,
            &ip.0,
            "error",
            "invalid_username",
            "POST",
            "/api/setup",
            "",
            400,
        )
        .await?;
        return Err(error);
    }
    if let Err(error) = validate_password(&body.password) {
        record(
            &app,
            &body.username,
            &ip.0,
            "error",
            "password_invalid",
            "POST",
            "/api/setup",
            "",
            400,
        )
        .await?;
        return Err(error);
    }
    let hash = hash_password(&body.password, app.settings.bcrypt_cost).await?;
    let user_id = db::insert_user(&app.db, &body.username, &hash, "admin", false, false)
        .await
        .map_err(|_| ApiError::internal())?;
    let user = db::find_user_by_id(&app.db, user_id)
        .await
        .map_err(|_| ApiError::internal())?
        .ok_or_else(ApiError::internal)?;
    let response = login_response(&app, &user, None).await?;
    record(
        &app,
        &user.username,
        &ip.0,
        "success",
        "setup",
        "POST",
        "/api/setup",
        "",
        200,
    )
    .await?;
    Ok(response)
}

pub(crate) async fn login(
    State(app): State<App>,
    ip: ClientIp,
    headers: HeaderMap,
    Json(body): Json<Credentials>,
) -> Result<Response, ApiError> {
    if let Err(wait) = app.limits.login(&ip.0, &body.username) {
        record(
            &app,
            &body.username,
            &ip.0,
            "rate_limited",
            "rate_limited",
            "POST",
            "/api/auth/login",
            "",
            429,
        )
        .await?;
        return Err(ApiError::rate_limited(wait.as_secs()));
    }
    let found = db::find_user_by_name(&app.db, &body.username)
        .await
        .map_err(|_| ApiError::internal())?;
    let hash = found
        .as_ref()
        .map(|user| user.password_hash.clone())
        .unwrap_or_else(|| (*app.dummy_hash).clone());
    let matches = password::verify_async(body.password, hash).await;
    let user = found.filter(|user| !user.disabled);
    if !matches || user.is_none() {
        record(
            &app,
            &body.username,
            &ip.0,
            "failure",
            "invalid_credentials",
            "POST",
            "/api/auth/login",
            "",
            401,
        )
        .await?;
        return Err(ApiError::invalid_credentials());
    }
    let user = user.ok_or_else(ApiError::invalid_credentials)?;
    let presented = cookie(&headers, "garage_session");
    let response = login_response(&app, &user, presented).await?;
    record(
        &app,
        &user.username,
        &ip.0,
        "success",
        "login",
        "POST",
        "/api/auth/login",
        "",
        200,
    )
    .await?;
    Ok(response)
}

pub(crate) async fn logout(State(app): State<App>, Authed(current): Authed) -> Result<Response, ApiError> {
    db::delete_session(&app.db, &current.session_id)
        .await
        .map_err(|_| ApiError::internal())?;
    record(
        &app,
        &current.user.username,
        &current.ip,
        "success",
        "logout",
        "POST",
        "/api/auth/logout",
        "",
        204,
    )
    .await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    clear_cookies(response.headers_mut(), &app.settings);
    Ok(response)
}

pub(crate) async fn change_password(
    State(app): State<App>,
    Authed(current): Authed,
    Json(body): Json<PasswordChange>,
) -> Result<Response, ApiError> {
    if let Err(wait) = app.limits.password(&current.user.username) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "rate_limited",
            "rate_limited",
            "POST",
            "/api/auth/change-password",
            "",
            429,
        )
        .await?;
        return Err(ApiError::rate_limited(wait.as_secs()));
    }
    if let Err(error) = validate_password(&body.new_password) {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "error",
            "password_invalid",
            "POST",
            "/api/auth/change-password",
            "",
            400,
        )
        .await?;
        return Err(error);
    }
    let matches =
        password::verify_async(body.current_password, current.user.password_hash.clone()).await;
    if !matches {
        record(
            &app,
            &current.user.username,
            &current.ip,
            "failure",
            "invalid_credentials",
            "POST",
            "/api/auth/change-password",
            "",
            401,
        )
        .await?;
        return Err(ApiError::invalid_credentials());
    }
    let hash = hash_password(&body.new_password, app.settings.bcrypt_cost).await?;
    let _guard = app.write.lock().await;
    db::update_user(
        &app.db,
        current.user.id,
        &current.user.role,
        current.user.can_download,
        current.user.can_share,
        current.user.disabled,
        Some(&hash),
    )
    .await
    .map_err(|_| ApiError::internal())?;
    db::delete_other_sessions(&app.db, current.user.id, &current.session_id)
        .await
        .map_err(|_| ApiError::internal())?;
    let response = login_response(&app, &current.user, Some(&current.session_id)).await?;
    record(
        &app,
        &current.user.username,
        &current.ip,
        "success",
        "password_changed",
        "POST",
        "/api/auth/change-password",
        "",
        200,
    )
    .await?;
    Ok(response)
}

pub(crate) async fn status(
    State(app): State<App>,
    headers: HeaderMap,
    ip: ClientIp,
) -> Result<Json<Value>, ApiError> {
    let initialized = db::count_users(&app.db)
        .await
        .map_err(|_| ApiError::internal())?
        > 0;
    let current = if initialized {
        session::authenticate(&app, &headers, &ip.0).await.ok()
    } else {
        None
    };
    let authenticated = current.is_some();
    let (garage_version, garage_write_blocked) = if authenticated {
        let link = proxy::ensure_garage_link(&app).await;
        (link.version, !link.writes_allowed)
    } else {
        (None, false)
    };
    Ok(Json(json!({
        "initialized": initialized,
        "authenticated": authenticated,
        "username": current.as_ref().map(|item| item.user.username.clone()),
        "role": current.as_ref().map(|item| item.user.role.clone()),
        "can_download": current.as_ref().map(|item| item.user.actor().download),
        "can_share": current.as_ref().map(|item| effective_share(&item.user)),
        "garage_version": garage_version,
        "garage_write_blocked": garage_write_blocked,
        "tls_insecure": app.settings.tls_insecure,
    })))
}

pub(crate) async fn public_config(State(app): State<App>, Authed(_current): Authed) -> Json<PublicConfig> {
    Json(PublicConfig {
        s3_region: app.settings.s3_region.clone(),
        website_root_domain: app.settings.website_root_domain.clone(),
        share_enabled: app.settings.share_enabled(),
        version: version().to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capabilities {
    version: &'static str,
    list_buckets_info: proxy::Probe,
    list_keys_info: proxy::Probe,
}

pub(crate) async fn capabilities(State(app): State<App>, Authed(_current): Authed) -> Json<Capabilities> {
    let probes = proxy::list_probes(app.settings.garage_admin_url.as_deref());
    Json(Capabilities {
        version: version(),
        list_buckets_info: probes.buckets,
        list_keys_info: probes.keys,
    })
}

async fn login_response(
    app: &App,
    user: &User,
    replace: Option<&str>,
) -> Result<Response, ApiError> {
    let (id, csrf, ttl) = session::issue_session(app, user.id, replace).await?;
    let mut response = Json(json!({
        "username": user.username,
        "role": user.role,
        "can_download": user.actor().download,
        "can_share": effective_share(user),
    }))
    .into_response();
    apply_login_cookies(response.headers_mut(), &app.settings, &id, &csrf, ttl);
    Ok(response)
}

fn effective_share(user: &User) -> bool {
    user.role == "admin" || (user.can_share && user.can_download)
}

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route("/api/setup", post(setup))
        .route("/api/auth/status", get(status))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/change-password", post(change_password))
        .route("/api/config", get(public_config))
        .route("/api/capabilities", get(capabilities))
}
