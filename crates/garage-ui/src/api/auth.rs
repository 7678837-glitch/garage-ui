use super::Authed;
use super::ClientIp;
use super::hash_password;
use super::record;
use super::validate_password;
use super::validate_username;
use crate::db::{self, User};
use crate::error::ApiError;
use crate::password;
use crate::proxy;
use crate::session::{self, apply_login_cookies, clear_cookies, cookie};
use crate::state::App;
use crate::version;
use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};

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
    // No account can hold such a name, so skip the limiter and bcrypt: otherwise a
    // client varying a huge username grows limiter memory and burns CPU for free.
    if validate_username(&body.username).is_err() {
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
    let response = match user.as_ref().filter(|_| matches) {
        Some(user) => login_response(&app, user, cookie(&headers, "garage_session")).await,
        None => Err(ApiError::invalid_credentials()),
    };
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            if error.code() == "invalid_credentials" {
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
            }
            return Err(error);
        }
    };
    let user = user.ok_or_else(ApiError::invalid_credentials)?;
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

pub(crate) async fn logout(
    State(app): State<App>,
    Authed(current): Authed,
) -> Result<Response, ApiError> {
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
    let replacement = session::new_session(&app, current.user.id)?;
    let user = db::change_user_password(
        &app.db,
        current.user.id,
        &current.user.password_hash,
        &current.session_id,
        &hash,
        &replacement,
        i64::try_from(app.settings.session_idle.as_secs()).unwrap_or(i64::MAX),
    )
    .await
    .map_err(|_| ApiError::internal())?;
    let Some(user) = user else {
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
    };
    let mut response = user_response(&user);
    apply_login_cookies(
        response.headers_mut(),
        &app.settings,
        &replacement.id,
        &replacement.csrf_token,
        app.settings.session_absolute.as_secs(),
    );
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

pub(crate) async fn public_config(
    State(app): State<App>,
    Authed(_current): Authed,
) -> Json<PublicConfig> {
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

pub(crate) async fn capabilities(
    State(app): State<App>,
    Authed(_current): Authed,
) -> Json<Capabilities> {
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
    let (session, user) = session::issue_session(app, user, replace).await?;
    let mut response = user_response(&user);
    apply_login_cookies(
        response.headers_mut(),
        &app.settings,
        &session.id,
        &session.csrf_token,
        app.settings.session_absolute.as_secs(),
    );
    Ok(response)
}

fn user_response(user: &User) -> Response {
    Json(json!({
        "username": user.username,
        "role": user.role,
        "can_download": user.actor().download,
        "can_share": effective_share(user),
    }))
    .into_response()
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

#[cfg(test)]
mod login_proof_tests {
    use super::*;

    async fn verified_user(app: &App) -> User {
        let hash = password::hash_async("original password".into(), 4)
            .await
            .unwrap();
        let id = db::insert_user(&app.db, "Original", &hash, "admin", false, false)
            .await
            .unwrap();
        let user = db::find_user_by_id(&app.db, id).await.unwrap().unwrap();
        assert!(
            password::verify_async("original password".into(), user.password_hash.clone()).await
        );
        user
    }

    async fn existing_session(app: &App, user_id: i64) -> db::Session {
        let session = session::new_session(app, user_id).unwrap();
        db::insert_session(
            &app.db,
            &session.id,
            user_id,
            &session.csrf_token,
            &session.key_id,
            session.last_seen_at,
            session.expires_at,
        )
        .await
        .unwrap();
        session
    }

    async fn assert_rejected(app: &App, proof: &User, existing: &db::Session) {
        let response = login_response(app, proof, Some(&existing.id)).await;
        assert!(
            response.is_err(),
            "a stale password proof issued a login response"
        );
        let response = response.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!response.headers().contains_key("set-cookie"));
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["code"],
            "invalid_credentials"
        );
        assert!(
            db::load_session(&app.db, &existing.id)
                .await
                .unwrap()
                .is_some(),
            "rejected proof deleted the presented session"
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(&app.db)
            .await
            .unwrap();
        assert_eq!(count, 1, "rejected proof inserted a session");
    }

    #[tokio::test]
    async fn password_reset_rejects_verified_login_proof_without_rotating_session() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let proof = verified_user(&app).await;
        let hash = password::hash_async("reset password".into(), 4)
            .await
            .unwrap();
        assert!(
            db::reset_user_password(&app.db, proof.id, &hash)
                .await
                .unwrap()
        );
        let existing = existing_session(&app, proof.id).await;
        assert_rejected(&app, &proof, &existing).await;
    }

    #[tokio::test]
    async fn recycled_user_id_rejects_verified_login_proof_without_rotating_session() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let proof = verified_user(&app).await;
        db::delete_user(&app.db, proof.id).await.unwrap();
        // Reusing the same hash isolates identity validation from password validation.
        let id = db::insert_user(
            &app.db,
            "Replacement",
            &proof.password_hash,
            "admin",
            false,
            false,
        )
        .await
        .unwrap();
        assert_eq!(id, proof.id, "SQLite did not recycle the highest user ID");
        let existing = existing_session(&app, id).await;
        assert_rejected(&app, &proof, &existing).await;
    }

    #[tokio::test]
    async fn disabled_user_rejects_verified_login_proof_without_rotating_session() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let proof = verified_user(&app).await;
        db::update_user(&app.db, proof.id, "admin", false, false, true, None)
            .await
            .unwrap();
        let existing = existing_session(&app, proof.id).await;
        assert_rejected(&app, &proof, &existing).await;
    }

    #[tokio::test]
    async fn accepted_login_proof_rotates_session_and_returns_current_permissions() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let proof = verified_user(&app).await;
        let existing = existing_session(&app, proof.id).await;
        db::update_user(&app.db, proof.id, "viewer", true, false, false, None)
            .await
            .unwrap();
        let response = login_response(&app, &proof, Some(&existing.id))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut headers = HeaderMap::new();
        let session_cookie = response
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|value| value.to_str().unwrap())
            .find(|value| value.starts_with("garage_session="))
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        headers.insert("cookie", session_cookie.parse().unwrap());
        let current = session::authenticate(&app, &headers, "127.0.0.1")
            .await
            .unwrap();
        assert_eq!(current.user.id, proof.id);
        assert_eq!(current.user.role, "viewer");
        assert!(current.user.can_download);
        assert!(!current.user.can_share);
        assert!(
            db::load_session(&app.db, &existing.id)
                .await
                .unwrap()
                .is_none()
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["role"], "viewer");
        assert_eq!(body["can_download"], true);
        assert_eq!(body["can_share"], false);
    }
}
