# Garage UI user guide

[![Releases](https://img.shields.io/badge/Releases-GitHub-blue)](https://github.com/xjoker/garage-ui/releases)

Garage UI is an unofficial browser console for Garage, the S3-compatible object store. Use it to manage storage, access, and cluster operations without giving the browser your Garage admin token.

The React interface is bundled into the Rust server. A production deployment serves the UI and API from one process and port; it needs neither a separate frontend service nor a browser CDN.

Check [Releases](https://github.com/xjoker/garage-ui/releases) for published artifacts. Build from the source you intend to run; an unpublished draft has no public downloads and does not establish that later source changes are included. Garage **v2.3.0 or newer** is required for writes. Compatibility has been exercised with v2.3.0 and v2.4.1. The [official Garage support assessment](https://github.com/xjoker/garage-ui/blob/dev/docs/garage-support.md) records the exact stable API match, current UI gaps, vendor limits, and verification boundary; newer releases require separate validation.

## Start here

1. [Get the UI running](Getting-started.md), connect it to Garage, and create your first administrator.
2. [Create a bucket](Buckets.md) and [grant an S3 key access](Keys-and-permissions.md).
3. [Browse and upload objects](Objects.md), then [preview, download, or share them](Downloads-and-sharing.md).

If someone has already deployed the UI, ask them for its address and a local UI account. Start at [Users and authentication](Users-and-authentication.md); a Garage S3 key is not a UI login.

## Everyday work

| Task | Guide |
|---|---|
| Choose server settings and secret files | [Configuration](Configuration.md) |
| Run containers, use Helm, or preserve state | [Deployment](Deployment.md) |
| Set aliases, quotas, CORS, retention, and incomplete-upload cleanup | [Buckets](Buckets.md) |
| Manage S3 credentials and bucket grants | [Keys and permissions](Keys-and-permissions.md) |
| Issue scoped Garage admin tokens | [Admin tokens](Admin-tokens.md) |
| Inspect health, nodes, and staged layouts | [Cluster and layout](Cluster-and-layout.md) |
| Run repairs, inspect workers, and handle block errors | [Maintenance](Maintenance.md) |
| Investigate activity and export records | [Audit](Audit.md) |
| Change language, theme, and use keyboard navigation | [Appearance and accessibility](Appearance-and-accessibility.md) |
| Resolve startup, login, and storage failures | [Troubleshooting](Troubleshooting.md) |
| Build, verify, and contribute changes | [Contributing](Contributing.md) |

## What lives where

Garage holds objects, buckets, S3 keys, Garage admin tokens, and cluster metadata. Garage UI has its own SQLite database for UI users, sessions, audit records, ZIP download tokens, and selected bucket-key bindings. Preserve the UI data directory as well as your independent Garage backups. See [Deployment](Deployment.md#back-up-and-restore-ui-state).

This guide describes implemented behavior. The repository's [working specifications](https://github.com/xjoker/garage-ui/tree/dev/docs) describe requirements and acceptance targets; they are not a completed-feature checklist.

For implementation status and verification reports, use the repository [documentation index](https://github.com/xjoker/garage-ui/blob/dev/docs/README.md) and [delivery roadmap](https://github.com/xjoker/garage-ui/blob/dev/docs/roadmap.md). For local development and checks, use [Contributing](https://github.com/xjoker/garage-ui/blob/dev/CONTRIBUTING.md).
