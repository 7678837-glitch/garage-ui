# UI and interaction

## 5.22 Pagination

- Requirement: Every list API in this project (buckets, keys, objects, users, audit, admin tokens, block errors) uses one pagination contract: `offset`/`limit`, or a continuation token. The response carries `next` or `hasMore`. The frontend uses one pagination component.
- Garage: `offset` and `limit` of `ListBucketsInfo` / `ListKeysInfo` (capability probe), and the S3 continuation token.

Acceptance: Every list API normalizes an out-of-range `limit` (default 100, maximum 1000).

## 5.25 Navigation and page structure

- Requirement: A fixed navigation on the left (on a narrow screen it collapses to a drawer). The top-level entries, in order, are Overview, Buckets, Keys, Nodes and layout, Operations (Workers, block errors, snapshots, repair), Admin tokens, Audit, and Settings. A read-only role does not see an entry it is not allowed to use.
- Each resource uses a list page, then a detail page (tabs). Bucket detail contains Overview, Objects, Permissions, Settings (website, quotas, CORS, lifecycle), and incomplete uploads. Key detail contains Overview, the buckets it can access, and Settings. Node detail contains information, statistics, Workers, block errors, and maintenance actions.
- The top shows breadcrumbs, the current user and role, the connected Garage version, and a health-status badge.
- Every detail page, tab, and object prefix has its own address that can be shared and refreshed. Browser back and forward keep the state.

Acceptance: In E2E, opening any deep address directly renders it correctly. A read-only account's navigation has no entry for a write action. On a narrow screen the navigation can be expanded and collapsed.

Navigation must mount only delivered modules and hide entries for unavailable features. Operations, admin tokens, audit, CORS, lifecycle, and incomplete-upload controls are implemented beyond the minimum-version scope; the website editor remains unscheduled. Address rules apply to every delivered page. See [roadmap.md](roadmap.md) for current status.

## 5.26 Shared interaction states

- Requirement: Every data block must implement four states:
  1. Loading. The first screen uses a skeleton placeholder. A later refresh shows only a light progress hint and does not clear data already on screen.
  2. Empty. Say why it is currently empty, and give the next action (for example "Create the first bucket"). A read-only role does not show a create button.
  3. Error. The block shows an error bar with a readable explanation, an error code, and a "Retry" button. When Garage is unreachable, show one global banner instead of an error on every block.
  4. Partial result. When pagination is truncated, a search hits its cap, or a missing capability is detected, state the reason explicitly.
- Writes: while a submit is in progress, disable the button and show progress. After success, tell the user with a non-blocking notice and refresh the related data. On failure, keep the form input and show the error.
- A settings form shows its save state (unsaved, saving, saved, failed). Leaving a page that has unsaved changes prompts the user.

Acceptance: Frontend component tests cover loading, empty, and error for every list component. When Garage is simulated as disconnected, a global banner appears.

## 5.27 Graded confirmation

- Requirement: Split write actions into three levels by risk.
  1. Low risk (rename, change a quota, change the website document). No confirmation. The change can be undone, or it can be edited again.
  2. Medium risk (delete a single object, revoke a permission, delete an empty bucket, delete a key). A modal confirmation states the object name and the consequence. The default focus is "Cancel".
  3. High risk (recursive delete, batch delete, purge blocks, skip dead nodes, apply a layout, turn on public website access, create a full-authority admin token). The user can confirm only after typing the target name (or the block hash, or the layout version). State the irreversible consequence and the scope of impact (object count, capacity).
- The confirmation dialog supports the keyboard (Esc cancels. Enter takes effect only after the typed value matches).

Acceptance: A table-driven test fixes the risk level of every write action. For a high-risk action, the confirm button is disabled when the input does not match.

The minimum version grades the write actions that exist at that time. Confirmation for purge blocks, skip dead nodes, apply layout, public website, and a full-authority admin token ships with the matching feature. The level table registers those actions as high risk first.

## 5.30 Filtering, sorting, and selection on lists

- Requirement: The bucket, key, node, admin-token, and user lists support filtering by name, and sorting by columns such as name, creation time, and capacity. The default sort is fixed and is explained. Sort and filter state is written into the address. Sorting the bucket list by capacity uses the 5.29 summary cache in [features-cluster.md](features-cluster.md).
- The object list supports multi-select (including holding Shift to select a range, and selecting every row on the current page). After a selection, a bulk-action bar appears (delete, download ZIP, copy path). There is no cross-page "select all". To act on a whole prefix, use the folder recursive operation (4.3 and 5.6).

Acceptance: After a refresh, the sort and the filter remain. The bulk-action bar appears only when something is selected.

The minimum version's bulk-action bar includes delete and copy path. ZIP appears with 5.6. Sort by capacity is unavailable until the summary cache is delivered. The UI does not offer that sort, so that one request does not fetch the detail of every bucket.

## 5.32 Object preview viewer

The minimum version does only allowlisted inline preview. Range reads, switching inside the same directory, and truncating large text are delivered with the full form of this item.

- Requirement: The object-detail sidebar shows metadata (size, type, ETag, modification time, custom metadata). Allowlisted types preview in the viewer: images, audio and video (seeking by dragging the progress bar is supported, which means the backend supports a byte-range read and returns a stream), PDF, and plain text (above a configurable size, show only the beginning). Inside the same directory, the Left and Right keys move to the previous object and the next object.
- A type outside the allowlist shows "Download" instead of a preview, and follows 3.3 of [security.md](security.md). Preview, download, and thumbnails all require the download permission in 3.19. A read-only user without that permission sees only metadata. The UI shows no preview entry and no download entry.
- How this relates to 3.3: images, audio, and video point a media element directly at the object address. The frontend reads text and renders it as plain text. Neither is affected by the sandbox CSP on the object response. A PDF is placed in a sandboxed iframe. Only scripts are allowed, and same origin is not granted. A range-read response also carries `nosniff` and `no-store`.

Acceptance: A video can be dragged to any position and played. Large text loads only the beginning. Switching objects cancels the previous load that has not finished.

## 5.33 Upload panel

- Requirement: The drop zone covers the object list. The upload panel lists each file's progress, speed, and state (queued, uploading, completed, failed, cancelled). It supports cancelling one file, retry, and clear all. If an upload is still running when the user leaves the page, prompt the user. For an object of the same name, ask with the choices "overwrite", "skip", and "overwrite all".

Acceptance: E2E uploads 3 files and cancels 1 of them. The panel state is correct, and the cancelled parts have been aborted.

## 5.35 Appearance and accessibility

- Requirement: Three themes, light, dark, and follow the system. The choice is stored in a local preference (data that is not sensitive). Every color meets WCAG AA contrast. A state is not conveyed by color alone (an icon or text is present as well). Every interactive element can be reached from the keyboard and has a visible focus. An icon button has a readable label. The layout is usable on a screen that is 360 pixels wide.

Acceptance: An automated accessibility check (such as axe) reports zero serious problems on the main pages. Screenshot tests pass under both themes.

Per 8.1 of [scope.md](scope.md), the minimum version includes light, dark, and basic accessibility. Follow the system belongs to the full scope of this item.

## 5.36 Version and capability notice

- Requirement: "About" on the Settings page shows this project's version, the build information, the connected Garage version, and the capability-probe result (which v2.4 fields are available, and whether the list APIs are available). When the connected Garage is below the minimum version, a site-wide banner says so.

Acceptance: Against a v2.3.x instance and a v2.4.1 instance, the capability list displays correctly.
