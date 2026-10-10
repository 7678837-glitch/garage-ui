use std::net::SocketAddr;

use axum::extract::connect_info::ConnectInfo;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, request::Parts};

use crate::config::Settings;
use crate::db::{self, User};
use crate::error::ApiError;
use crate::state::App;
use crate::util::{ct_eq, hex_encode, now_secs, random_bytes};

pub const CSRF_EXEMPT: &[(&str, &str)] = &[("POST", "/api/setup"), ("POST", "/api/auth/login")];

#[derive(Clone, Debug)]
pub struct Current {
    pub session_id: String,
    pub user: User,
    pub csrf_token: String,
    pub ip: String,
}

pub fn csrf_exempt(method: &Method, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path).trim_end_matches('/');
    CSRF_EXEMPT.iter().any(|(allowed_method, route)| {
        *allowed_method == method.as_str() && (path == *route || path.ends_with(route))
    })
}

pub fn client_ip(parts: &Parts, trusted_proxy: bool) -> String {
    if trusted_proxy
        && let Some(hop) = parts
            .headers
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
    parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip().to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

pub fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let header = headers.get("cookie")?.to_str().ok()?;
    header.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name).then_some(value)
    })
}

pub async fn authenticate(app: &App, headers: &HeaderMap, ip: &str) -> Result<Current, ApiError> {
    let Some(session_id) = cookie(headers, "garage_session") else {
        return Err(ApiError::unauthorized());
    };
    let Some(session) = db::load_session(&app.db, session_id)
        .await
        .map_err(|_| ApiError::internal())?
    else {
        return Err(ApiError::unauthorized());
    };
    let now = now_secs();
    let idle = i64::try_from(app.settings.session_idle.as_secs()).unwrap_or(i64::MAX);
    let expired = now >= session.expires_at || now.saturating_sub(session.last_seen_at) > idle;
    if expired || session.key_id != *app.key_id {
        let _ = db::delete_session(&app.db, &session.id).await;
        return Err(ApiError::unauthorized());
    }
    db::touch_session(&app.db, &session.id, now)
        .await
        .map_err(|_| ApiError::internal())?;
    let Some(user) = db::find_user_by_id(&app.db, session.user_id)
        .await
        .map_err(|_| ApiError::internal())?
    else {
        return Err(ApiError::unauthorized());
    };
    if user.disabled {
        let _ = db::delete_user_sessions(&app.db, user.id).await;
        return Err(ApiError::unauthorized());
    }
    Ok(Current {
        session_id: session.id,
        csrf_token: session.csrf_token,
        user,
        ip: ip.to_string(),
    })
}

pub async fn issue_session(
    app: &App,
    user_id: i64,
    replace_id: Option<&str>,
) -> Result<(String, String, u64), ApiError> {
    if let Some(old) = replace_id {
        db::delete_session(&app.db, old)
            .await
            .map_err(|_| ApiError::internal())?;
    }
    let id = hex_encode(&random_bytes(32).map_err(|_| ApiError::internal())?);
    let csrf = hex_encode(&random_bytes(32).map_err(|_| ApiError::internal())?);
    let now = now_secs();
    let ttl = app.settings.session_absolute.as_secs();
    let expires = now.saturating_add(i64::try_from(ttl).unwrap_or(i64::MAX));
    db::insert_session(&app.db, &id, user_id, &csrf, &app.key_id, now, expires)
        .await
        .map_err(|_| ApiError::internal())?;
    Ok((id, csrf, ttl))
}

pub fn apply_login_cookies(
    headers: &mut HeaderMap,
    settings: &Settings,
    session_id: &str,
    csrf: &str,
    max_age: u64,
) {
    append_cookie(
        headers,
        "garage_session",
        session_id,
        settings,
        true,
        max_age,
    );
    append_cookie(headers, "garage_csrf", csrf, settings, false, max_age);
}

pub fn clear_cookies(headers: &mut HeaderMap, settings: &Settings) {
    append_cookie(headers, "garage_session", "", settings, true, 0);
    append_cookie(headers, "garage_csrf", "", settings, false, 0);
}

fn append_cookie(
    headers: &mut HeaderMap,
    name: &str,
    value: &str,
    settings: &Settings,
    http_only: bool,
    max_age: u64,
) {
    let mut text = format!(
        "{name}={value}; Path={}; Max-Age={max_age}; SameSite=Lax",
        settings.cookie_path
    );
    if http_only {
        text.push_str("; HttpOnly");
    }
    if settings.cookie_secure {
        text.push_str("; Secure");
    }
    if let Ok(value) = HeaderValue::from_str(&text) {
        headers.append(HeaderName::from_static("set-cookie"), value);
    }
}

pub fn csrf_matches(header: &str, stored: &str) -> bool {
    ct_eq(header, stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csrf_exempt_list_is_only_setup_and_login() {
        assert_eq!(
            CSRF_EXEMPT,
            [("POST", "/api/setup"), ("POST", "/api/auth/login")]
        );
        assert!(csrf_exempt(&Method::POST, "/api/setup"));
        assert!(csrf_exempt(&Method::POST, "/console/api/auth/login"));
        assert!(!csrf_exempt(&Method::POST, "/api/auth/logout"));
        assert!(!csrf_exempt(&Method::POST, "/api/auth/change-password"));
        assert!(!csrf_exempt(&Method::PUT, "/api/setup"));
        assert!(!csrf_exempt(&Method::POST, "/api/users"));
        assert!(!csrf_exempt(&Method::GET, "/api/auth/login"));
    }
}
