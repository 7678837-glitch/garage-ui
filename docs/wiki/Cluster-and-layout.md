# Cluster and layout

All signed-in users can read the overview. **Nodes and layout** and layout changes require an administrator.

## Check cluster health

Open **Overview**. Health includes known and connected nodes, storage nodes, storage nodes up, partition count, partitions with quorum, and partitions all OK. Statistics include bucket count, object count/bytes, and available data/metadata space when Garage provides them.

The Prometheus summary includes S3 requests, S3 errors, block read bytes, and block write bytes. Metrics failure is displayed separately from health/statistics failure; unavailable metrics do not prove the cluster is down. A notice also appears if Garage TLS certificate verification is disabled.

Use **Retry health** or **Retry statistics** after fixing connectivity. Disconnected nodes can make available-space totals lower. Read the status and missing-value notices rather than treating an absent metric as zero.

## Inspect or connect a node

Open **Nodes and layout**. Filter or sort the node list to find a node, then open its detail. **Information**, **Statistics**, and **Maintenance** separate identity/status from capacity statistics and operational controls. Copy or inspect the full node ID before acting on it.

To connect a node, enter the Garage node address in **Node address**, choose **Connect node**, and wait for **Connected**. The address must be a Garage RPC node address, not the UI's browser URL. A successful connection does not itself assign storage capacity to the layout.

## Stage and apply capacity changes

Layout changes affect data placement. Work from the live layout version shown by the UI.

1. Select the relevant node capacity control, enter the capacity and unit, and **Save**. Capacity must resolve to a whole number of bytes.
2. Review the staged node capacities and choose **Preview layout**. A successful Garage preview enables **Apply layout**; the current UI does not display the returned preview text or computation statistics. Inspect those through Garage's own administrative tools when needed before proceeding.
3. Choose **Apply layout** only when the staged changes represent the intended cluster. Review the confirmation. The UI applies changes at the next layout version.
4. Recheck layout and health; applying the request is not evidence that all data movement has finished.

Choose **Revert staged changes** to discard pending layout changes. This concerns staging; it does not undo an already applied layout. **Layout history** exposes previous versions and sync trackers to help inspect progress.

## Skip dead nodes

**Skip dead nodes** forces layout progress past dead nodes. Read the confirmation and the current layout information first. Selecting **Allow missing data** acknowledges that object data can be lost. The dialog explicitly calls out that consequence. Use this only as a deliberate recovery decision when you understand the Garage state; it is not a routine retry for an unavailable node.

For worker repair, block errors, and snapshots, continue with [Maintenance](Maintenance.md).
