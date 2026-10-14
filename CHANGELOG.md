# Changelog

## 20261014.2 (DRAFT)

Unpublished release candidate following 20261014.1. This update completes layout actions, improves object browsing and localization, and expands verification of the existing administration and observability flows. The minimum supported Garage version remains v2.3.0, with compatibility tested on v2.3.0 and v2.4.1.

- Apply a previewed layout at the next version, revert staged changes, and pass the current layout version when skipping dead nodes, with additional confirmation before allowing missing data.
- Show bitmap thumbnails in object lists only when download is permitted, load them as rows enter view, and navigate adjacent objects with Left and Right. Collapse the upload panel to keep object rows visible, and preserve bucket refreshes during the initial list load.
- Provide English and Simplified Chinese UI catalogs, including navigation, forms, dialogs, timestamps, and capacity units. Improve narrow-screen layouts for bucket and node identifiers, audit filters, operations pages, and object actions.
- Verify existing metrics, layout history, worker and block diagnostics, repair controls, object inspection, key grants, bucket CORS and lifecycle editing, upload cleanup counts, audit export, and admin-token warnings against real Garage instances. Strengthen viewer-permission, ZIP-token revocation, browser preflight, and video-seeking regression coverage.
- Update frontend dependencies to resolve security advisories and verify HTTP transport timeouts and graceful shutdown. Add repeatable browser list-performance, ZIP-memory, and large-file thumbnail checks; redact session cookies from browser-check failure logs.
- Share the image-build interface with unsigned release preparation and support local builds of both Linux amd64 and arm64 images through `scripts/build.sh --images`.

## 20261014.1

First version. The minimum Garage version is v2.3.0. This version was verified on v2.3.0 and v2.4.1.

- Set up the first administrator, log in, log out, and change a password. Roles are admin and viewer, with separate download and share permission bits.
- List, create, and delete buckets. Set aliases and quotas. Grant and revoke bucket permissions.
- List, create, delete, and rename keys. Allow a key to create buckets. A key secret is shown once, after a second confirmation.
- Browse objects by prefix. Preview allowlisted types inline. Download and upload objects, including multipart upload. Use the upload panel. Delete one object, delete a selection after typing the count, and delete a prefix recursively. Filter, sort, and select objects.
- Choose a light theme, a dark theme, or the system theme. Loading, empty, error, and retry states are part of those flows.
- Read cluster health, status, and statistics. Open the About page.
