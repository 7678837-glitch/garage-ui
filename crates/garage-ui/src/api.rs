use std::convert::Infallible;

use axum::Json;
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, RawQuery, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, patch, post};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};

use crate::access::{self, Op};
use crate::db::{self, AuditEvent, User};
use crate::error::ApiError;
use crate::password;
use crate::preview::preview_policy;
use crate::proxy::{self, confirmed};
use crate::session::{
    self, Current, apply_login_cookies, clear_cookies, client_ip, cookie, csrf_exempt, csrf_matches,
};
use crate::state::App;
use crate::util::{hex_encode, random_bytes};
use crate::version;

struct Authed(Current);

impl FromRequestParts<App> for Authed {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, ApiError> {
        let ip = client_ip(parts, app.settings.trusted_proxy);
        Ok(Authed(
            session::authenticate(app, &parts.headers, &ip).await?,
        ))
    }
}

struct ClientIp(String);

impl FromRequestParts<App> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, Infallible> {
        Ok(ClientIp(client_ip(parts, app.settings.trusted_proxy)))
    }
}

pub fn routes(app: App) -> Router<App> {
    let json_limit = app.settings.json_body_limit;
    let upload_limit = usize::try_from(app.settings.max_upload_bytes).unwrap_or(usize::MAX);
    let json_routes = Router::new()
        .route("/api/setup", post(setup))
        .route("/api/auth/status", get(status))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/change-password", post(change_password))
        .route("/api/config", get(public_config))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", patch(patch_user).delete(remove_user))
        .route("/api/users/{id}/reset-password", post(reset_password))
        .route("/api/keys", get(list_keys))
        .route("/api/keys/{id}/secret", post(key_secret))
        .route("/api/objects/preview", get(preview_object))
        .route("/api/objects/download", get(download_object))
        .route("/api/objects/thumbnail", get(thumbnail_object))
        .route("/api/zip-tokens", post(create_zip))
        .route("/api/zip-tokens/{id}/consume", post(consume_zip))
        .route("/api/share", post(share))
        .route("/api/garage/{*path}", any(garage))
        .layer(middleware::from_fn_with_state(app.clone(), csrf))
        .layer(DefaultBodyLimit::max(json_limit));
    let upload = Router::new()
        .route("/api/objects", post(upload_object))
        .layer(middleware::from_fn_with_state(app, csrf))
        .layer(DefaultBodyLimit::max(upload_limit));
    json_routes.merge(upload)
}

async fn csrf(State(app): State<App>, request: Request, next: Next) -> Result<Response, ApiError> {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    if matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) || csrf_exempt(&method, &path)
    {
        return Ok(next.run(request).await);
    }
    let headers = request.headers().clone();
    let ip = request_ip(&app, &request);
    let current = session::authenticate(&app, &headers, &ip).await?;
    let header = headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !csrf_matches(header, &current.csrf_token) {
        return Err(ApiError::forbidden(
            "csrf_rejected",
            "CSRF token missing or mismatched",
        ));
    }
    Ok(next.run(request).await)
}

fn request_ip(app: &App, request: &Request) -> String {
    if app.settings.trusted_proxy
        && let Some(hop) = request
            .headers()
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .rfind(|part| !part.is_empty())
            })
    {
        return hop.to_string();
    }
    request
        .extensions()
        .get::<axum::extract::connect_info::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip().to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
}

#[derive(Deserialize)]
struct PasswordChange {
    current_password: String,
    new_password: String,
}

#[derive(Deserialize)]
struct NewUser {
    username: String,
    password: String,
    role: String,
    #[serde(default)]
    can_download: bool,
    #[serde(default)]
    can_share: bool,
}

#[derive(Deserialize)]
struct UserPatch {
    role: Option<String>,
    can_download: Option<bool>,
    can_share: Option<bool>,
    disabled: Option<bool>,
}

#[derive(Deserialize)]
struct ResetBody {
    password: String,
}

#[derive(Deserialize)]
struct NameQuery {
    name: String,
}

#[derive(Deserialize)]
struct ShareBody {
    ttl_seconds: u64,
    bucket: String,
    key: String,
}

#[derive(Serialize)]
struct PublicConfig {
    s3_region: String,
    website_root_domain: String,
    share_enabled: bool,
    version: String,
}

async fn setup(
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
        return Err(ApiError::conflict(
            "already_initialized",
            "Setup is already complete",
        ));
    }
    validate_username(&body.username)?;
    validate_password(&body.password)?;
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

async fn login(
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

async fn logout(State(app): State<App>, Authed(current): Authed) -> Result<Response, ApiError> {
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

async fn change_password(
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
    validate_password(&body.new_password)?;
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

async fn status(
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
    Ok(Json(json!({
        "initialized": initialized,
        "authenticated": authenticated,
        "username": current.as_ref().map(|item| item.user.username.clone()),
        "role": current.as_ref().map(|item| item.user.role.clone()),
        "can_download": current.as_ref().map(|item| item.user.actor().download),
        "can_share": current.as_ref().map(|item| effective_share(&item.user)),
    })))
}

async fn public_config(State(app): State<App>, Authed(_current): Authed) -> Json<PublicConfig> {
    Json(PublicConfig {
        s3_region: app.settings.s3_region.clone(),
        website_root_domain: app.settings.website_root_domain.clone(),
        share_enabled: app.settings.share_enabled(),
        version: version().to_string(),
    })
}

async fn list_users(
    State(app): State<App>,
    Authed(current): Authed,
) -> Result<Json<Value>, ApiError> {
    require(&current.user, Op::ManageUsers)?;
    let users = db::list_users(&app.db)
        .await
        .map_err(|_| ApiError::internal())?;
    Ok(Json(Value::Array(users.iter().map(public_user).collect())))
}

async fn create_user(
    State(app): State<App>,
    Authed(current): Authed,
    Json(body): Json<NewUser>,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ManageUsers)?;
    validate_username(&body.username)?;
    validate_password(&body.password)?;
    let role = parse_role(&body.role)?;
    let (download, share) = normalize_bits(role, body.can_download, body.can_share)?;
    let hash = hash_password(&body.password, app.settings.bcrypt_cost).await?;
    let _guard = app.write.lock().await;
    let user_id = match db::insert_user(&app.db, &body.username, &hash, role, download, share).await
    {
        Ok(id) => id,
        Err(error) if is_unique(&error) => {
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
    Ok((StatusCode::CREATED, Json(public_user(&user))).into_response())
}

async fn patch_user(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<i64>,
    Json(body): Json<UserPatch>,
) -> Result<Json<Value>, ApiError> {
    require(&current.user, Op::ManageUsers)?;
    let _guard = app.write.lock().await;
    let target = load_user(&app, id).await?;
    let role = match body.role.as_deref() {
        Some(role) => parse_role(role)?,
        None => target.role.as_str(),
    };
    let download = body.can_download.unwrap_or(target.can_download);
    let share = resolved_share(download, body.can_share, target.can_share)?;
    let disabled = body.disabled.unwrap_or(target.disabled);
    let (download, share) = normalize_bits(role, download, share)?;
    if target.id == current.user.id && (disabled || role != current.user.role) {
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
        None,
    )
    .await
    .map_err(|_| ApiError::internal())?;
    if target.can_download && !download {
        db::delete_unused_zip(&app.db, target.id)
            .await
            .map_err(|_| ApiError::internal())?;
    }
    if disabled || role_owned != target.role {
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
    Ok(Json(public_user(&updated)))
}

async fn remove_user(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require(&current.user, Op::ManageUsers)?;
    let _guard = app.write.lock().await;
    let target = load_user(&app, id).await?;
    if target.id == current.user.id {
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

async fn reset_password(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<i64>,
    Json(body): Json<ResetBody>,
) -> Result<StatusCode, ApiError> {
    require(&current.user, Op::ManageUsers)?;
    let target = load_user(&app, id).await?;
    if target.id == current.user.id {
        return Err(ApiError::bad_request(
            "cannot_reset_self",
            "Use change-password for your own password",
        ));
    }
    validate_password(&body.password)?;
    let hash = hash_password(&body.password, app.settings.bcrypt_cost).await?;
    let _guard = app.write.lock().await;
    db::update_user(
        &app.db,
        target.id,
        &target.role,
        target.can_download,
        target.can_share,
        target.disabled,
        Some(&hash),
    )
    .await
    .map_err(|_| ApiError::internal())?;
    db::delete_user_sessions(&app.db, target.id)
        .await
        .map_err(|_| ApiError::internal())?;
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

async fn list_keys(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &Method::GET,
        "v2/ListKeys",
        None,
        &[],
        &headers,
    )
    .await
}

async fn key_secret(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewSecret)?;
    if !confirmed(&headers) {
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

async fn preview_object(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<NameQuery>,
) -> Result<Response, ApiError> {
    object_body(&app, &current, &query.name).await
}

async fn download_object(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<NameQuery>,
) -> Result<Response, ApiError> {
    object_body(&app, &current, &query.name).await
}

async fn thumbnail_object(
    State(app): State<App>,
    Authed(current): Authed,
    Query(query): Query<NameQuery>,
) -> Result<Response, ApiError> {
    object_body(&app, &current, &query.name).await
}

async fn object_body(app: &App, current: &Current, name: &str) -> Result<Response, ApiError> {
    require(&current.user, Op::ReadObjects)?;
    let fixtures = app.fixtures.lock().expect("fixtures");
    let Some(fixture) = fixtures.get(name).cloned() else {
        return Err(ApiError::not_found());
    };
    drop(fixtures);
    let policy = preview_policy(&fixture.content_type, &fixture.filename);
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
    if let Some(disposition) = policy.content_disposition
        && let Ok(value) = HeaderValue::from_str(&disposition)
    {
        headers.insert("content-disposition", value);
    }
    Ok(response)
}

async fn create_zip(State(app): State<App>, Authed(current): Authed) -> Result<Response, ApiError> {
    require(&current.user, Op::ReadObjects)?;
    let id = hex_encode(&random_bytes(32).map_err(|_| ApiError::internal())?);
    db::insert_zip(&app.db, &id, current.user.id)
        .await
        .map_err(|_| ApiError::internal())?;
    let mut response = Json(json!({ "id": id })).into_response();
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

async fn consume_zip(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ReadObjects)?;
    let unused = db::zip_unused(&app.db, &id, current.user.id)
        .await
        .map_err(|_| ApiError::internal())?;
    if !unused {
        return Err(ApiError::not_found());
    }
    db::mark_zip_used(&app.db, &id)
        .await
        .map_err(|_| ApiError::internal())?;
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

async fn share(
    State(app): State<App>,
    Authed(current): Authed,
    Json(body): Json<ShareBody>,
) -> Result<Response, ApiError> {
    // 上限现在就截断。链接本身还没做，响应里不放地址。
    let ttl = access::cap_share_ttl(body.ttl_seconds);
    let _request = (ttl, body.bucket, body.key);
    if access::permits(current.user.actor(), Op::Share) {
        if app.settings.share_enabled() {
            return Err(ApiError::not_implemented(
                "share_not_ready",
                "Share links are not available",
            ));
        }
        return Err(ApiError::not_implemented(
            "share_unavailable",
            "Public S3 address is not configured",
        ));
    }
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
    Err(ApiError::forbidden("forbidden", "Not allowed"))
}

async fn upload_object(
    State(app): State<App>,
    Authed(current): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::WriteObjects)?;
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
    if length > app.settings.max_upload_bytes {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Upload is too large",
        ));
    }
    Err(ApiError::not_implemented(
        "not_implemented",
        "Object upload is not available",
    ))
}

async fn garage(
    State(app): State<App>,
    Authed(current): Authed,
    method: Method,
    Path(path): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy::dispatch(
        &app,
        &current.user,
        &current.ip,
        &method,
        &path,
        query.as_deref(),
        &body,
        &headers,
    )
    .await
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

async fn load_user(app: &App, id: i64) -> Result<User, ApiError> {
    db::find_user_by_id(&app.db, id)
        .await
        .map_err(|_| ApiError::internal())?
        .ok_or_else(ApiError::not_found)
}

fn require(user: &User, op: Op) -> Result<(), ApiError> {
    if access::permits(user.actor(), op) {
        Ok(())
    } else {
        Err(ApiError::forbidden("forbidden", "Not allowed"))
    }
}

fn public_user(user: &User) -> Value {
    json!({
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "can_download": user.can_download,
        "can_share": user.can_share,
        "disabled": user.disabled,
    })
}

fn effective_share(user: &User) -> bool {
    user.role == "admin" || (user.can_share && user.can_download)
}

fn validate_username(username: &str) -> Result<(), ApiError> {
    let count = username.chars().count();
    let legal = (1..=64).contains(&count)
        && username
            .chars()
            .all(|ch| !ch.is_control() && ch != ';' && ch != ' ');
    if legal {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "invalid_username",
            "Username is invalid",
        ))
    }
}

fn validate_password(password: &str) -> Result<(), ApiError> {
    password::validate(password).map_err(|_| {
        ApiError::bad_request(
            "password_invalid",
            "Password must be 10 to 72 characters and not blank",
        )
    })
}

fn parse_role(role: &str) -> Result<&str, ApiError> {
    match role {
        "admin" | "viewer" => Ok(role),
        _ => Err(ApiError::bad_request("invalid_role", "Role is invalid")),
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

async fn hash_password(password: &str, cost: u32) -> Result<String, ApiError> {
    password::hash_async(password.to_string(), cost)
        .await
        .map_err(|_| ApiError::internal())
}

fn is_unique(error: &sqlx::Error) -> bool {
    error.to_string().contains("UNIQUE")
}

// 参数就是审计表的列。收成另一个结构和里面的 AuditEvent 重复。
#[allow(clippy::too_many_arguments)]
async fn record(
    app: &App,
    username: &str,
    ip: &str,
    result: &'static str,
    reason: &'static str,
    method: &str,
    path: &str,
    target: &str,
    status: i64,
) -> Result<(), ApiError> {
    db::insert_audit(
        &app.db,
        AuditEvent {
            username,
            ip,
            result,
            reason,
            method,
            path,
            target,
            status,
        },
    )
    .await
    .map_err(|_| ApiError::internal())
}
