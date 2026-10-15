# Cluster, layout, and operations

Role abbreviations: A = administrator, V = read-only. Operations pages are open only to an administrator. See 3.19 of [security.md](security.md).

## 5.8 Layout

The minimum version does not include layout editing or the change flow (5.28, see 8.2 of [scope.md](scope.md)).

- Requirement: Assign and change node roles (zone, capacity, tags; an empty capacity means a gateway node), and remove a role. View and change the layout parameter `zoneRedundancy` (`"maximum"`, or at least N zones). A list of staged changes (from `stagedRoleChanges` and `stagedParameters` on `GetClusterLayout`). Before apply, call preview and show the preview result (v2.4 and later show structured statistics, v2.3 shows text). When preview returns the error branch, show the error and forbid apply. Apply (version = current + 1), or revert every staged change. Layout history. Skip dead nodes (A, a strong confirmation, and a statement of the risk. Pass the current version. Separately choose whether `allowMissingData` is set. When it is selected, add one more strong confirmation that says data may be lost).
- API: `GET /api/layout`; `POST /api/layout/stage`; `POST /api/layout/preview`; `POST /api/layout/apply`; `POST /api/layout/revert`; `GET /api/layout/history`; `POST /api/layout/skip-dead-nodes`.
- Garage: `GetClusterLayout`, `UpdateClusterLayout`, `PreviewClusterLayoutChanges`, `ApplyClusterLayout`, `RevertClusterLayout`, `GetClusterLayoutHistory`, `ClusterLayoutSkipDeadNodes`.

Acceptance: The "Apply" button is disabled when preview has not been run, or when preview returns an error. Capacity precision meets 4.4 of [correctness.md](correctness.md). The history page shows each version and its sync status.

## 5.9 Cluster health

- Requirement: The home-page card shows status, the number of known nodes, the number of connected nodes, the number of storage nodes and how many are up (`storageNodesUp`), and partition status. A node list, and connect nodes.
- API: `GET /api/cluster/health`; `GET /api/cluster/status`; `POST /api/cluster/connect` (A).
- Garage: `GetClusterHealth`, `GetClusterStatus`, `GetNodeInfo`, `ConnectClusterNodes`.

Acceptance: The numbers are correct on both v2.3.x and v2.4.1. When Garage is unreachable, show an error instead of a blank screen.

## 5.10 Statistics

- Requirement: Cluster and node statistics (capacity, free space, bucket count, object count, total amount). An optional Prometheus metrics summary (S3 request count, error count, block read and write bytes). Note: when Garage's `/metrics` is configured with `metrics_token` (or requires a token), it accepts `metrics_token` or an admin token whose scope contains `Metrics` (or `*`). When neither is configured, no token is required. This project tries them in this order: a separately configured `metrics_token`, then this project's admin token. When neither can be used, the metrics panel shows a notice.
- API: `GET /api/cluster/statistics`; `GET /api/nodes/{id}/statistics`; `GET /api/metrics`.
- Garage: `GetClusterStatistics`, `GetNodeStatistics`, `/metrics`.

Acceptance: A unit test parses Prometheus text. Every field of an empty response is 0.

The minimum version delivers health, status, and cluster statistics, and does not include the metrics panel. This minimum-version boundary does not imply the implemented metrics panel is pending.

## 5.11 Workers and repair tasks

Not included in the minimum version.

- Requirement: List Workers by node (one node ID, or every node), with status, errors, and progress. The list can show only busy workers, or only workers in error. View detail. Read every Worker variable, or one Worker variable, and set a variable (the variable name and the value are both strings, A). Start a repair task (A, a strong confirmation, targeted at one node or every node). The type comes from the Garage definition: `tables`, `blocks`, `versions`, `multipartUploads`, `blockRefs`, `blockRc`, `rebalance`, `aliases`, `clearResyncQueue`, and `start`, `pause`, `resume`, and `cancel` of `scrub`.
- API: `GET /api/nodes/{id}/workers`; `GET /api/nodes/{id}/workers/{wid}`; `GET`/`PUT /api/nodes/{id}/worker-variables`; `POST /api/nodes/{id}/repair`.
- Garage: `ListWorkers`, `GetWorkerInfo`, `GetWorkerVariable`, `SetWorkerVariable`, `LaunchRepairOperation`.

Acceptance: After a variable is set, reading it again returns the new value. A repair task writes an audit record.

## 5.12 Block errors

Not included in the minimum version.

- Requirement: List block errors by node. View block information by block hash (a node must be specified). Retry resync (a specified block hash, or "retry all"). Purge blocks (A, a strong confirmation, stating that object data will be lost. One request may submit multiple block hashes).
- API: `GET /api/nodes/{id}/block-errors`; `GET /api/nodes/{id}/blocks/{hash}`; `POST /api/nodes/{id}/blocks/retry`; `POST /api/nodes/{id}/blocks/purge`.
- Garage: `ListBlockErrors`, `GetBlockInfo`, `RetryBlockResync`, `PurgeBlocks`.

Acceptance: A read-only role calling purge returns 403. Purge requires typing the block hash to confirm.

## 5.13 Metadata snapshots

Not included in the minimum version.

- Requirement: Create a metadata snapshot for a specified node, or for every node (A).
- API: `POST /api/nodes/{id}/metadata-snapshot`.
- Garage: `CreateMetadataSnapshot`.

Acceptance: A successful operation shows a notice and writes an audit record.

## 5.28 Layout change flow

Depends on 5.8. Not included in the minimum version.

- Requirement: The layout page guides the user through steps.
  1. View the current layout (nodes, zone, capacity, tags, role) and the "staged changes" list.
  2. Edit. Assign, change, or remove a node role. The change enters the staging area and can be withdrawn one by one.
  3. Preview. Call the preview API. Show the new layout and the data-migration result (v2.4 and later use structured statistics as a table, v2.3 shows text).
  4. Apply. A high-risk confirmation. Fill in the current version + 1 automatically.
  5. Track. After apply, show progress tracking (each node's status of syncing to the new version, following layout history) until every node is done. When a node stays offline for a long time, offer a "skip dead nodes" entry and state the risk.
- At any time, "revert all staged changes" is available.

Acceptance: Apply is not available before preview. After apply, the tracking view shows complete once every node has synced. After revert, the staging area is empty.

## 5.29 Overview page and capacity visualization

The minimum version does only the health and statistics cards. Ranking, auto-refresh, and the audit widget are requirements beyond that minimum; [roadmap.md](roadmap.md) tracks current delivery status.

- Requirement: The overview page contains a health card, cluster capacity (used and free, distributed by node), the bucket count and the total object count, a ranking of buckets by capacity (the top N, with the rest merged as "Other", still readable when there are many buckets or when the buckets are very small), and recent audit events (administrators; enabled after the 5.21 query API in [features-access.md](features-access.md) is delivered).
- Ranking buckets by capacity, and sorting by capacity, depend on each bucket's detail. When the capability probe finds `ListBucketsInfo`, use it directly. Otherwise a background task summarizes on a schedule with bounded concurrency (4.11 of [correctness.md](correctness.md)), default 10 minutes, configurable, and caches the result. The UI labels the time of the data. A 30-second refresh does not trigger a full fetch.
- The bucket list and the bucket detail show a quota-usage progress bar (capacity and object count). At 80% mark it with the warning color. At 95% mark it with the error color.
- Data refreshes automatically (default 30 seconds, and the refresh can be paused). When the page is not visible, stop refreshing.

Acceptance: With 1000 buckets, the ranking chart is still readable. Quota-threshold colors have a component test. After switching to a background tab, no further request is sent.
