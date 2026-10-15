# Official Garage support assessment

As of **2026-10-15**, Garage UI targets the latest official stable Garage release, **v2.4.1**, and has exercised compatibility with **v2.3.0 and v2.4.1**. Its pinned Admin API document exactly matches official v2.4.1, and the proxy allowlist covers all 46 stable `/v2` HTTP operations. Endpoint coverage does not establish complete UI exposure or runtime acceptance of every operation.

This assessment uses Garage UI source [`84a24711d8c8c57854c7878dab89fa1d2cca80ed`](https://github.com/xjoker/garage-ui/tree/84a24711d8c8c57854c7878dab89fa1d2cca80ed). Validation is bounded below; development branches are source comparisons only.

## Choose a Garage release

The official [v2.4.1 release](https://git.deuxfleurs.fr/Deuxfleurs/garage/releases/tag/v2.4.1) was published **2026-09-08 at 08:44:05 UTC**. It fixes a startup panic with Consul/Kubernetes discovery; upstream states there are no other Garage changes since v2.4.0. Helm improvements are separate deployment changes. No newer numbered stable or prerelease appeared in the checked [official release list](https://git.deuxfleurs.fr/api/v1/repos/Deuxfleurs/garage/releases?limit=5).

[v2.4.0](https://git.deuxfleurs.fr/Deuxfleurs/garage/releases/tag/v2.4.0), published September 6, adds structured layout statistics and richer node information. [v2.3.0](https://git.deuxfleurs.fr/Deuxfleurs/garage/releases/tag/v2.3.0), published April 16, is the project's minimum for writes; CORS and lifecycle editing already exist in that API generation.

The development lines do not establish a future release date:

| Line inspected | Exact source | Finding |
|---|---|---|
| `main-v2` | [`6a1f58ccb04ac19025656f2ece3a0f388067f7be`](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/commit/6a1f58ccb04ac19025656f2ece3a0f388067f7be), October 12 | Unreleased Admin v2 additions described below. |
| `next-v3` | [`5d5a9ab642fe8312aeb83889243219470c6ee0a7`](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/commit/5d5a9ab642fe8312aeb83889243219470c6ee0a7), September 15 | Still contains an Admin v2 schema with 49 paths, 126 schemas and no `/v3/` paths. This is not evidence of a released Admin API v3. |

The [official April roadmap](https://garagehq.deuxfleurs.fr/blog/2026-04-performance-reliability/) discusses reliability, performance, observability and preliminary bucket-policy exploration. Those plans do not make the features available today.

## Verify the API pin and drift

| Document | Paths / HTTP operations | `/v2` operations | Component schemas |
|---|---:|---:|---:|
| Official v2.3.0 | 49 / 49 | 46 | 123 |
| Repository pin / official v2.4.1 | 49 / 49 | 46 | 126 |
| Exact `main-v2` commit above | 51 / 51 | 48 | 129 |

The other stable paths are `/health`, `/metrics` and `/check`. Sources: [v2.3.0 JSON](https://git.deuxfleurs.fr/Deuxfleurs/garage/raw/tag/v2.3.0/doc/api/garage-admin-v2.json), [v2.4.1 JSON](https://git.deuxfleurs.fr/Deuxfleurs/garage/raw/tag/v2.4.1/doc/api/garage-admin-v2.json), [development JSON](https://git.deuxfleurs.fr/Deuxfleurs/garage/raw/commit/6a1f58ccb04ac19025656f2ece3a0f388067f7be/doc/api/garage-admin-v2.json).

The repository pin and official v2.4.1 bytes share SHA-256:

```text
bfbf5b7153ff492a1ee4e7c4b5d3046093263e866890d6f7541d7baf78c990b1
```

Both report `info.version: v2.4.0`; upstream v2.4.1 retains that value. Use release identity and bytes, not that field alone. Stable paths and methods are unchanged from v2.3.0. Schema additions include layout computation statistics and node fields `addr`, `role`, `draining`, `isUp`, `metadataPartition` and `dataPartition`.

To reproduce, fetch the linked official JSON documents, compare `openapi/garage-admin-v2.json` with the stable download using `cmp` and `shasum -a 256`, then parse each with Python's standard `json` module. Count `paths`, HTTP method keys under each path, `/v2` method keys, and `components.schemas` separately. Compare each stable path/method pair against `ENDPOINTS` in [proxy.rs](../crates/garage-ui/src/proxy.rs). This avoids counting schema definitions as capabilities. No extra dependency or generated script is required.

The [proxy allowlist](../crates/garage-ui/src/proxy.rs) has 50 entries: all 46 stable v2 operations, the two development list operations, health and metrics. `/check`, intended for public website reverse-proxy domain checks, is omitted. Allowlisting a request does not grant the upstream token its required scope.

## Understand the feature boundary

| Area | Implemented in project source | Current boundary |
|---|---|---|
| Stable Admin transport | Typed handlers, generated types and all stable v2 method pairs | Coverage does not mean every field has a UI or every operation passed runtime acceptance. |
| Cluster and layout | Health, nodes, staged layout, workers, block errors, tokens and repair paths | Preview discards the response body. Layout preview text/computation statistics, metadata/data partition information and full node statistics are not displayed. About exposes versions and two list probes, not comprehensive feature detection. |
| Buckets, keys and access | CRUD, aliases, quotas, grants/revokes, expiration, key import, CORS/lifecycle, cleanup and inspection | Runtime evidence remains limited to recorded flows. |
| Object work | Browsing, metadata, upload/multipart, reads/ranges, deletion, presigned sharing and ZIP | No controls for CopyObject, UploadPartCopy, ListParts, form POST uploads or SSE-C key management. Garage supports SSE-C. |
| Website settings | Existing configured public websites can be linked when sharing | The dedicated editor/update route in [specification section 5.17](features-data.md#517-website-access) is explicitly unscheduled. |
| Project scope | Local UI users and the configured cluster | OIDC, teams, multiple clusters/replicas and node installation/upgrades/configuration are deferred. |

Implementation references: [cluster handlers](../crates/garage-ui/src/api/cluster.rs), [cluster UI](../web/src/ClusterNodes.tsx), [bucket handlers](../crates/garage-ui/src/api/buckets.rs), [key handlers](../crates/garage-ui/src/api/keys.rs), and [object handlers](../crates/garage-ui/src/api/objects.rs).

Keep these stable UI omissions separate from upstream fixes. The v2.4 releases improve CORS wildcard/matching-origin/preflight behavior, nonexistent-key bulk-delete reporting, alias-only bucket information and SigV4 whitespace handling. Upgrading Garage supplies those engine fixes. K2V monotonic reads, CLI health/logging, discovery shutdown, database and Helm changes are upstream engine/CLI/deployment work; they do not create missing UI controls or expand this project's scope. See the [v2.4.0 release notes](https://git.deuxfleurs.fr/Deuxfleurs/garage/releases/tag/v2.4.0).

## Treat development compatibility as unvalidated

At the inspected `main-v2` commit, GET `ListBucketsInfo` and GET `ListKeysInfo` return arrays of full information responses. Lists acquire ID-string `offset` and integer `limit` parameters. These are inclusive ID cursors, not numeric row offsets; old lists default to 10,000 items and detail lists to 1,000. See the exact [bucket](https://git.deuxfleurs.fr/Deuxfleurs/garage/raw/commit/6a1f58ccb04ac19025656f2ece3a0f388067f7be/src/api/admin/bucket.rs) and [key](https://git.deuxfleurs.fr/Deuxfleurs/garage/raw/commit/6a1f58ccb04ac19025656f2ece3a0f388067f7be/src/api/admin/key.rs) implementations.

The schema adds connection parameters and optional `resyncQueueLen`. Existing project list probes, cursor translation and stable fallback do not prove complete future compatibility. The explicit token scope picker lacks the new list scope names, and resync queue length is not displayed.

A separate future compatibility gap affects S3 discovery: upstream connection parameters use `region`, while the project reads `s3Region`. [Exact upstream node source](https://git.deuxfleurs.fr/Deuxfleurs/garage/raw/commit/6a1f58ccb04ac19025656f2ece3a0f388067f7be/src/api/admin/node.rs) confirms the contract. **This is not a stable v2.4.1 bug:** that release has no connection-parameters field. Before any future development-version testing, set `S3_REGION` explicitly to Garage's actual region; it takes precedence over discovery. Neither development branch has undergone runtime testing here.

## Respect Garage's S3 limits

The [official S3 compatibility reference](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/) lists limitations for versioning, object locks/retention/legal hold, ACLs/policies, replication, tags, storage classes, notifications and encryption configuration. SSE-C is supported upstream, although Garage UI has no key-management controls. Lifecycle editing must stay within expiration and incomplete-multipart abortion; transition and versioning actions are outside the supported subset.

Check exact-version source when documentation conflicts: the compatibility page retains website-redirection wording that differs from later website schemas. Vendor limitations and project-deferred editors are separate boundaries.

## Apply the verification evidence

The [convergence evidence](../evidence/convergence/report.md) records **90 unique Chromium cases per supported release**, combining full runs and targeted retakes, plus macOS WebKit and Linux Firefox core smoke at widths **360 and 1280** on both releases. Real CORS coverage is a **Rust integration against a real Garage v2.4.1 instance**, not a browser CORS acceptance test.

No physical devices, destructive-maintenance acceptance, other Garage releases, `main-v2` runtime or `next-v3` runtime are covered. Controlled successful flows do not establish every vendor S3 semantic fix or every administrative operation.

Use v2.4.1 for current deployments and retain the exact stable schema pin. Evaluate stable UI omissions against your operational needs; keep website settings marked unscheduled. Treat development pagination, token scopes, S3 discovery and resync display as separate future validation work. This assessment makes no implementation or next-release commitment.
