# Correctness requirements

Each item states the requirement, then the acceptance criteria. The default priority is P1, except where an item is marked otherwise.

## 4.1 Address buckets by bucket ID, not by a global alias (P0)

- Requirement: Every bucket API (detail, browse, upload, delete, share, permissions) addresses the bucket by its Garage bucket ID. An alias is for display only. A bucket that has only a local alias, or no global alias at all, must still support the full set of operations.

Acceptance: Create a bucket that has only a local alias. Browse, upload, and delete succeed. An alias that contains `&` or `=` does not affect the operation.

## 4.2 Credential cache and permission revocation take effect promptly

Requirement:

1. The S3 credentials used to browse objects prefer a key reserved for this project (configurable). Only when that key is absent does an administrator explicitly choose one for the bucket. The product no longer implicitly picks an arbitrary read-write key.
2. When no usable credential can be found, do not cache an empty result. Return a clear error at once (412, with the message "This bucket has no usable read-write key").
3. The credential-cache TTL is at most 60 seconds. After this project runs `AllowBucketKey`, `DenyBucketKey`, `DeleteKey`, or `UpdateKey`, clear the related cache immediately.
4. When S3 returns 403, clear the cache and retry once.

Acceptance: After a key is revoked, the next browse does not use that key. Grant access when there was no key, and browse works immediately.

## 4.3 Recursive delete pages until every object is deleted (P0)

- Requirement: When deleting a "folder", list every object under the prefix, one page at a time (at most 1000 per page), and call batch delete in batches until the listing is finished. Return the deleted count and a per-object error list (the error list is always an array). On a partial failure, return 207, or 200 plus the error details. Do not report "all succeeded".

Acceptance: All 2500 objects under the prefix are deleted, and the response is `deleted=2500`. When 3 of those objects are injected as failures, the response contains 3 errors.

## 4.4 Capacity precision (P0)

- Requirement: Node capacity uses bytes as the internal unit. Display it in the unit the user chose, with at least two decimal places. When the edit form writes the value back, do not round half up and do not floor it to an integer unit. A node whose capacity was not changed must not be rewritten.

Acceptance: Open the editor for a 1.8 TB node, save with no changes, and the `capacity` submitted to `UpdateClusterLayout` is byte-for-byte equal to the original value.

## 4.5 URL-encode object keys

- Requirement: When the frontend builds a path, encode the key by segment. The backend decodes it and passes the original value to S3. Write the download filename into `Content-Disposition` with RFC 5987 encoding. A folder name forbids only control characters and `/`. `=`, `#`, `?`, `%`, spaces, and non-ASCII characters are allowed.

Acceptance: Objects named `a?b#c%20d=e` and 中文名 can be browsed, previewed, downloaded, deleted, and shared.

## 4.6 Validate when assigning a key

- Requirement: In the grant dialog, the submit button is disabled when no key is selected or no permission is checked. When the request fails, show the error. Do not report success.

Acceptance: Frontend component tests cover both "empty selection" and "request failure".

## 4.7 Do not write a success response after a request error

- Requirement: Every handler stops immediately after it writes an error response. It must not write a status code again or append to the response body. Use one response helper. A repeated write fails immediately in test mode.

Acceptance: When `HeadObject` fails, the response body contains only the error JSON, and the log has no duplicate-write warning.

## 4.8 Preserve the real status code

- Requirement: When Garage or S3 returns a non-JSON error body, pass through the original status code and place the truncated text in the unified error structure. A missing object returns 404, not 500.

Acceptance: When Garage returns 403 as plain text, this project returns 403. HEAD of a missing object returns 404.

## 4.9 Trailing slash on endpoint URLs

- Requirement: When parsing `API_BASE_URL`, `S3_ENDPOINT_URL`, and `S3_PUBLIC_ENDPOINT_URL`, strip a trailing slash. Join paths with a URL join function. A value that contains only slashes counts as unset.

Acceptance: With and without a trailing slash on the configured value, the request targets the same address.

## 4.10 Handling of upload temporary files

- Requirement: An upload streams to S3 by default and does not land in a temporary file. When it must be written to disk, write it only in the configurable temporary directory (`/data/tmp` inside the image, or a mounted tmpfs). Delete it when the request ends, on success or on failure. A large file uses S3 multipart upload. Abort the multipart upload on failure.

Acceptance: With the upload limit set to at least 3 GB, a 2 GB upload succeeds in a container whose root filesystem is read-only. After a disconnect midway, no temporary file and no incomplete multipart upload remain (or the incomplete upload is visible under "incomplete uploads" and can be cleaned up).

## 4.11 Concurrency cap

- Requirement: Every fan-out call to Garage (per-bucket detail, per-node info) uses bounded concurrency. The default is 8, and it is configurable. The frontend upload queue defaults to 3 concurrent uploads.

Acceptance: With 1000 buckets, at most 8 `GetBucketInfo` requests are in flight at the same time.

## 4.12 BASE_PATH handling

- Requirement: A subpath deployment uses relative asset paths in the build output, and the server injects the base metadata. Do not replace strings inside JS text. Normalize `BASE_PATH` so that it starts with `/` and does not end with `/`. A request to the root path returns 301 to `BASE_PATH`. The cookie `Path` follows `BASE_PATH`. Compute the injected value once at startup.

Acceptance: Under both `BASE_PATH=/admin` and an empty value, refreshing any deep route loads, and no static asset returns 404.

## 4.13 Strip newlines when reading a secret file

- Requirement: Every sensitive setting supports a `*_FILE` variant (`API_ADMIN_KEY_FILE`, `METRICS_TOKEN_FILE`, S3 credential files, and the same pattern for the other sensitive settings). The `_FILE` variant takes priority. After a read, strip trailing CR/LF and keep the content in the middle. Read once at startup. On a read failure, the error includes only the path and does not print the contents.

Acceptance: When the file ends with CRLF, the Bearer header is correct. When the file does not exist, startup fails and the error text contains no secret.

## 4.14 The update source is configurable

- Requirement: The update check is off by default. Configuration or build parameters set both the check address and the release-signing public key. They belong to this project's own release source. When they are not configured, hide the feature.

Acceptance: When no update source is configured, the product makes no outbound request.

## 4.15 Other

- A config file that fails to parse behaves the same as a missing file. Both cases log a warning and fall back to environment variables. When a required item is missing, report a clear startup error. Do not exit by crashing.
- The auth-status API returns whether the caller is logged in. It must not be constantly true.
- The `Content-Type` a thumbnail declares matches the actual encoding.
- Read the S3 endpoint and region from configuration first. When Garage provides `GetNodeInfo.connectionParameters` (the main-v2 capability probe), that value may fill them in.
- Use the endpoint configuration that `aws-sdk-s3` currently recommends, so the deprecation warning is gone.
