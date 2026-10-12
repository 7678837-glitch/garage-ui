# Garage versions and the Admin API

Endpoint names and field names follow the Admin API v2 definition in the Garage source. The path form is `/v2/<endpoint name>`.

## 2.1 Versions

| Item | Requirement |
|---|---|
| Minimum supported | Garage v2.3.0 |
| Recommended version | Garage v2.4.1 (the current latest release) |
| Not supported | v2.2.x and earlier (including v1.x and v0.x). When the startup self-check finds a version that is too old, refuse the connection and prompt to upgrade. |
| Ahead of release | Use unpublished main-v2 list APIs through a capability probe (see 2.3). |
| Example deployment | The docs and the compose example use v2.4.1 by default. |

Version facts already checked against the Garage source:

- v2.3.0 and v2.4.1 have the same set of Admin API paths: 46 endpoints under `/v2`, plus `/health`, `/check`, and `/metrics`. `/check` validates a static-website domain. A reverse proxy uses it before issuing a certificate. It is not a connectivity check.
- v2.3.0 already has: `corsRules`, `lifecycleRules`, `websiteAccess`, and `quotas` on `UpdateBucket`; `GetBucketInfo` returns the fields of the same names; `GetClusterStatistics` and `GetNodeStatistics`; `GetClusterHealth` uses `storageNodesUp`. Implement these features directly on the v2.3.0 baseline. Do not branch by version.
- Present only on v2.4.x (probe by field, and hide the matching display when the field is missing):
  - Structured layout-calculation statistics in the `PreviewClusterLayoutChanges` and `ApplyClusterLayout` responses (`statistics`, including per-node and per-zone statistics). On v2.3.0, show only the text Garage returns.
  - The `addr`, `role`, `draining`, `isUp`, `metadataPartition`, and `dataPartition` fields of `GetNodeInfo`.
- Present only on main-v2 (unpublished): `ListBucketsInfo`, `ListKeysInfo`, and the `offset` and `limit` parameters of `ListBuckets` / `ListKeys`. Also `connectionParameters` on `GetNodeInfo`.

Acceptance:

- Run integration tests against both v2.3.x and v2.4.1. The core flows (log in, list buckets, browse, upload, delete, apply layout) all pass. Running these two Garage versions in local containers is an allowed way to test.
- On v2.3.x the layout preview page does not error. It shows only the text. When a node-detail field is missing, show "—".

## 2.2 Version self-check

- At startup, and on every reconnect to Garage, call `GetNodeInfo` (`node=self`) and read `garageVersion`. When it is below v2.3.0, show a blocking notice in the UI, and the backend rejects writes.
- Cache the capability-probe result in the process. Probe again after Garage reconnects.

Acceptance: Starting against a v2.2.x instance shows a clear notice, and no frontend exception appears.

## 2.3 main-v2 list APIs

- In main-v2, `ListBuckets` and `ListKeys` add `offset` and `limit`. When `limit` is omitted, they return at most 10000 rows. `ListBucketsInfo` and `ListKeysInfo` are added. One call returns a list that includes details. The default cap is 1000.
- Requirements:
  1. On the first call, probe whether `ListBucketsInfo` and `ListKeysInfo` are available. When they are, use them instead of "`ListBuckets` + `GetBucketInfo` per bucket".
  2. When they are not available (v2.3.x, v2.4.x), use `ListBuckets` plus bounded-concurrency detail calls (see 4.11 of [correctness.md](correctness.md)). Load details lazily per page. Do not fetch details for every bucket at once.
  3. This project's outward list APIs paginate in one way. The frontend paginates, or it uses infinite scroll. It does not load the full set at once.
  4. When the number of rows returned equals `limit`, keep paging, or tell the user "there is more". Do not truncate silently.

Acceptance: Against a simulated Garage response of 12000 buckets, the list can be paged to the last row. Both paths have tests.

## 2.4 Endpoint list

| Category | Endpoint | Purpose |
|---|---|---|
| Cluster | `GetClusterHealth` | Home-page health card |
| | `GetClusterStatus` | Node list |
| | `GetClusterStatistics` | Cluster capacity and statistics |
| | `ConnectClusterNodes` | Connect nodes |
| Node | `GetNodeInfo` | Node detail and version self-check (v2.4 field probe) |
| | `GetNodeStatistics` | Node statistics |
| | `CreateMetadataSnapshot` | Metadata snapshot |
| | `LaunchRepairOperation` | Repair task |
| Layout | `GetClusterLayout`, `GetClusterLayoutHistory` | Current layout and history |
| | `UpdateClusterLayout`, `PreviewClusterLayoutChanges` | Stage a change and preview (`statistics` is v2.4+) |
| | `ApplyClusterLayout`, `RevertClusterLayout` | Apply or revert |
| | `ClusterLayoutSkipDeadNodes` | Skip dead nodes |
| Admin token | `ListAdminTokens`, `GetAdminTokenInfo`, `GetCurrentAdminTokenInfo` | List, detail, and self-check |
| | `CreateAdminToken`, `UpdateAdminToken`, `DeleteAdminToken` | Management (fields `name`, `expiration`, `scope`) |
| Key | `ListKeys`, `ListKeysInfo` (probe), `GetKeyInfo` | List and detail |
| | `CreateKey`, `ImportKey`, `UpdateKey`, `DeleteKey` | Management (includes `allow.createBucket` and `expiration`) |
| Bucket | `ListBuckets`, `ListBucketsInfo` (probe), `GetBucketInfo` | List and detail (query by id) |
| | `CreateBucket`, `UpdateBucket`, `DeleteBucket` | Management (`websiteAccess`, `quotas`, `corsRules`, `lifecycleRules`) |
| | `CleanupIncompleteUploads` | Clean up incomplete uploads |
| | `InspectObject` | Object diagnostics |
| Permission and alias | `AllowBucketKey`, `DenyBucketKey` | Grant and revoke |
| | `AddBucketAlias`, `RemoveBucketAlias` | Global and local aliases |
| Worker | `ListWorkers`, `GetWorkerInfo` | Worker list and detail |
| | `GetWorkerVariable`, `SetWorkerVariable` | Worker variables |
| Block | `ListBlockErrors`, `GetBlockInfo` | Block errors |
| | `RetryBlockResync`, `PurgeBlocks` | Retry and purge |
| Special | `/metrics` | Prometheus metrics (requires `metrics_token`) |
| | `/health` | Connectivity and read/write quorum check (no token required; returns success when the cluster can read and write) |

Not used: `CheckDomain` (Garage's website service uses it itself).

The allowlist must cover every endpoint in this table, `ListBucketsInfo` and `ListKeysInfo` used by the capability probe, and `/metrics`. The rule is 3.7 of [security.md](security.md).
