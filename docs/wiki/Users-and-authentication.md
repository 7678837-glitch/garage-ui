# Users and authentication

Garage UI accounts are local to the UI database. They are separate from Garage S3 keys. Authentication cannot be disabled.

## Sign in and change your password

Enter **Username** and **Password**, then choose **Log in**. The browser receives an HttpOnly `garage_session` cookie; the Garage admin token remains on the server.

In **Settings → Change password**, enter **Current password** and **New password**, then choose **Change password**. A successful change displays **Password updated** and replaces the current login session. Other sessions for the account are invalidated. Use **Log out** when finished on a shared device.

Sessions normally expire after 24 hours absolute age or two hours idle time. A login screen after expiry is expected; sign in again. The operator can configure both durations.

## Choose roles and content permissions

| Account | Can do |
|---|---|
| Administrator | Manage buckets, keys, objects, users, tokens, audit, layout, and maintenance; read and share content |
| Viewer | Read overview, bucket/key information, and object listings/metadata; change own password |
| Viewer with Download | Also read previews/thumbnails and download objects/ZIPs |
| Viewer with Download and Share | Also issue share links when the public S3 address is configured |

**Share** alone is insufficient: a viewer also needs **Download**. UI roles restrict console operations; they do not replace the Garage permissions of the S3 key used by the server.

## Manage accounts as an administrator

1. Open **Users**, choose **Create user**, and enter a username, password, role, and any viewer Download/Share permissions.
2. Choose **Create user** and wait for **User created**.
3. Use the user's row controls to change **Role**, **Download**, **Share**, or **Disabled**. Review the saved state before leaving.
4. To reset another account, enter its new password and choose **Reset password**. Give the password to the user through a secure channel.

To remove an account, choose its **Delete** action and review the confirmation. Existing sessions for that account lose access.

Usernames are unique without regard to ASCII case, 1–64 characters long, and cannot contain spaces, control characters, or semicolons. Passwords need at least 10 characters and no more than 72 UTF-8 bytes; they cannot be blank. Use a long unique password within that limit.

Role changes and disabling an account invalidate its sessions. Download/Share changes are enforced on subsequent requests; removing Download also invalidates unused ZIP tokens. A password reset invalidates the account's sessions too. You cannot disable, demote, or delete yourself through user administration. The last enabled administrator is protected. Use your own **Settings** to change your password instead of the administrator reset control.

Use filtering, sorting, and pagination to find accounts. Filtering and sorting apply to the current page.

## Recover access from the command line

Run the built binary with the same `DATA_DIR` and environment used by the service. The commands open that UI database directly; they do not call Garage.

```sh
./target/release/garage-ui users
./target/release/garage-ui user reset-password admin
./target/release/garage-ui user create-admin recovery-admin
```

Replace `admin` with an existing username when resetting. Password commands read **one line from standard input**. They do not accept a password argument or `--password` option. Enter the new password and press Enter; take care that the terminal input may be visible. Use a trusted terminal or feed stdin from a secure password source without putting the password in command history.

`users` lists usernames, roles, and disabled status. A reset changes the password and invalidates sessions while preserving role, permission flags, and disabled state. It does not enable a disabled user. `create-admin` creates a new administrator and rejects an existing username.

For an empty database, operators may instead configure `GARAGE_UI_BOOTSTRAP_USERNAME` together with `GARAGE_UI_BOOTSTRAP_PASSWORD_HASH` using a bcrypt hash. Both are required. They are imported only when no users exist; startup does not overwrite existing users. Preserve the database so restarts do not reopen initial setup.
