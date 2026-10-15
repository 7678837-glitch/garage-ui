# Delivery status and roadmap

This is the living status and outstanding-work map. Original implementation phases and effort estimates are retired; they do not describe remaining work. Requirements in the [working spec](README.md) remain acceptance targets; implemented controls and earlier passing checks do not establish that every acceptance criterion has passed on the current source revision.

## Implemented areas and recorded evidence

| Area | Implemented scope | Source and evidence |
|---|---|---|
| Build and deployment | Embedded React/Rust binary, pinned toolchains, non-root images, Compose examples, UI-only Helm chart, and development data generator | [Build script](../scripts/build.sh), [deployment files](../deploy), [load generator](../crates/garage-loadgen), [operator deployment guide](wiki/Deployment.md) |
| Local authentication and access | Setup, local accounts, persisted sessions, role/download/share permissions, user administration, and offline account recovery | [Authentication API](../crates/garage-ui/src/api/auth.rs), [access rules](../crates/garage-ui/src/access.rs), [CLI](../crates/garage-ui/src/cli.rs), [account guide](wiki/Users-and-authentication.md) |
| Storage and objects | Bucket/key management, object browsing, upload/download/ZIP, previews, sharing, CORS/lifecycle settings, and incomplete-upload cleanup | [Bucket UI](../web/src/Buckets.tsx), [object UI](../web/src/Objects.tsx), [bucket guide](wiki/Buckets.md), [object guide](wiki/Objects.md) |
| Cluster and operations | Health/metrics, nodes/layout, admin tokens, workers/repair, block errors, snapshots, object inspection, and audit filtering/export | [API modules](../crates/garage-ui/src/api), [cluster guide](wiki/Cluster-and-layout.md), [maintenance guide](wiki/Maintenance.md), [audit guide](wiki/Audit.md) |
| Interface | Radix controls, responsive navigation, light/dark themes, English/Simplified Chinese, and keyboard interaction | [Application](../web/src/App.tsx), [theme](../web/src/theme.tsx), [localization](../web/src/i18n.tsx), [migration report](../evidence/radix-migration/report.md) |
| Audit corrections | S3 recovery/cache behavior, ZIP error propagation/cancellation, node outcomes, proxy auditing/catalog cursors, audit CSV/export buffering, and build identity | [Nine-fix report](../evidence/nine-fixes/report.md) records focused regressions and revision-specific source/native/browser checks |

The [remaining-improvement convergence report](../evidence/convergence/report.md) records the current development checkpoint, including combined Rust/browser retakes and local arm64 image validation. Consult the separate [official Garage support check](garage-support.md) for upstream support evidence; application test results alone do not establish upstream support policy.

The reports retain exact build identities, Garage versions, test results, and limits. They are the evidence for those checkpoints; they do not validate later changes. In particular, controlled browser failures do not establish successful live destructive maintenance, and local performance checks do not establish remote-network or physical-phone performance.

## Outstanding acceptance and distribution

- The CI workflow remains disabled during development. The separate [manual release workflow](../.github/workflows/release.yml) prepares unpublished drafts. Workflow files and local results do not establish running remote CI or its release gates.
- The [release script](../scripts/release.sh) prepares local Linux artifacts, checksums, and an SBOM. Signing and build provenance in [release requirements](engineering.md#79-release-and-images) remain distribution requirements; local artifact preparation does not establish publication. Consult [Releases](https://github.com/xjoker/garage-ui/releases) for published artifacts.
- Re-run affected acceptance checks for the exact source/artifacts being reviewed. The [contributor guide](../CONTRIBUTING.md#verify-the-affected-behavior) owns verification commands and fixture prerequisites. Full working-spec acceptance is not inferred from feature presence or older reports.
- For private Garage certificates, the implemented path is a configured CA file or the explicit insecure option described in [Configuration](wiki/Configuration.md). Browser-facing certificate provisioning is not established by that support.

## Known implementation gaps

The [official Garage support assessment](garage-support.md#understand-the-feature-boundary) records source-confirmed boundaries:

- Layout preview runs and gates Apply, but discards its successful response body. Preview text/computation statistics, metadata/data partition details, and full node statistics remain undisplayed.
- About reports versions and the two list probes; comprehensive feature detection remains incomplete.
- The website settings editor and update route required by [section 5.17](features-data.md#517-website-access) remain unscheduled. Linking an already configured public website does not implement that editor.
- Object copy, multipart-copy/part-list controls, form POST upload, and SSE-C key-management controls are absent. Their absence does not add them to the accepted delivery scope.
- Development Garage list scopes, pagination, resync display, and S3 region discovery require separate future compatibility work. Neither inspected development branch has runtime acceptance; the stable support boundary remains unchanged.

## Deferred scope

OIDC login and identity-provider role mapping/single logout, team-based bucket authorization, multi-cluster management, Unix-socket listeners/connections, multi-replica deployment, and the next major Garage Admin API remain outside this delivery. No new schedule or effort estimate is assigned here.
