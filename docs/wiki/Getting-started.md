# Getting started

You need a running Garage cluster, its admin API address and token, and its S3 API address and region. The admin and S3 APIs are separate services. On the repository's local Garage example they use ports **3903** and **3900**, respectively.

This development version requires a source build. Do not assume that a public container tag or downloadable release is available.

## Build the application

Install the Rust toolchain from [rust-toolchain.toml](https://github.com/xjoker/garage-ui/blob/dev/rust-toolchain.toml) and the Bun version from [web/package.json](https://github.com/xjoker/garage-ui/blob/dev/web/package.json). Clone the development branch, then build from the repository root:

```sh
git clone --branch dev https://github.com/xjoker/garage-ui.git
cd garage-ui
scripts/build.sh
```

This installs the locked frontend dependencies, builds the browser assets, and builds `target/release/garage-ui`. The browser bundle is embedded in the binary. Bun is a build tool, not a production runtime. Keep the frontend build before the Rust build so the binary includes current assets.

## Connect to an existing local Garage

Save the actual Garage admin token to `$HOME/.config/garage-ui/admin-token` outside your checkout, readable only by the account running the UI. If you use another location, set `API_ADMIN_KEY_FILE` to that file's absolute path. For a Garage instance using the example ports and `garage` region:

```sh
export API_ADMIN_KEY_FILE="$HOME/.config/garage-ui/admin-token"
export GARAGE_ADMIN_URL=http://127.0.0.1:3903
export S3_ENDPOINT_URL=http://127.0.0.1:3900
export S3_REGION=garage
export COOKIE_SECURE=false
./target/release/garage-ui
```

The token file must exist before starting the binary. Alternatively, supply the actual token through `GARAGE_ADMIN_TOKEN`. Keep secrets outside shell history and version control. `COOKIE_SECURE=false` is for this local HTTP example; use the default `true` behind HTTPS.

The binary listens on **127.0.0.1:3909** by default. Open [the local UI](http://127.0.0.1:3909). If you use different Garage addresses or a different region, change the values to match your cluster. v2.3.0 and v2.4.1 require an explicit S3 endpoint and region because they lack the newer discovery fields.

For the repository's bundled Garage example and Kubernetes deployments, follow [Deployment](Deployment.md).

## Create the first administrator

1. On the setup screen, enter a username and password.
2. Choose **Create administrator**.
3. When signed in, open **Overview** and check cluster health. Open **Settings** to change your own password or appearance.

Usernames are 1–64 characters, without spaces, control characters, or semicolons. ASCII username case is ignored for uniqueness. Passwords need at least 10 characters, no more than 72 UTF-8 bytes, and cannot be blank. Use a long, unique password.

Setup is available only while the UI database contains no users. To pre-create an account or recover access, see [Users and authentication](Users-and-authentication.md#recover-access-from-the-command-line).

## Make the first storage operation

1. Open **Buckets**, choose **Create**, enter a global alias, and choose **Create bucket**.
2. Open **Keys**, create an S3 access key, and save its secret securely.
3. Open the bucket's **Permissions** tab, choose the key, and grant the required **Read**, **Write**, and **Owner** permissions.
4. Open the bucket's **Objects** tab. If prompted for **Bucket key**, select an eligible key and choose **Use this key**.
5. Choose a small file in **Choose files**. Wait for **Done**, then select the object to inspect its metadata or download it.

If the list fails, check [Configuration](Configuration.md#connect-object-operations) and [Troubleshooting](Troubleshooting.md). A working admin API alone does not establish that object operations are configured.
