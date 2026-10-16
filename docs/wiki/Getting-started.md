# Getting started

The recommended installation is **Docker Compose**. Follow the [three-step quick start](https://github.com/xjoker/garage-ui/blob/dev/README.md#quick-start-docker-compose): download two small deployment files, enter your existing Garage connection, and start the container. Docker chooses the correct Linux architecture; no source checkout, compiler, or frontend build is required.

You need a running Garage v2.3.0 or later cluster, its Admin API URL and token, and its S3 API URL and region. The Admin and S3 APIs are separate services, usually on ports **3903** and **3900**. Use addresses reachable from the UI container; its `localhost` is not your host or another container.

If you do not have Garage yet, use the [bundled local demo](Deployment.md#try-the-bundled-local-garage-demo). For HTTPS, standalone binaries, Kubernetes, or backups, see [Deployment](Deployment.md).

Once the container starts, open **[http://localhost:3909](http://localhost:3909)** on the Docker host. The UI has its own accounts; a Garage token or S3 key is not a UI login.

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
