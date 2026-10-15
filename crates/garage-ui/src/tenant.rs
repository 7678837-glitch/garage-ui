use axum::http::StatusCode;
use serde::Deserialize;

use crate::db::User;
use crate::error::ApiError;
use crate::proxy;
use crate::state::App;
use crate::state::credentials::BucketCredential;

// A tenant account is a viewer bound to one Garage access key (docs/security.md 3.20).
// The key is read from Garage on every request and is never cached.
pub struct Tenant {
    credential: BucketCredential,
    // IDs of the buckets on which the key holds read, write, or owner. Sorted.
    granted: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyInfo {
    secret_access_key: Option<String>,
    #[serde(default)]
    buckets: Vec<KeyBucket>,
}

#[derive(Deserialize)]
struct KeyBucket {
    id: String,
    #[serde(default)]
    permissions: Permissions,
}

#[derive(Default, Deserialize)]
struct Permissions {
    #[serde(default)]
    read: bool,
    #[serde(default)]
    write: bool,
    #[serde(default)]
    owner: bool,
}

fn key_unavailable() -> ApiError {
    ApiError::forbidden(
        "tenant_key_unavailable",
        "The Garage key bound to this account is unavailable",
    )
}

fn garage_unavailable() -> ApiError {
    ApiError::unavailable("garage_unavailable", "Garage is unavailable")
}

impl Tenant {
    async fn load(app: &App, access_key_id: &str) -> Result<Self, ApiError> {
        let response = proxy::fetch_key_secret(app, access_key_id).await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Err(key_unavailable());
        }
        if !status.is_success() {
            return Err(garage_unavailable());
        }
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .map_err(|_| garage_unavailable())?;
        let info: KeyInfo = serde_json::from_slice(&bytes).map_err(|_| garage_unavailable())?;
        Self::from_info(access_key_id, info)
    }

    fn from_info(access_key_id: &str, info: KeyInfo) -> Result<Self, ApiError> {
        let Some(secret) = info.secret_access_key.filter(|secret| !secret.is_empty()) else {
            return Err(key_unavailable());
        };
        let mut granted: Vec<String> = info
            .buckets
            .into_iter()
            .filter(|bucket| {
                let held = &bucket.permissions;
                held.read || held.write || held.owner
            })
            .map(|bucket| bucket.id)
            .collect();
        granted.sort();
        granted.dedup();
        Ok(Self {
            credential: BucketCredential::new(access_key_id, secret),
            granted,
        })
    }

    // A bucket outside the granted set looks the same as a bucket that does not exist.
    pub fn gate(&self, bucket_id: &str) -> Result<(), ApiError> {
        if self.granted.iter().any(|id| id == bucket_id) {
            Ok(())
        } else {
            Err(ApiError::not_found())
        }
    }

    pub fn granted(&self) -> Vec<String> {
        self.granted.clone()
    }
}

// The loaded key of a tenant, or None for every other account.
pub async fn load_for(app: &App, user: &User) -> Result<Option<Tenant>, ApiError> {
    let Some(access_key_id) = user
        .access_key_id
        .as_deref()
        .filter(|_| user.actor().tenant)
    else {
        return Ok(None);
    };
    Tenant::load(app, access_key_id).await.map(Some)
}

// Gates the bucket for a tenant and returns the credential that signs its S3 requests.
// Callers run this before any S3 or bucket-scoped Admin API request.
pub async fn scope(
    app: &App,
    user: &User,
    bucket_id: &str,
) -> Result<Option<BucketCredential>, ApiError> {
    let Some(tenant) = load_for(app, user).await? else {
        return Ok(None);
    };
    tenant.gate(bucket_id)?;
    Ok(Some(tenant.credential))
}

// Routes a tenant never reaches, whatever the bucket.
pub fn deny(user: &User) -> Result<(), ApiError> {
    if user.actor().tenant {
        Err(ApiError::forbidden("forbidden", "Not allowed"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_admits_only_buckets_on_which_the_key_holds_a_permission() {
        let info: KeyInfo = serde_json::from_value(serde_json::json!({
            "secretAccessKey": "s",
            "buckets": [
                { "id": "b2", "permissions": { "read": true } },
                { "id": "b1", "permissions": { "owner": true } },
                { "id": "b4", "permissions": { "read": false, "write": false, "owner": false } },
                { "id": "b5", "permissions": {} },
            ],
        }))
        .unwrap();
        let tenant = Tenant::from_info("GK1", info).unwrap();
        assert_eq!(tenant.granted(), ["b1", "b2"]);
        assert!(tenant.gate("b1").is_ok());
        assert!(tenant.gate("b2").is_ok());
        for hidden in ["b3", "b4", "b5", ""] {
            assert_eq!(
                tenant.gate(hidden).unwrap_err().status_code(),
                StatusCode::NOT_FOUND,
                "{hidden:?}"
            );
        }
        assert_eq!(tenant.credential.access_key_id(), "GK1");
    }

    #[test]
    fn a_key_without_a_secret_is_unavailable() {
        let info: KeyInfo = serde_json::from_value(serde_json::json!({ "buckets": [] })).unwrap();
        let error = Tenant::from_info("GK1", info).err().unwrap();
        assert_eq!(error.code(), "tenant_key_unavailable");
    }
}
