use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Json;
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::access::Op;
use crate::error::ApiError;
use crate::state::App;

use super::percent_encode;
use super::post_garage;
use super::require;
use super::Authed;

#[derive(Deserialize)]
struct WorkerListQuery {
    busy: Option<String>,
    errors: Option<String>,
}

#[derive(Serialize)]
struct ListWorkersBody {
    #[serde(rename = "busyOnly", skip_serializing_if = "is_false")]
    busy_only: bool,
    #[serde(rename = "errorOnly", skip_serializing_if = "is_false")]
    error_only: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn flag_enabled(value: Option<&str>) -> Result<bool, ApiError> {
    match value {
        None => Ok(false),
        Some("1") => Ok(true),
        Some(_) => Err(ApiError::bad_request(
            "invalid_filter",
            "busy and errors must be 1",
        )),
    }
}

fn list_workers_body(query: &WorkerListQuery) -> Result<Vec<u8>, ApiError> {
    let body = ListWorkersBody {
        busy_only: flag_enabled(query.busy.as_deref())?,
        error_only: flag_enabled(query.errors.as_deref())?,
    };
    serde_json::to_vec(&body).map_err(|_| ApiError::internal())
}

pub(crate) async fn list_workers(
    State(app): State<App>,
    Authed(current): Authed,
    Path(id): Path<String>,
    Query(query): Query<WorkerListQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewOps)?;
    let payload = list_workers_body(&query)?;
    let node = format!("node={}", percent_encode(&id));
    let posted = post_garage(
        &app,
        &current,
        &headers,
        "ListWorkers",
        Some(&node),
        &payload,
    )
    .await?;
    node_body(&app, posted, &id).await
}

pub(crate) async fn get_worker(
    State(app): State<App>,
    Authed(current): Authed,
    Path((id, wid)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require(&current.user, Op::ViewOps)?;
    let worker_id = match wid.parse::<i64>() {
        Ok(worker_id) if worker_id >= 0 => worker_id,
        _ => {
            return Err(ApiError::bad_request(
                "invalid_worker",
                "Worker id must be a non-negative integer",
            ));
        }
    };
    let payload =
        serde_json::to_vec(&json!({ "id": worker_id })).map_err(|_| ApiError::internal())?;
    let query = format!("node={}", percent_encode(&id));
    let posted = post_garage(
        &app,
        &current,
        &headers,
        "GetWorkerInfo",
        Some(&query),
        &payload,
    )
    .await?;
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
    if id == "*" {
        let Some(success) = value.get("success") else {
            return Err(ApiError::internal());
        };
        return Ok(Json(success.clone()).into_response());
    }
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
    Router::new()
        .route("/api/nodes/{id}/workers", get(list_workers))
        .route("/api/nodes/{id}/workers/{wid}", get(get_worker))
}
