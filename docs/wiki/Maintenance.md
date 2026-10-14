# Maintenance

These controls require an administrator. Select the intended node before acting, and review the full node ID and scope in every confirmation. An accepted repair request means the operation started; inspect subsequent worker progress and cluster health to assess completion.

## Inspect workers

Open **Workers** and select a node, or **All nodes** for a cluster-wide view. Use **Busy only** or **Errors only** to focus the list. Rows show worker ID/name, state, error count, and progress. Choose **Details** for the worker's error detail; **No error reported** means that response contains no error message.

Use the node's **Maintenance** controls when you need to change work. In **Variable**, enter the exact Garage worker variable and value, choose **Save variable**, and review the confirmation. The result states the returned variable value. The UI does not invent or validate a catalog of all Garage variables; use a variable supported by your running Garage version.

## Start a repair or control a scrub

Under **Start repair**, choose a **Repair type**, then **Start repair** and confirm the selected node/scope.

| Choice | Intended Garage operation |
|---|---|
| `tables`, `blocks`, `versions` | Repair the selected metadata or block structures |
| `multipartUploads`, `blockRefs`, `blockRc` | Repair upload or block-reference bookkeeping |
| `rebalance`, `aliases` | Request rebalancing or alias repair |
| `clearResyncQueue` | Clear the resync queue; inspect the current state before selecting it |
| `scrub start`, `scrub pause`, `scrub resume`, `scrub cancel` | Start or control a block scrub |

The options are sent to Garage. Consult the [Garage documentation](https://garagehq.deuxfleurs.fr/documentation/) for the operational meaning and prerequisites of your installed version. After **Repair started**, return to worker state and progress; do not launch repeated repairs just because a long-running task is still busy.

## Investigate block errors

Open **Block errors**, select the intended node, and inspect block hash, refcount, error count, last-try age, and next-try delay. Choose **Info** to view block references, version information, and deleted/garbage-collected indicators.

Use **Retry** for one block or **Retry all** for the displayed node's resync work. A retry requests resynchronization; it does not establish that the data was recovered. Refresh and inspect the remaining errors.

**Purge** removes blocks and requires confirmation. Review the exact hash/node and the data-loss consequence before continuing. Do not treat purging as a harmless way to clear an error counter.

## Request metadata snapshots

In **Nodes and layout**, choose **Snapshot metadata** for a node or **Snapshot every node** for the cluster. Review the confirmation. **Metadata snapshot started** confirms the request was accepted; the UI does not download the snapshot to your browser.

Snapshots belong to Garage's metadata backup workflow. They do not back up the UI's SQLite state or replace an object-data backup. See [Deployment](Deployment.md#back-up-and-restore-ui-state) for UI backups.

## Handle an all-node failure

All-node worker and repair requests preserve each node outcome. When every node succeeds, the response remains the node-keyed success map. Mixed outcomes return HTTP 502 with `garage_partial_failure`; an all-failed outcome returns HTTP 502 with `garage_error`. Both error responses retain the `success` and `error` node maps and identify failed nodes in the message.

Successful nodes may already have applied a mutation even though the overall request failed. Inspect those nodes and the failed-node details before retrying. Do not blindly rerun a repair, variable change, or other mutation across the whole cluster. Select the failed node where the control permits it, and check current worker state before acting.
