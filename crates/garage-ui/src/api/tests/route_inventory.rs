    // Every route under /api/ with the way a tenant account (docs/security.md 3.19 and 3.20)
    // meets it. A new route must be added here: `inventory_matches_the_routes_in_the_source`
    // fails until it is, and the class then makes the tenant tests below exercise it.
    #[derive(Clone, Copy, PartialEq, Debug)]
    enum InventoryClass {
        // A tenant gets 403 whatever the bucket.
        Denied,
        // A tenant gets 404 on a bucket its key does not hold, and on a granted bucket every S3
        // request is signed with its key. The number is the status a granted bucket answers.
        BucketScoped(u16),
        // Every signed-in account may use it; the tenant check does not apply.
        Open,
    }

    struct InventoryRow {
        method: &'static str,
        path: &'static str,
        class: InventoryClass,
    }

    fn inventory() -> Vec<InventoryRow> {
        use InventoryClass::{BucketScoped, Denied, Open};
        let rows: [(&str, &str, InventoryClass); 79] = [
            ("POST", "/api/setup", Open),
            ("GET", "/api/auth/status", Open),
            ("POST", "/api/auth/login", Open),
            ("POST", "/api/auth/logout", Open),
            ("POST", "/api/auth/change-password", Open),
            ("GET", "/api/config", Open),
            ("GET", "/api/capabilities", Open),
            ("GET", "/api/buckets", Open),
            ("GET", "/api/users", Denied),
            ("POST", "/api/users", Denied),
            ("PATCH", "/api/users/{id}", Denied),
            ("DELETE", "/api/users/{id}", Denied),
            ("POST", "/api/users/{id}/reset-password", Denied),
            ("POST", "/api/buckets", Denied),
            ("GET", "/api/buckets/{id}", BucketScoped(200)),
            ("DELETE", "/api/buckets/{id}", Denied),
            ("POST", "/api/buckets/{id}/aliases", Denied),
            ("DELETE", "/api/buckets/{id}/aliases", Denied),
            ("PUT", "/api/buckets/{id}/quotas", Denied),
            ("GET", "/api/buckets/{id}/cors", BucketScoped(200)),
            ("PUT", "/api/buckets/{id}/cors", Denied),
            ("GET", "/api/buckets/{id}/lifecycle", BucketScoped(200)),
            ("PUT", "/api/buckets/{id}/lifecycle", Denied),
            ("GET", "/api/buckets/{id}/multipart", BucketScoped(200)),
            ("DELETE", "/api/buckets/{id}/multipart", BucketScoped(200)),
            ("POST", "/api/buckets/{id}/cleanup-uploads", Denied),
            ("PUT", "/api/buckets/{id}/credential", Denied),
            ("POST", "/api/buckets/{id}/permissions", Denied),
            ("DELETE", "/api/buckets/{id}/permissions", Denied),
            ("GET", "/api/buckets/{id}/objects", BucketScoped(200)),
            ("POST", "/api/buckets/{id}/objects:delete", BucketScoped(200)),
            ("GET", "/api/buckets/{id}/object", BucketScoped(200)),
            ("DELETE", "/api/buckets/{id}/object", BucketScoped(204)),
            ("PUT", "/api/buckets/{id}/object", BucketScoped(201)),
            ("GET", "/api/buckets/{id}/search", BucketScoped(200)),
            ("GET", "/api/buckets/{id}/inspect", Denied),
            ("POST", "/api/buckets/{id}/archive-token", BucketScoped(200)),
            ("GET", "/api/buckets/{id}/archive", BucketScoped(200)),
            ("POST", "/api/objects", Denied),
            ("GET", "/api/objects/preview", Denied),
            ("GET", "/api/objects/download", Denied),
            ("POST", "/api/share", BucketScoped(200)),
            ("GET", "/api/keys", Denied),
            ("POST", "/api/keys", Denied),
            ("GET", "/api/keys/{id}", Denied),
            ("PATCH", "/api/keys/{id}", Denied),
            ("DELETE", "/api/keys/{id}", Denied),
            ("POST", "/api/keys/{id}/secret", Denied),
            ("GET", "/api/admin-tokens", Denied),
            ("POST", "/api/admin-tokens", Denied),
            ("GET", "/api/admin-tokens/current", Denied),
            ("GET", "/api/admin-tokens/{id}", Denied),
            ("PATCH", "/api/admin-tokens/{id}", Denied),
            ("DELETE", "/api/admin-tokens/{id}", Denied),
            ("GET", "/api/cluster/health", Denied),
            ("GET", "/api/cluster/status", Denied),
            ("GET", "/api/cluster/statistics", Denied),
            ("GET", "/api/metrics", Denied),
            ("GET", "/api/nodes/{id}/statistics", Denied),
            ("GET", "/api/nodes/{id}/block-errors", Denied),
            ("GET", "/api/nodes/{id}/worker-variables", Denied),
            ("PUT", "/api/nodes/{id}/worker-variables", Denied),
            ("POST", "/api/nodes/{id}/blocks/purge", Denied),
            ("POST", "/api/nodes/{id}/blocks/retry", Denied),
            ("GET", "/api/nodes/{id}/blocks/{hash}", Denied),
            ("POST", "/api/nodes/{id}/repair", Denied),
            ("POST", "/api/nodes/{id}/metadata-snapshot", Denied),
            ("POST", "/api/cluster/connect", Denied),
            ("GET", "/api/layout/history", Denied),
            ("POST", "/api/layout/preview", Denied),
            ("POST", "/api/layout/apply", Denied),
            ("POST", "/api/layout/revert", Denied),
            ("POST", "/api/layout/skip-dead-nodes", Denied),
            ("POST", "/api/layout/stage", Denied),
            ("ANY", "/api/garage/{*path}", Denied),
            ("GET", "/api/nodes/{id}/workers", Denied),
            ("GET", "/api/nodes/{id}/workers/{wid}", Denied),
            ("GET", "/api/audit", Denied),
            ("GET", "/api/audit/export", Denied),
        ];
        rows.into_iter()
            .map(|(method, path, class)| InventoryRow {
                method,
                path,
                class,
            })
            .collect()
    }

    // axum does not expose its route table, so the inventory is checked against the source text.
    // The parser reads only what the `.route("<path>", get(h).post(h))` calls of this crate use.
    fn source_routes() -> std::collections::BTreeSet<(String, String)> {
        const METHODS: [&str; 7] = ["get", "post", "put", "patch", "delete", "head", "any"];
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/api");
        let mut found = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(&dir).expect("read src/api") {
            let path = entry.expect("dir entry").path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read source");
            // The whole file is scanned: cutting at a test module could hide a route declared
            // after a column-0 `#[cfg(test)]` item.
            let mut rest = text.as_str();
            while let Some(at) = rest.find(".route(") {
                let args = &rest[at + ".route(".len()..];
                // Parentheses inside string literals would unbalance the count, so skip them.
                let (mut depth, mut in_string, mut end) = (1_i32, false, None);
                for (index, c) in args.char_indices() {
                    match c {
                        '"' => in_string = !in_string,
                        '(' if !in_string => depth += 1,
                        ')' if !in_string => {
                            depth -= 1;
                            if depth == 0 {
                                end = Some(index);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                let end = end.unwrap_or_else(|| panic!("unterminated .route( in {path:?}"));
                let call = &args[..end];
                let opening = call.find('"').expect("route path") + 1;
                let closing = opening + call[opening..].find('"').expect("route path end");
                let route = &call[opening..closing];
                // Method routers are the identifiers directly followed by `(` outside any
                // other parentheses; handler names sit inside those and never count.
                let routers = &call[closing + 1..];
                let before = found.len();
                let mut depth = 0_i32;
                let mut word = String::new();
                for c in routers.chars() {
                    if c.is_ascii_alphanumeric() || c == '_' {
                        word.push(c);
                        continue;
                    }
                    if c == '(' {
                        if depth == 0 && METHODS.contains(&word.as_str()) {
                            found.insert((word.to_ascii_uppercase(), route.to_string()));
                        }
                        depth += 1;
                    } else if c == ')' {
                        depth -= 1;
                    }
                    word.clear();
                }
                // A method router this parser does not know would otherwise drop the route silently.
                assert!(
                    found.len() > before,
                    "no known method router in .route({route:?}) in {path:?}"
                );
                rest = &args[end..];
            }
        }
        found
    }

    #[test]
    fn inventory_matches_the_routes_in_the_source() {
        let listed: std::collections::BTreeSet<(String, String)> = inventory()
            .iter()
            .map(|row| (row.method.to_string(), row.path.to_string()))
            .collect();
        assert_eq!(listed.len(), inventory().len(), "duplicate inventory row");
        let source = source_routes();
        let unclassified: Vec<_> = source.difference(&listed).collect();
        let stale: Vec<_> = listed.difference(&source).collect();
        assert!(
            unclassified.is_empty() && stale.is_empty(),
            "routes missing from the inventory: {unclassified:?}; inventory rows without a route: {stale:?}"
        );
    }

    fn inventory_path(template: &str, bucket: &str) -> String {
        // Users are addressed by number; every other {id} is tried as the bucket.
        let id = if template.starts_with("/api/users/") {
            "1"
        } else {
            bucket
        };
        template
            .replace("{id}", id)
            .replace("{wid}", "w1")
            .replace("{hash}", "h1")
            .replace("{*path}", "v2/GetClusterHealth")
    }

    // A body that passes the route's own parsing, so a refusal can only come from access control.
    fn inventory_body(template: &str, bucket: &str) -> String {
        match template {
            "/api/share" => {
                json!({ "ttl_seconds": 60, "bucket": bucket, "key": "a.txt" }).to_string()
            }
            "/api/buckets/{id}/archive-token" | "/api/buckets/{id}/objects:delete" => {
                json!({ "keys": ["a.txt"] }).to_string()
            }
            "/api/buckets/{id}/cleanup-uploads" => json!({ "olderThanSecs": 0 }).to_string(),
            "/api/users" => {
                json!({ "username": "Eve", "password": "long enough pw", "role": "viewer" })
                    .to_string()
            }
            "/api/users/{id}/reset-password" => {
                json!({ "password": "long enough pw" }).to_string()
            }
            "/api/keys" => json!({ "name": "k" }).to_string(),
            "/api/buckets/{id}/credential" => json!({ "access_key_id": "GKtenant" }).to_string(),
            "/api/auth/login" => {
                json!({ "username": "Tess", "password": "tenant horse" }).to_string()
            }
            _ => "{}".to_string(),
        }
    }

    // A token the archive route accepts, or a placeholder when the tenant cannot get one.
    async fn inventory_archive_token(env: &TenantEnv, bucket: &str) -> String {
        let issued = exchange(
            &env.app,
            request(
                "POST",
                &format!("/api/buckets/{bucket}/archive-token"),
                Some(&json!({ "keys": ["a.txt"] }).to_string()),
                Some(&env.tenant),
            ),
        )
        .await;
        serde_json::from_str::<Value>(&issued.body)
            .ok()
            .and_then(|body| body["token"].as_str().map(str::to_string))
            .unwrap_or_else(|| "unissued".to_string())
    }

    // The requests a tenant sends to one row: one per behavior of the route.
    async fn inventory_requests(
        env: &TenantEnv,
        row: &InventoryRow,
        bucket: &str,
        session: &Session,
    ) -> Vec<(String, Request<Body>)> {
        let path = inventory_path(row.path, bucket);
        let body = inventory_body(row.path, bucket);
        let methods: &[&str] = if row.method == "ANY" {
            &["GET", "POST", "PUT", "PATCH", "DELETE"]
        } else {
            &[row.method]
        };
        let mut uris = vec![path.clone()];
        match row.path {
            "/api/buckets/{id}/object" => {
                uris = match row.method {
                    // Metadata, download, and thumbnail are different behaviors of one route.
                    "GET" => vec![
                        format!("{path}?key=a.txt"),
                        format!("{path}?key=a.txt&download=1"),
                        format!("{path}?key=photo.png&thumbnail=1"),
                    ],
                    "PUT" => vec![format!("{path}?key=up.txt")],
                    _ => vec![format!("{path}?key=old.txt")],
                };
            }
            "/api/buckets/{id}/search" => uris = vec![format!("{path}?q=abc")],
            "/api/buckets/{id}/inspect" => uris = vec![format!("{path}?key=a.txt")],
            "/api/buckets/{id}/archive" => {
                let token = inventory_archive_token(env, bucket).await;
                uris = vec![format!("{path}?token={token}")];
            }
            "/api/objects/preview" | "/api/objects/download" => {
                uris = vec![format!("{path}?name=x")];
            }
            _ => {}
        }
        let mut out = Vec::new();
        for method in methods {
            for uri in &uris {
                let label = format!("{method} {uri}");
                let call = if *method == "PUT" && row.path == "/api/buckets/{id}/object" {
                    put_bytes(uri, b"hello", Some("5"), session)
                } else if row.path == "/api/objects" {
                    Request::builder()
                        .method("POST")
                        .uri(uri)
                        .header("cookie", cookie_header(session))
                        .header("x-csrf-token", &session.csrf)
                        .header("content-length", "5")
                        .body(Body::from("hello"))
                        .unwrap()
                } else if *method == "GET" {
                    request("GET", uri, None, Some(session))
                } else {
                    request(method, uri, Some(&body), Some(session))
                };
                out.push((label, call));
            }
        }
        out
    }

    // Like `exchange`, for bodies that are not UTF-8 text (thumbnails, ZIP archives).
    async fn inventory_send(env: &TenantEnv, call: Request<Body>) -> (StatusCode, String) {
        let response = router(env.app.clone()).oneshot(call).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn tenant_is_denied_every_denied_route_on_granted_and_ungranted_buckets() {
        let env = tenant_env(false, false).await;
        let mut refused = Vec::new();
        for row in inventory()
            .iter()
            .filter(|row| row.class == InventoryClass::Denied)
        {
            for bucket in ["b1", "b3"] {
                for (label, call) in inventory_requests(&env, row, bucket, &env.tenant).await {
                    let (status, body) = inventory_send(&env, call).await;
                    if status != StatusCode::FORBIDDEN || code_of(&body) != "forbidden" {
                        refused.push(format!("{label}: {status} {body}"));
                    }
                }
            }
        }
        assert!(refused.is_empty(), "not denied with 403 forbidden:\n{}", refused.join("\n"));
        assert!(env.s3.seen().is_empty(), "{:?}", env.s3.lines());
        // The only Admin API calls a tenant causes are the link check and its own key lookup.
        let lines = env.garage.lines();
        assert!(
            lines
                .iter()
                .all(|line| line.contains("/v2/GetNodeInfo") || line.contains("/v2/GetKeyInfo")),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn tenant_gets_404_on_every_bucket_scoped_route_of_an_ungranted_bucket() {
        let env = tenant_env(false, false).await;
        for row in inventory()
            .iter()
            .filter(|row| matches!(row.class, InventoryClass::BucketScoped(_)))
        {
            let s3_before = env.s3.seen().len();
            let garage_before = env.garage.lines().len();
            for (label, call) in inventory_requests(&env, row, "b3", &env.tenant).await {
                let (status, body) = inventory_send(&env, call).await;
                assert_eq!(status, StatusCode::NOT_FOUND, "{label}: {body}");
                assert_eq!(code_of(&body), "not_found", "{label}: {body}");
            }
            assert_eq!(env.s3.seen().len(), s3_before, "{} {}", row.method, row.path);
            let garage = env.garage.lines();
            assert!(
                garage[garage_before..].iter().all(|line| !line.contains("b3")),
                "{} {}: {garage:?}",
                row.method,
                row.path
            );
        }
    }

    #[tokio::test]
    async fn tenant_s3_requests_on_a_granted_bucket_are_signed_with_the_tenant_key() {
        let env = tenant_env(false, false).await;
        let mut shared_url = None;
        for row in inventory().iter() {
            let InventoryClass::BucketScoped(expected) = row.class else {
                continue;
            };
            for (label, call) in inventory_requests(&env, row, "b1", &env.tenant).await {
                let (status, body) = inventory_send(&env, call).await;
                assert_eq!(status.as_u16(), expected, "{label}: {body}");
                if row.path == "/api/share" {
                    shared_url = serde_json::from_str::<Value>(&body).unwrap()["url"]
                        .as_str()
                        .map(str::to_string);
                }
            }
        }
        let seen = env.s3.seen();
        assert!(seen.len() >= 10, "{:?}", env.s3.lines());
        for call in &seen {
            assert_eq!(signing_key(call), TENANT_KEY, "{}", call.line);
            assert!(!call.authorization.contains("PROJECT"), "{}", call.line);
        }
        let url = shared_url.expect("the share row returns a URL");
        assert!(url.contains(&format!("X-Amz-Credential={TENANT_KEY}")), "{url}");
        assert!(!url.contains("PROJECT"), "{url}");
    }

    #[tokio::test]
    async fn open_routes_are_not_gated_by_the_tenant_check() {
        let env = tenant_env(false, false).await;
        for row in inventory()
            .iter()
            .filter(|row| row.class == InventoryClass::Open)
        {
            // Logout and login end or replace a session, so every row gets its own.
            let session = sign_in(&env.app, "Tess", "tenant horse").await;
            for (label, call) in inventory_requests(&env, row, "b1", &session).await {
                let (status, body) = inventory_send(&env, call).await;
                let code = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|value| value["code"].as_str().map(str::to_string))
                    .unwrap_or_default();
                assert!(
                    code != "forbidden" && code != "tenant_key_unavailable",
                    "{label}: {status} {body}"
                );
                assert!(status.as_u16() < 500, "{label}: {status} {body}");
            }
        }
        assert!(env.s3.seen().is_empty(), "{:?}", env.s3.lines());
    }
