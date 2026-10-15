# Data plane: buckets, objects, and bucket settings

Role abbreviations: A = administrator, V = read-only. Permission bits are in 3.19 of [security.md](security.md).

## 5.1 Buckets

- Requirement: A paginated list (name, alias, object count, capacity, quota usage), create (an optional global alias), delete (prompt when the bucket is not empty), and add or remove aliases (global and local).
- API: `GET /api/buckets?offset&limit` (A/V); `POST /api/buckets` (A); `DELETE /api/buckets/{id}` (A); `POST`/`DELETE /api/buckets/{id}/aliases` (A).
- Garage: `ListBucketsInfo` or `ListBuckets` + `GetBucketInfo`, `CreateBucket`, `DeleteBucket`, `AddBucketAlias`, `RemoveBucketAlias`.

Acceptance: A bucket with only a local alias appears in the list and can be opened. Deleting a non-empty bucket returns Garage's error, and the UI shows that error.

## 5.2 Browsing objects

- Requirement: Prefix navigation and breadcrumbs, split on `/`. Pagination (default 100, maximum 1000, continuation token). An S3 list returns keys only in lexicographic order and supports only a prefix filter, so the order across pages is fixed as key lexicographic order. Sort by size or by time applies only to the page already loaded, and the UI states "this page only". Substring search inside a prefix (at least 2 characters, at most 200 hits, at most 20 pages scanned). Safe preview. Object metadata and `InspectObject` diagnostics (A). Diagnostics are outside the minimum-version scope. The minimum version has no diagnostics entry.
- API: `GET /api/buckets/{id}/objects?prefix&limit&next`; `GET /api/buckets/{id}/object?key=<key>` (metadata, view, download); `GET /api/buckets/{id}/search?q&prefix`; `GET /api/buckets/{id}/inspect?key=<key>` (A).
- Garage: S3 `ListObjectsV2`, `HeadObject`, `GetObject`; Admin `InspectObject`.

Acceptance: 5000 objects can be browsed page by page. When a search is truncated, the response includes a reason field. Preview meets 3.3 of [security.md](security.md).

## 5.3 Upload

- Requirement: Drag and drop, or pick multiple files. Folder upload keeps relative paths. The upload queue runs 3 at a time, can be cancelled, can be retried, and shows progress. A same-name object prompts for overwrite confirmation. A large file uses multipart upload automatically. The per-file limit is configurable.
- API: `PUT /api/buckets/{id}/object?key=<key>` (A). Multipart: POST to start, PUT for a part, POST to complete, DELETE to abort (A).
- Garage: S3 `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`.

Acceptance: While a 1 GB file is uploading, server resident memory grows by at most 64 MB. After cancel, the multipart upload is aborted.

## 5.4 Delete

- Requirement: Delete one object, batch-delete a multi-selection (at most 1000 keys per call), and recursively delete a folder (see 4.3 of [correctness.md](correctness.md)). Each one requires a confirmation dialog.
- API: `DELETE /api/buckets/{id}/object?key=<key>[&recursive=true]`; `POST /api/buckets/{id}/objects:delete` (`keys[]`) (A).
- Garage: S3 `DeleteObject`, `DeleteObjects`, `ListObjectsV2`.

Acceptance: A batch of 1001 keys returns 400. A partial failure is returned object by object.

## 5.5 Sharing

Not included in the minimum version. Permissions are in 3.10 of [security.md](security.md).

- Requirement: Generate a presigned GET link (1 hour, 24 hours, or 7 days). When the bucket has website access enabled, also give the public website address.
- API: `POST /api/buckets/{id}/share` (key, expires) (A, or a caller who has the share permission).
- Garage: S3 presigning (uses the public S3 address and region). The website address is generated from a configuration template (the template must contain `{bucket}`).

Acceptance: The generated link can be used to download within its validity period. After the link expires, Garage rejects it. The expired request returned HTTP 400 and S3 code InvalidRequest on dxflrs/garage:v2.3.0, and HTTP 400 and S3 code InvalidRequest on dxflrs/garage:v2.4.1. A record is visible in the audit log.

## 5.6 Bulk download

Not included in the minimum version.

- Requirement: Pack selected objects, or a folder, into a ZIP and download it as a stream. First exchange a one-time token (valid for 60 seconds, usable only once, bound to the user and the bucket), then download. Inside the ZIP, drop the common prefix, clean path traversal and drive letters, and append a sequence number when names collide. When a single object fails, write an error-list file inside the ZIP.
- API: `POST /api/buckets/{id}/archive-token` (A, or a V who has the download permission); `GET /api/buckets/{id}/archive?token=` (the same callers).
- Garage: S3 `GetObject`.

Acceptance: A read-only user without the download permission gets 403 when exchanging a token. A second use of a token returns 404. Another user using the token returns 403. A key that contains `../` is cleaned inside the ZIP. When packing 1000 objects, the process peak memory grows by at most 64 MB.

## 5.14 Clean up incomplete uploads

Not included in the minimum version.

- Requirement: On the bucket detail page, list incomplete multipart uploads (key, uploadId, start time). Abort one, or abort all. Provide "clean up incomplete uploads older than N hours".
- API: `GET /api/buckets/{id}/multipart`; `DELETE /api/buckets/{id}/multipart`; `POST /api/buckets/{id}/cleanup-uploads` (`olderThanSecs`).
- Garage: S3 `ListMultipartUploads`, `AbortMultipartUpload`; Admin `CleanupIncompleteUploads`.

Acceptance: After cleanup, entries older than the threshold no longer appear in the list, and the response returns the number cleaned up.

## 5.16 CORS and lifecycle

Not included in the minimum version.

- Requirement: In bucket settings, edit CORS rules (ID, allowed origins, methods, headers, exposed headers, max-age seconds) and lifecycle rules (ID, enabled state, exactly one of expiry days or an expiry date, a prefix filter and lower and upper object-size filters, and the number of days after which an incomplete upload is aborted). Validate the form. Show the diff before saving.
- Note: Writes go through Admin `UpdateBucket` (the S3 API of the same name acts on the same configuration). `corsRules` and `lifecycleRules` are replaced as a whole set. Omitting a set means no change. Passing an empty array clears it. On a concurrent edit, show the diff against the version read again just before save.
- API: `GET`/`PUT /api/buckets/{id}/cors`; `GET`/`PUT /api/buckets/{id}/lifecycle`.
- Garage: `GetBucketInfo` (`corsRules`, `lifecycleRules`) and `UpdateBucket` (`corsRules`, `lifecycleRules`). Both are available from v2.3.0 on.

Acceptance: After a save, `GetBucketInfo` returns the same values. A browser cross-origin preflight matches the configuration. This project's own `/api` does not allow cross-origin access. See 3.6 of [security.md](security.md).

## 5.17 Website access

- Requirement: Turn website access on or off. Set the index document and the error document. When turning it on, the confirmation dialog says the data will become public. Show the public address from the template.
- API: `PUT /api/buckets/{id}/website`.
- Garage: `UpdateBucket.websiteAccess` (`enabled`, `indexDocument`, `errorDocument`. There is also `routingRules`. This round displays it read-only, does not offer an editor, and sends the original value back unchanged on save).

Acceptance: After it is turned on, the public address can be reached. After it is turned off, the response is Garage's denial response.

8.1 of [scope.md](scope.md) does not list website access as required for the minimum version. The exclusion list in 8.2 does not name 5.17 either. The dedicated editor and update route remain unscheduled in [roadmap.md](roadmap.md). This requirement and its acceptance stay as written.

## 5.18 Quotas

- Requirement: Set or clear the bucket maximum size (`maxSize`) and the maximum object count (`maxObjects`). Show the current usage.
- API: `PUT /api/buckets/{id}/quotas`.
- Garage: `UpdateBucket.quotas`.
- Note: `quotas` on `UpdateBucket` is replaced as a whole. Omitting `quotas` means no change. When `quotas` is sent, both `maxSize` and `maxObjects` are written. Null clears that field. When the frontend changes one field, it must also send the current value of the other field.

Acceptance: Changing only `maxSize` leaves `maxObjects` at its original value. Setting both to null clears the quota. Converting capacity units loses no precision.

## 5.19 Permissions

- Requirement: List the keys on a bucket and their read/write/owner permissions. Grant and revoke (validation is in 4.6 of [correctness.md](correctness.md); after a revoke, credential-cache invalidation is in 4.2).
- API: `POST`/`DELETE /api/buckets/{id}/permissions`.
- Garage: `AllowBucketKey`, `DenyBucketKey`, `GetBucketInfo`.

Acceptance: After a revoke, the UI matches Garage.

## 5.24 S3 features this project explicitly does not support

Garage does not support the following features, or it returns only a fixed value. This project's UI offers no entry for them, and the related docs say so.

- Object versioning (`ListObjectVersions` returns not implemented. Only the versioning state can be read, and it is always disabled).
- Object Lock, a retention-period lock, and a legal hold.
- Bucket policies and object ACLs (permissions are granted only through a Garage key).
- Server-side encryption configuration (SSE-C is the exception. This project does not provide a management UI for it).
- Bucket replication, requester pays, object-tag management, switching storage class, and event notifications.

Acceptance: The UI has none of the entries above. The "Known limitations" section of the docs lists them.
