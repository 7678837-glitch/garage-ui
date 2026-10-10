use axum::body::Body;
use axum::http::{HeaderMap, Method, Response, StatusCode};

use crate::access::{self, Op};
use crate::db::{self, AuditEvent, User};
use crate::error::ApiError;
use crate::state::App;

#[derive(Clone, Copy, Debug)]
pub struct Endpoint {
    pub name: &'static str,
    pub method: &'static str,
    pub op: Op,
    pub confirm: bool,
    pub audit: bool,
}

const fn ep(
    name: &'static str,
    method: &'static str,
    op: Op,
    confirm: bool,
    audit: bool,
) -> Endpoint {
    Endpoint {
        name,
        method,
        op,
        confirm,
        audit,
    }
}

pub fn endpoints() -> &'static [Endpoint] {
    &ENDPOINTS
}

pub fn find_endpoint(name: &str, method: &str) -> Option<&'static Endpoint> {
    endpoints()
        .iter()
        .find(|endpoint| endpoint.name == name && endpoint.method == method)
}

pub fn endpoint_name(path: &str) -> Option<&str> {
    let path = path.trim_matches('/');
    if path == "health" || path == "metrics" {
        return Some(path);
    }
    let rest = path.strip_prefix("v2/")?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest)
}

pub fn forwarded_query(name: &str, raw: Option<&str>) -> String {
    let Some(raw) = raw.filter(|query| !query.is_empty()) else {
        return String::new();
    };
    if name != "GetKeyInfo" {
        return raw.to_string();
    }
    raw.split('&')
        .filter(|pair| {
            let key = pair.split('=').next().unwrap_or("").to_ascii_lowercase();
            key == "id" || key == "search"
        })
        .collect::<Vec<_>>()
        .join("&")
}

pub fn confirmed(headers: &HeaderMap) -> bool {
    headers
        .get("x-confirm")
        .and_then(|value| value.to_str().ok())
        == Some("yes")
}

// 转发需要身份、方法和上游请求材料，少一项就组不出请求。
#[allow(clippy::too_many_arguments)]
pub async fn dispatch(
    app: &App,
    user: &User,
    ip: &str,
    method: &Method,
    path: &str,
    query: Option<&str>,
    body: &[u8],
    headers: &HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let Some(name) = endpoint_name(path) else {
        return Err(ApiError::not_found());
    };
    let Some(endpoint) = find_endpoint(name, method.as_str()) else {
        return Err(ApiError::not_found());
    };
    if !access::permits(user.actor(), endpoint.op) {
        audit(
            app,
            user,
            ip,
            "denied",
            "forbidden",
            method.as_str(),
            path,
            name,
            403,
        )
        .await?;
        return Err(ApiError::forbidden("forbidden", "Not allowed"));
    }
    if endpoint.confirm && !confirmed(headers) {
        return Err(ApiError::forbidden(
            "confirmation_required",
            "Confirmation required",
        ));
    }
    let filtered = forwarded_query(name, query);
    let response = send(app, name, method, &filtered, body).await?;
    if endpoint.audit {
        let status = i64::from(response.status().as_u16());
        audit(
            app,
            user,
            ip,
            "success",
            "ok",
            method.as_str(),
            path,
            name,
            status,
        )
        .await?;
    }
    Ok(response)
}

pub async fn fetch_key_secret(app: &App, id: &str) -> Result<Response<Body>, ApiError> {
    let query = format!("id={}&showSecretKey=true", percent_encode(id));
    send(app, "GetKeyInfo", &Method::GET, &query, &[]).await
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

async fn send(
    app: &App,
    name: &str,
    method: &Method,
    query: &str,
    body: &[u8],
) -> Result<Response<Body>, ApiError> {
    let Some(base) = app.settings.garage_admin_url.clone() else {
        return Err(ApiError::unavailable(
            "garage_unavailable",
            "Garage admin API is not configured",
        ));
    };
    let token = match name {
        "health" => None,
        "metrics" => Some(app.settings.metrics_token.clone().ok_or_else(|| {
            ApiError::unavailable("garage_unavailable", "Garage admin API is not configured")
        })?),
        _ => Some(app.settings.garage_admin_token.clone().ok_or_else(|| {
            ApiError::unavailable("garage_unavailable", "Garage admin API is not configured")
        })?),
    };
    let url = upstream_url(&base, name, query);
    let reqwest_method = reqwest::Method::from_bytes(method.as_str().as_bytes())
        .map_err(|_| ApiError::not_found())?;
    let mut request = app.http.request(reqwest_method, &url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if !body.is_empty() {
        request = request.body(body.to_vec());
    }
    let upstream = request.send().await.map_err(|_| {
        ApiError::unavailable("garage_unavailable", "Garage admin API is not reachable")
    })?;
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .cloned();
    let bytes = upstream.bytes().await.map_err(|_| {
        ApiError::unavailable("garage_unavailable", "Garage admin API is not reachable")
    })?;
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    if let Some(content_type) = content_type
        && let Ok(value) = axum::http::HeaderValue::from_bytes(content_type.as_bytes())
    {
        response.headers_mut().insert("content-type", value);
    }
    Ok(response)
}

fn upstream_url(base: &str, name: &str, query: &str) -> String {
    let path = if name == "health" || name == "metrics" {
        format!("{base}/{name}")
    } else {
        format!("{base}/v2/{name}")
    };
    if query.is_empty() {
        path
    } else {
        format!("{path}?{query}")
    }
}

// 参数就是审计表的列。
#[allow(clippy::too_many_arguments)]
pub async fn audit(
    app: &App,
    user: &User,
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
            username: &user.username,
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

static ENDPOINTS: [Endpoint; 50] = [
    ep("health", "GET", Op::ViewCluster, false, false),
    ep("metrics", "GET", Op::ViewMetrics, false, false),
    ep("AddBucketAlias", "POST", Op::ChangeBuckets, false, true),
    ep("AllowBucketKey", "POST", Op::ChangeBucketKeys, false, true),
    ep("ApplyClusterLayout", "POST", Op::ChangeLayout, false, true),
    ep(
        "CleanupIncompleteUploads",
        "POST",
        Op::WriteObjects,
        false,
        true,
    ),
    ep(
        "ClusterLayoutSkipDeadNodes",
        "POST",
        Op::ChangeLayout,
        true,
        true,
    ),
    ep("ConnectClusterNodes", "POST", Op::ChangeLayout, false, true),
    ep("CreateAdminToken", "POST", Op::AdminTokens, true, true),
    ep("CreateBucket", "POST", Op::ChangeBuckets, false, true),
    ep("CreateKey", "POST", Op::ChangeKeys, false, true),
    ep("CreateMetadataSnapshot", "POST", Op::RunOps, false, true),
    ep("DeleteAdminToken", "POST", Op::AdminTokens, false, true),
    ep("DeleteBucket", "POST", Op::ChangeBuckets, false, true),
    ep("DeleteKey", "POST", Op::ChangeKeys, false, true),
    ep("DenyBucketKey", "POST", Op::ChangeBucketKeys, false, true),
    ep("GetAdminTokenInfo", "GET", Op::AdminTokens, false, false),
    ep("GetBlockInfo", "POST", Op::ViewOps, false, false),
    ep("GetBucketInfo", "GET", Op::ViewBuckets, false, false),
    ep("GetClusterHealth", "GET", Op::ViewCluster, false, false),
    ep("GetClusterLayout", "GET", Op::ViewCluster, false, false),
    ep(
        "GetClusterLayoutHistory",
        "GET",
        Op::ViewCluster,
        false,
        false,
    ),
    ep("GetClusterStatistics", "GET", Op::ViewStats, false, false),
    ep("GetClusterStatus", "GET", Op::ViewCluster, false, false),
    ep(
        "GetCurrentAdminTokenInfo",
        "GET",
        Op::AdminTokens,
        false,
        false,
    ),
    ep("GetKeyInfo", "GET", Op::ViewKeys, false, false),
    ep("GetNodeInfo", "GET", Op::ViewCluster, false, false),
    ep("GetNodeStatistics", "GET", Op::ViewStats, false, false),
    ep("GetWorkerInfo", "POST", Op::ViewOps, false, false),
    ep("GetWorkerVariable", "POST", Op::ViewOps, false, false),
    ep("ImportKey", "POST", Op::ChangeKeys, false, true),
    ep("InspectObject", "GET", Op::InspectObject, false, false),
    ep("LaunchRepairOperation", "POST", Op::RunOps, true, true),
    ep("ListAdminTokens", "GET", Op::AdminTokens, false, false),
    ep("ListBlockErrors", "GET", Op::ViewOps, false, false),
    ep("ListBuckets", "GET", Op::ViewBuckets, false, false),
    ep("ListBucketsInfo", "GET", Op::ViewBuckets, false, false),
    ep("ListKeys", "GET", Op::ViewKeys, false, false),
    ep("ListKeysInfo", "GET", Op::ViewKeys, false, false),
    ep("ListWorkers", "POST", Op::ViewOps, false, false),
    ep(
        "PreviewClusterLayoutChanges",
        "POST",
        Op::ChangeLayout,
        false,
        false,
    ),
    ep("PurgeBlocks", "POST", Op::RunOps, true, true),
    ep("RemoveBucketAlias", "POST", Op::ChangeBuckets, false, true),
    ep("RetryBlockResync", "POST", Op::RunOps, false, true),
    ep("RevertClusterLayout", "POST", Op::ChangeLayout, false, true),
    ep("SetWorkerVariable", "POST", Op::RunOps, true, true),
    ep("UpdateAdminToken", "POST", Op::AdminTokens, true, true),
    ep("UpdateBucket", "POST", Op::ChangeBuckets, false, true),
    ep("UpdateClusterLayout", "POST", Op::ChangeLayout, false, true),
    ep("UpdateKey", "POST", Op::ChangeKeys, false, true),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_matches_openapi_methods() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../openapi/garage-admin-v2.json");
        let text = std::fs::read_to_string(path).expect("openapi");
        let spec: serde_json::Value = serde_json::from_str(&text).unwrap();
        let paths = spec["paths"].as_object().unwrap();
        assert!(paths.contains_key("/check"));
        assert!(find_endpoint("check", "GET").is_none());
        for (path, item) in paths {
            if path == "/check" {
                continue;
            }
            let name = path.rsplit('/').next().unwrap();
            for method in ["get", "post", "put", "patch", "delete"] {
                if item.get(method).is_some() {
                    assert!(
                        find_endpoint(name, &method.to_ascii_uppercase()).is_some(),
                        "missing {method} {path}"
                    );
                }
            }
        }
        for endpoint in endpoints() {
            if endpoint.name == "ListBucketsInfo" || endpoint.name == "ListKeysInfo" {
                assert!(find_endpoint(endpoint.name, "GET").is_some());
                continue;
            }
            let path = if endpoint.name == "health" || endpoint.name == "metrics" {
                format!("/{}", endpoint.name)
            } else {
                format!("/v2/{}", endpoint.name)
            };
            let item = paths.get(&path).unwrap_or_else(|| panic!("extra {path}"));
            assert!(
                item.get(endpoint.method.to_ascii_lowercase()).is_some(),
                "{path} {}",
                endpoint.method
            );
        }
    }

    #[test]
    fn get_key_info_drops_show_secret_key() {
        let query = forwarded_query("GetKeyInfo", Some("id=abc&showSecretKey=true&search=k"));
        assert!(query.contains("id=abc"));
        assert!(query.contains("search=k"));
        assert!(!query.to_ascii_lowercase().contains("showsecretkey"));
        assert_eq!(
            forwarded_query("ListKeys", Some("showSecretKey=true")),
            "showSecretKey=true"
        );
    }
}
