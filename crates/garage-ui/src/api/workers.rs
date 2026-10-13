use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};

use crate::access::Op;
use crate::error::ApiError;
use crate::state::App;

use super::Authed;
use super::percent_encode;
use super::post_garage;
use super::require;

pub(crate) async fn list_workers(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewOps)?;
    let query = format!("node={}", percent_encode(&id));
    let posted = post_garage(&app, &current, &headers, "ListWorkers", Some(&query), b"{}").await?;
    node_body(&app, posted, &id).await
}

async fn node_body(app: &App, response: Response, id: &str) -> Result<Response, ApiError> {
    if !response.status().is_success() {
        return Ok(response);
    }
    let bytes = axum::body::to_bytes(response.into_body(), app.settings.json_body_limit)
        .await
        .map_err(|_| ApiError::internal())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::internal())?;
    if let Some(node) = value
        .get("success")
        .and_then(Value::as_object)
        .and_then(|nodes| nodes.get(id))
    {
        return Ok(Json(node.clone()).into_response());
    }
    if let Some(message) = value
        .get("error")
        .and_then(Value::as_object)
        .and_then(|nodes| nodes.get(id))
        .and_then(Value::as_str)
    {
        return Ok((
            StatusCode::BAD_GATEWAY,
            Json(json!({ "code": "garage_error", "message": message })),
        )
            .into_response());
    }
    Err(ApiError::internal())
}

pub(crate) fn routes() -> Router<App> {
    Router::new().route("/api/nodes/{id}/workers", get(list_workers))
}
