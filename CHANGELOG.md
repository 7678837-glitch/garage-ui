# Changelog

Entries describe their named release or unpublished draft. Later development work is tracked in the [delivery roadmap](docs/roadmap.md) and [verification evidence](docs/README.md#verification-evidence); it is not automatically included in a release entry.

## 20261016.1

First public release. Requires Garage v2.3.0 or later; browser integration is verified against Garage v2.3.0 and v2.4.1.

- Manage buckets, keys, grants, aliases, quotas, CORS, lifecycle rules, and scoped administrator tokens.
- Browse, preview, upload, share, and download objects, including multipart transfers and ZIP archives; cancel transfers and delete individual objects, selections, or prefixes.
- Configure the first administrator and manage users, roles, sessions, and audit exports. Validate bucket credentials and update their mapping and audit record atomically; prevent invalidated credentials from being restored by concurrent cache loads.
- Inspect cluster health, metrics, layout history, workers, and block errors, and run guarded maintenance operations.
- Provide responsive English and Simplified Chinese interfaces, light and dark themes, keyboard navigation, and accessible controls. Preserve concurrent upload completion states and readable light-theme accent text.
- Verify browser workflows in Chromium, Firefox, and WebKit, including upload cancellation, ZIP downloads, video seeking, setup, and TLS warnings.
- Provide a Docker-first quick start with standalone Compose and configuration downloads; build releases only from version tags that match the repository manifests. Tests run locally before tagging.
- Publish static Linux amd64 and arm64 binaries, multi-architecture container images, an SPDX SBOM, and SHA-256 checksums. Images and binaries are unsigned; signing and build-provenance attestations are deferred. Release-image health reports identify the exact source commit and version.

## 20261015.1 (DRAFT)

Unpublished release draft following 20261014.1. This update expands storage, access management, cluster administration, and observability, and migrates the embedded React 18 interface to Radix Themes. All pages use compact desktop and mobile layouts with updated Garage UI branding. The minimum supported Garage version remains v2.3.0, with compatibility verified on Garage v2.3.0 and v2.4.1.

- Apply a previewed layout at the next version, revert staged changes, and pass the current layout version when skipping dead nodes, with additional confirmation before allowing missing data. Expose layout history, metrics, worker and block diagnostics, and repair controls.
- Expand key grants, bucket CORS and lifecycle editing, object inspection, incomplete-upload cleanup counts, audit export, and admin-token warnings.
- Show bitmap thumbnails only when download is permitted, navigate adjacent objects with Left and Right, and collapse the upload panel to keep object rows visible. Preserve bucket refreshes during the initial list load and keep object keys ending in `/thumbnail` accessible.
- Provide English and Simplified Chinese UI catalogs, including navigation, forms, dialogs, timestamps, and capacity units. Use accessible Radix controls, menus, tabs, and dialogs throughout navigation, account management, storage, access, and cluster pages.
- Preserve authorization revocations during password changes and resets, and rotate password-change sessions atomically. Update frontend dependencies and rustls to resolve security advisories. Add regression checks for HTTP transport timeouts, graceful shutdown, viewer permissions, revoked ZIP tokens, browser preflight, and video seeking.
- Retry failed S3 endpoint discovery in the same process after the Admin API recovers, retaining configured overrides. Resolve credentials without holding a lock during network requests, and prevent stale retries from restoring invalidated credentials.
- Report fatal ZIP download failures as failed transfers and cancel pending archive work when a download is abandoned; recoverable failures opening selected objects remain listed in `_errors.txt`.
- Preserve successful and failed node outcomes for maintenance operations. Show partial and complete failures accurately, and record rejected upstream mutations as audit errors.
- Invalidate bucket and key pagination cursors after catalog mutations, and prevent older responses from restoring stale page boundaries.
- Read audit pages directly with bounded SQL queries and stream CSV exports in bounded batches. Neutralize formula-leading CSV text without changing stored records or JSON results.
- Embed the source commit in official builds and require release-image health checks to match the exact version and commit. Share the image-build interface with unsigned release preparation, and support local Linux amd64 and arm64 builds through `scripts/build.sh --images`.
- Add repeatable list-performance, ZIP-memory, and large-file thumbnail checks, and redact session cookies from browser-check failure logs.
- Expand the operator Wiki and AI contribution guide with current interface screenshots, task-oriented workflows, configuration, and verification guidance.

## 20261014.1 (DRAFT)

Unpublished initial release draft. The minimum Garage version is v2.3.0. This version was verified on v2.3.0 and v2.4.1.

- Set up the first administrator, log in, log out, and change a password. Roles are admin and viewer, with separate download and share permission bits.
- List, create, and delete buckets. Set aliases and quotas. Grant and revoke bucket permissions.
- List, create, delete, and rename keys. Allow a key to create buckets. A key secret is shown once, after a second confirmation.
- Browse objects by prefix. Preview allowlisted types inline. Download and upload objects, including multipart upload. Use the upload panel. Delete one object, delete a selection after typing the count, and delete a prefix recursively. Filter, sort, and select objects.
- Choose a light theme, a dark theme, or the system theme. Loading, empty, error, and retry states are part of those flows.
- Read cluster health, status, and statistics. Open the About page.
