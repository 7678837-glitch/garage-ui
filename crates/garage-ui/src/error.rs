use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug)]
enum Kind {
    Local {
        code: &'static str,
        message: &'static str,
        retry_after: Option<u64>,
    },
    Upstream {
        bytes: Vec<u8>,
        content_type: Option<HeaderValue>,
    },
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    kind: Kind,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            kind: Kind::Local {
                code,
                message,
                retry_after: None,
            },
        }
    }

    pub(crate) fn upstream(
        status: StatusCode,
        bytes: Vec<u8>,
        content_type: Option<HeaderValue>,
    ) -> Self {
        Self {
            status,
            kind: Kind::Upstream {
                bytes,
                content_type,
            },
        }
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        )
    }

    pub fn invalid_credentials() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Invalid credentials",
        )
    }

    pub fn forbidden(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    pub fn bad_request(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "Not found")
    }

    pub fn conflict(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "Internal error",
        )
    }

    pub fn unavailable(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, code, message)
    }

    pub fn not_implemented(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::NOT_IMPLEMENTED, code, message)
    }

    pub fn rate_limited(retry_after_secs: u64) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            kind: Kind::Local {
                code: "rate_limited",
                message: "Too many requests",
                retry_after: Some(retry_after_secs.max(1)),
            },
        }
    }
}

#[derive(Serialize)]
struct Body<'a> {
    code: &'a str,
    message: &'a str,
}

// 规格只要求截断，没有给长度。1024 是约定的字节上限，先切再按 lossy UTF-8 解释。
const UPSTREAM_MESSAGE_BYTES: usize = 1024;

#[derive(Serialize)]
struct UpstreamError<'a> {
    code: &'a str,
    message: &'a str,
    #[serde(rename = "garageStatus")]
    garage_status: u16,
}

pub(crate) fn upstream_error_json(garage_status: u16, raw: &[u8]) -> Vec<u8> {
    let end = raw.len().min(UPSTREAM_MESSAGE_BYTES);
    let message = String::from_utf8_lossy(&raw[..end]);
    serde_json::to_vec(&UpstreamError {
        code: "upstream_error",
        message: &message,
        garage_status,
    })
    .expect("upstream error json")
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self.kind {
            Kind::Local {
                code,
                message,
                retry_after,
            } => {
                let mut response = (self.status, Json(Body { code, message })).into_response();
                if let Some(secs) = retry_after
                    && let Ok(value) = HeaderValue::from_str(&secs.to_string())
                {
                    response.headers_mut().insert("retry-after", value);
                }
                response
            }
            Kind::Upstream {
                bytes,
                content_type,
            } => {
                let mut response = Response::new(axum::body::Body::from(bytes));
                *response.status_mut() = self.status;
                if let Some(value) = content_type {
                    response.headers_mut().insert(header::CONTENT_TYPE, value);
                }
                response
            }
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.kind {
            Kind::Local { code, .. } => f.write_str(code),
            Kind::Upstream { .. } => f.write_str("upstream_error"),
        }
    }
}

impl std::error::Error for ApiError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn api_error_json_is_code_and_message_only() {
        let response = ApiError::forbidden("forbidden", "Not allowed").into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            bytes.as_ref(),
            br#"{"code":"forbidden","message":"Not allowed"}"#
        );
    }
}
