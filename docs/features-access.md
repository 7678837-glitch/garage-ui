# Identity, keys, tokens, and audit

Role abbreviations: A = administrator, V = read-only.

## 5.7 Keys

- Requirement: A paginated list. Create (a new name is limited to letters, digits, `_`, and `-`. The name of an imported key, or of a key that already exists, is shown as-is and is not validated). Import. Rename. Set an expiration time, or set the key to never expire (`neverExpires`). A switch for allowing bucket creation (`allow.createBucket`). Delete. View the secret (A, a second confirmation, and an audit record).
- API: `GET`/`POST /api/keys`; `GET`/`PATCH`/`DELETE /api/keys/{id}`; `POST /api/keys/import`; `POST /api/keys/{id}/secret` (A).
- Garage: `ListKeysInfo` or `ListKeys`, `GetKeyInfo`, `CreateKey`, `ImportKey`, `UpdateKey` (`name`, `expiration`, `allow.createBucket`, `deny.createBucket`), `DeleteKey`.

Acceptance: After allowing bucket creation is turned on, that key can create a bucket through S3. After the key is deleted, the browse credential cache is invalid (see 4.2 of [correctness.md](correctness.md)).

The key scope of the minimum version follows 8.1 of [scope.md](scope.md): paginated list, create, delete, rename, allow bucket creation, and view the secret. Import and expiration remain requirements of this section beyond that minimum. 8.1 states that the minimum-version scope is fixed by that table. When accepting the minimum version, those 8.1 items are what counts.

## 5.15 Restricted admin tokens

Not included in the minimum version.

- Requirement: List, create, update, and delete Garage admin tokens (`name`, `expiration`, `scope`). On create, the secret is shown only once. A token whose scope contains `CreateAdminToken` or `*` is clearly warned as equivalent to full authority. Show the information of the token this project is currently using. A scope value is an Admin API endpoint name, `Metrics`, or `*`. `ListAdminTokens` lists `admin_token` and `metrics_token` from the configuration file as read-only entries. The UI labels them "from the configuration file" and does not offer update or delete.
- API: `GET`/`POST /api/admin-tokens`; `GET`/`PATCH`/`DELETE /api/admin-tokens/{id}`; `GET /api/admin-tokens/current`.
- Garage: `ListAdminTokens`, `GetAdminTokenInfo`, `CreateAdminToken`, `UpdateAdminToken`, `DeleteAdminToken`, `GetCurrentAdminTokenInfo`.

Acceptance: Only an administrator can see them. A token secret does not appear in any later response or in the logs.

## 5.20 Multiple users and roles

- Requirement: An SQLite user store. A setup wizard. Roles `admin` and `viewer`, plus "download object content" and "share" permissions that can be assigned to a viewer (the data model and the constraints are in 3.19 of [security.md](security.md)). Create, delete, and update users, disable a user, rename a user, and reset a password. Lockout protection (you cannot delete, demote, or disable yourself, and you cannot remove the last enabled administrator). An offline CLI (list users, reset a password, create an administrator, version, health check). On first start, bcrypt accounts from environment variables may be imported once.
- API: `GET`/`POST /api/users`; `PATCH`/`DELETE /api/users/{id}`; `POST /api/users/{id}/reset-password`; `POST /api/auth/login|logout|change-password`; `GET /api/auth/status`; `GET`/`POST /api/setup`.
- Garage: none.

Acceptance: Tests cover granting a permission bit, revoking one, and the "share depends on download" constraint. Each lockout-protection rule has a test. A user response never contains a hash. A role change takes effect immediately (3.4).

The minimum version includes the account items in 8.1, and user create and delete, disable, role change, password reset, and lockout protection. The offline CLI is outside the minimum-version account scope and is implemented; see the [account guide](wiki/Users-and-authentication.md). A logged-in administrator calling `POST /api/users/{id}/reset-password` is part of that user management. It is a different path from the offline CLI in 3.18.

## 5.21 Audit log

- Requirement: Every write (including writes that were rejected), login-related events, viewing a secret, and generating a share link are written to the audit table. Fields: time, user, IP, method, path, target resource (bucket ID, key, node ID, and other resource identifiers of the same kind), result status code, and reason. Optionally also write to standard output (JSON lines). The UI provides filters (user, time range, action type) and CSV export. The retention period is configurable (default 90 days).
- API: `GET /api/audit?user&from&to&action&offset&limit` (A); `GET /api/audit/export` (A).
- Garage: none.

Acceptance: Each kind of event has one integration test that asserts an audit record. Records past the retention period are cleaned up on a schedule.

The minimum version includes audit writes (login-related events are in 3.13; writes and viewing a secret are written to the audit table). The audit page, filters, export, and configurable automatic retention are requirements beyond that minimum; see the [implemented audit behavior](wiki/Audit.md). Retention is configured on the server, without a retention control in the audit UI. The minimum version must still write the records into the table, and it must meet "after a failed login, the audit table has one record that includes the IP".

## 5.23 Settings and About

- Requirement: Change your own password, switch the theme, and show the version. The update check is off by default, and its source is configurable (4.14 of [correctness.md](correctness.md)).

Acceptance: When the update check is not turned on, there is no outbound request.

## 5.31 Showing and copying credentials

- Requirement: After a key or an admin token is created, show the full credential once in the result dialog. Provide one-click copy (a successful copy has visible feedback) and an "I have saved it" confirmation. After the dialog is closed, an admin token cannot be viewed again. An S3 secret requires the second confirmation again.
- Credential fields are masked by default. Showing one requires an explicit click. In a non-secure context, copy degrades to text that can be selected.
- How this relates to 3.15: 3.15 constrains the token this project itself uses to connect to Garage. That token never enters the browser. An admin token or S3 secret that a user creates in the UI is a result to hand to that user. It may appear only in the one response that creates it, or in the one response that views it after a second confirmation. That response sets `no-store`. It is not written into logs or into audit content.

Acceptance: After the dialog is closed, the admin-token secret no longer appears in the response or on the page. The copy button has a component test.

The minimum version includes the behavior in this item for creating a key and for viewing an S3 secret. One-time display of an admin token is delivered with 5.15.

## 5.34 Admin-token scope picker

Depends on 5.15. Not included in the minimum version.

- Requirement: When creating or editing an admin token, list Admin API endpoint checkboxes grouped by function (cluster, node, layout, bucket, key, permission, Worker, block, admin token). A whole group can be checked at once. Checking "all", or including permission to create an admin token, shows a prominent warning that the result is equivalent to full authority. An expiration time can be set (including "never expires", which needs an extra confirmation).

Acceptance: The groups cover all 46 endpoints of Garage v2.4.1, plus `Metrics` (a test checks them against the OpenAPI file). A full-authority combination shows the warning.
