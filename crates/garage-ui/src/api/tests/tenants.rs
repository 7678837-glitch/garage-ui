    const TENANT_KEY: &str = "GKtenant";
    const TENANT_SECRET: &str = "tenant-secret-value";

    #[derive(Clone)]
    struct Seen {
        line: String,
        authorization: String,
    }

    // Records the request line and Authorization header of every request it serves.
    struct TenantServer {
        url: String,
        seen: Arc<Mutex<Vec<Seen>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TenantServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl TenantServer {
        async fn start(reply: impl Fn(&Seen) -> Vec<u8> + Send + Sync + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let seen_task = Arc::clone(&seen);
            let reply = Arc::new(reply);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let seen = Arc::clone(&seen_task);
                    let reply = Arc::clone(&reply);
                    tokio::spawn(async move {
                        let mut buf = Vec::new();
                        let mut tmp = [0_u8; 4096];
                        let header_end = loop {
                            let Ok(Ok(read)) =
                                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut tmp))
                                    .await
                            else {
                                return;
                            };
                            if read == 0 {
                                return;
                            }
                            buf.extend_from_slice(&tmp[..read]);
                            if let Some(pos) =
                                buf.windows(4).position(|window| window == b"\r\n\r\n")
                            {
                                break pos;
                            }
                        };
                        let text = String::from_utf8_lossy(&buf[..header_end]).into_owned();
                        let length = header_value(&text, "content-length")
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(0);
                        let mut have = buf.len() - header_end - 4;
                        while have < length {
                            let Ok(Ok(read)) =
                                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut tmp))
                                    .await
                            else {
                                return;
                            };
                            if read == 0 {
                                break;
                            }
                            have += read;
                        }
                        let call = Seen {
                            line: text.lines().next().unwrap_or("").to_string(),
                            authorization: header_value(&text, "authorization")
                                .unwrap_or("")
                                .to_string(),
                        };
                        seen.lock().expect("seen").push(call.clone());
                        let _ = socket.write_all(&reply(&call)).await;
                        let _ = socket.shutdown().await;
                    });
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                seen,
                task,
            }
        }

        fn seen(&self) -> Vec<Seen> {
            self.seen.lock().expect("seen").clone()
        }

        fn lines(&self) -> Vec<String> {
            self.seen().into_iter().map(|call| call.line).collect()
        }
    }

    // The access key ID a SigV4 request is signed with.
    fn signing_key(call: &Seen) -> &str {
        call.authorization
            .split_once("Credential=")
            .and_then(|(_, rest)| rest.split('/').next())
            .unwrap_or("")
    }

    fn json_http(status: &str, body: &Value) -> Vec<u8> {
        let body = body.to_string();
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn key_info() -> Value {
        let grant = |id: &str, read: bool, write: bool| {
            json!({
                "id": id,
                "globalAliases": [format!("name-{id}")],
                "localAliases": [],
                "permissions": { "read": read, "write": write, "owner": false },
            })
        };
        json!({
            "accessKeyId": TENANT_KEY,
            "name": "tenant",
            "expired": false,
            "permissions": { "createBucket": false },
            "secretAccessKey": TENANT_SECRET,
            "buckets": [grant("b2", true, false), grant("b1", true, true), grant("b4", false, false)],
        })
    }

    fn bucket_info(id: &str) -> Value {
        json!({
            "id": id,
            "created": "2026-10-11T00:00:00Z",
            "globalAliases": [format!("name-{id}")],
            "websiteAccess": false,
            "keys": [{
                "accessKeyId": "PROJECT",
                "name": "project",
                "permissions": { "read": true, "write": true, "owner": true },
                "bucketLocalAliases": [],
            }],
            "objects": 1,
            "bytes": 1,
            "unfinishedUploads": 0,
            "unfinishedMultipartUploads": 0,
            "unfinishedMultipartUploadParts": 0,
            "unfinishedMultipartUploadBytes": 0,
            "quotas": {},
        })
    }

    fn tenant_admin_reply(key_deleted: bool) -> impl Fn(&Seen) -> Vec<u8> + Send + Sync + 'static {
        move |call| {
            let target = request_target(&call.line);
            let path = target.split('?').next().unwrap_or("");
            match path {
                "/v2/GetNodeInfo" => json_http("200 OK", &json!({ "garageVersion": "v2.3.0" })),
                "/v2/GetKeyInfo" if key_deleted => json_http(
                    "404 Not Found",
                    &json!({ "code": "NoSuchAccessKey", "message": "gone" }),
                ),
                "/v2/GetKeyInfo" => json_http("200 OK", &key_info()),
                "/v2/GetBucketInfo" => match query_value(target, "id") {
                    Some(id @ ("b1" | "b2" | "b3")) => json_http("200 OK", &bucket_info(id)),
                    _ => json_http("404 Not Found", &json!({ "code": "NoSuchBucket" })),
                },
                _ => json_http("404 Not Found", &json!({ "code": "NotFound" })),
            }
        }
    }

    fn s3_forbidden() -> Vec<u8> {
        let body = "<Error><Code>AccessDenied</Code><Message>denied</Message></Error>";
        format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    // deny_tenant answers 403 to the tenant key only. The project key still succeeds.
    fn tenant_s3_reply(deny_tenant: bool) -> impl Fn(&Seen) -> Vec<u8> + Send + Sync + 'static {
        move |call| {
            if deny_tenant && signing_key(call) == TENANT_KEY {
                return s3_forbidden();
            }
            let line = call.line.as_str();
            let key = object_key_of(line);
            if line.starts_with("PUT ") {
                return put_ok("etag1").into_bytes();
            }
            if line.starts_with("DELETE ") {
                return delete_ok().into_bytes();
            }
            if key == "photo.png" {
                return png_object_http(line.starts_with("HEAD "));
            }
            if line.starts_with("HEAD ") {
                return head_ok().into_bytes();
            }
            if key.is_empty() {
                return list_xml(false, None, &[("a.txt", 5, "abc")], &[]).into_bytes();
            }
            object_bytes("text/plain", "hello plain").into_bytes()
        }
    }

    struct TenantEnv {
        app: App,
        admin: Session,
        tenant: Session,
        s3: TenantServer,
        garage: TenantServer,
    }

    async fn tenant_env(key_deleted: bool, deny_tenant: bool) -> TenantEnv {
        let garage = TenantServer::start(tenant_admin_reply(key_deleted)).await;
        let s3 = TenantServer::start(tenant_s3_reply(deny_tenant)).await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", garage.url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("S3_ENDPOINT_URL", s3.url.as_str()),
                ("S3_REGION", "garage"),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
                ("PUBLIC_S3_URL", "http://127.0.0.1:3901"),
            ],
            test_quota(),
        )
        .await;
        let (admin, _) = login(&app).await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Tess",
                        "password": "tenant horse",
                        "role": "viewer",
                        "can_download": true,
                        "can_share": true,
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let id = serde_json::from_str::<Value>(&created.body).unwrap()["id"]
            .as_i64()
            .unwrap();
        crate::db::set_user_access_key(&app.db, id, Some(TENANT_KEY))
            .await
            .unwrap();
        let tenant = sign_in(&app, "Tess", "tenant horse").await;
        TenantEnv {
            app,
            admin,
            tenant,
            s3,
            garage,
        }
    }

    // Like `exchange`, for responses whose body is not UTF-8 text (thumbnails).
    async fn binary_status(env: &TenantEnv, request: Request<Body>) -> StatusCode {
        let response = router(env.app.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        status
    }

    async fn tenant_get(env: &TenantEnv, uri: &str) -> Exchange {
        exchange(&env.app, request("GET", uri, None, Some(&env.tenant))).await
    }

    fn assert_not_found(response: &Exchange) {
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{}", response.body);
        assert_eq!(code_of(&response.body), "not_found", "{}", response.body);
    }

    fn bucket_ids(body: &str) -> Vec<String> {
        serde_json::from_str::<Value>(body).unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn only_a_viewer_with_a_bound_key_is_a_tenant() {
        let user = |role: &str, key: Option<&str>| crate::db::User {
            id: 1,
            username: "u".into(),
            password_hash: String::new(),
            role: role.into(),
            can_download: false,
            can_share: false,
            disabled: false,
            access_key_id: key.map(str::to_string),
        };
        assert!(user("viewer", Some("GK1")).actor().tenant);
        assert!(!user("viewer", None).actor().tenant);
        assert!(!user("admin", Some("GK1")).actor().tenant);
    }

    #[tokio::test]
    async fn tenant_lists_exactly_the_buckets_its_key_holds_a_permission_on() {
        let env = tenant_env(false, false).await;
        let all = tenant_get(&env, "/api/buckets").await;
        assert_eq!(all.status, StatusCode::OK, "{}", all.body);
        assert_eq!(bucket_ids(&all.body), ["b1", "b2"]);
        let parsed: Value = serde_json::from_str(&all.body).unwrap();
        assert_eq!(parsed["hasMore"], json!(false));
        assert!(parsed["items"][0].get("keys").is_none(), "{}", all.body);
        assert_eq!(parsed["items"][0]["globalAliases"], json!(["name-b1"]));

        let first = tenant_get(&env, "/api/buckets?limit=1").await;
        assert_eq!(bucket_ids(&first.body), ["b1"]);
        assert_eq!(
            serde_json::from_str::<Value>(&first.body).unwrap()["hasMore"],
            json!(true)
        );
        let second = tenant_get(&env, "/api/buckets?offset=1&limit=1").await;
        assert_eq!(bucket_ids(&second.body), ["b2"]);
        assert_eq!(
            serde_json::from_str::<Value>(&second.body).unwrap()["hasMore"],
            json!(false)
        );
        let past = tenant_get(&env, "/api/buckets?offset=2&limit=1").await;
        assert_eq!(bucket_ids(&past.body), Vec::<String>::new());
        assert!(env.s3.seen().is_empty());
        let lines = env.garage.lines();
        assert!(
            lines.iter().all(|line| !line.contains("id=b3")),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn tenant_bucket_detail_has_no_key_list_and_hides_other_buckets() {
        let env = tenant_env(false, false).await;
        let granted = tenant_get(&env, "/api/buckets/b1").await;
        assert_eq!(granted.status, StatusCode::OK, "{}", granted.body);
        let detail: Value = serde_json::from_str(&granted.body).unwrap();
        assert_eq!(detail["id"], json!("b1"));
        assert!(detail.get("keys").is_none(), "{}", granted.body);
        assert!(!granted.body.contains("PROJECT"), "{}", granted.body);

        let hidden = tenant_get(&env, "/api/buckets/b3").await;
        assert_not_found(&hidden);
        let permissionless = tenant_get(&env, "/api/buckets/b4").await;
        assert_not_found(&permissionless);
        let lines = env.garage.lines();
        assert!(
            lines.iter().all(|line| !line.contains("GetBucketInfo?id=b3")),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn tenant_gets_404_on_every_bucket_scoped_api_of_an_ungranted_bucket() {
        let env = tenant_env(false, false).await;
        let tenant = &env.tenant;
        let calls = [
            request("GET", "/api/buckets/b3/objects", None, Some(tenant)),
            request("GET", "/api/buckets/b3/search?q=abc", None, Some(tenant)),
            request("GET", "/api/buckets/b3/object?key=a.txt", None, Some(tenant)),
            request(
                "GET",
                "/api/buckets/b3/object?key=a.txt&download=1",
                None,
                Some(tenant),
            ),
            request(
                "GET",
                "/api/buckets/b3/object?key=photo.png&thumbnail=1",
                None,
                Some(tenant),
            ),
            request("DELETE", "/api/buckets/b3/object?key=a.txt", None, Some(tenant)),
            put_bytes(
                "/api/buckets/b3/object?key=up.txt",
                b"hello",
                Some("5"),
                tenant,
            ),
            request(
                "POST",
                "/api/buckets/b3/objects:delete",
                Some(&json!({ "keys": ["a.txt"] }).to_string()),
                Some(tenant),
            ),
            request(
                "POST",
                "/api/buckets/b3/archive-token",
                Some(&json!({ "keys": ["a.txt"] }).to_string()),
                Some(tenant),
            ),
            request("GET", "/api/buckets/b3/archive?token=abc", None, Some(tenant)),
            request(
                "POST",
                "/api/share",
                Some(
                    &json!({ "ttl_seconds": 60, "bucket": "b3", "key": "a.txt" }).to_string(),
                ),
                Some(tenant),
            ),
            request("GET", "/api/buckets/b3/multipart", None, Some(tenant)),
            request("DELETE", "/api/buckets/b3/multipart", None, Some(tenant)),
            request("GET", "/api/buckets/b3/cors", None, Some(tenant)),
            request("GET", "/api/buckets/b3/lifecycle", None, Some(tenant)),
        ];
        for call in calls {
            let label = format!("{} {}", call.method(), call.uri());
            let response = exchange(&env.app, call).await;
            assert_eq!(response.status, StatusCode::NOT_FOUND, "{label}: {}", response.body);
            assert_eq!(code_of(&response.body), "not_found", "{label}");
        }
        assert!(env.s3.seen().is_empty(), "{:?}", env.s3.lines());
        let lines = env.garage.lines();
        assert!(lines.iter().all(|line| !line.contains("b3")), "{lines:?}");
    }

    #[tokio::test]
    async fn tenant_s3_requests_are_signed_with_the_bound_key_only() {
        let env = tenant_env(false, false).await;
        let tenant = &env.tenant;
        let list = tenant_get(&env, "/api/buckets/b1/objects").await;
        assert_eq!(list.status, StatusCode::OK, "{}", list.body);
        let search = tenant_get(&env, "/api/buckets/b1/search?q=abc").await;
        assert_eq!(search.status, StatusCode::OK, "{}", search.body);
        let meta = tenant_get(&env, "/api/buckets/b1/object?key=a.txt").await;
        assert_eq!(meta.status, StatusCode::OK, "{}", meta.body);
        let download = tenant_get(&env, "/api/buckets/b1/object?key=a.txt&download=1").await;
        assert_eq!(download.status, StatusCode::OK, "{}", download.body);
        let thumb = binary_status(
            &env,
            request(
                "GET",
                "/api/buckets/b1/object?key=photo.png&thumbnail=1",
                None,
                Some(tenant),
            ),
        )
        .await;
        assert_eq!(thumb, StatusCode::OK);
        let upload = exchange(
            &env.app,
            put_bytes(
                "/api/buckets/b1/object?key=up.txt",
                b"hello",
                Some("5"),
                tenant,
            ),
        )
        .await;
        assert_eq!(upload.status, StatusCode::CREATED, "{}", upload.body);
        let removed = exchange(
            &env.app,
            request("DELETE", "/api/buckets/b1/object?key=old.txt", None, Some(tenant)),
        )
        .await;
        assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
        let issued = exchange(
            &env.app,
            request(
                "POST",
                "/api/buckets/b1/archive-token",
                Some(&json!({ "keys": ["a.txt"] }).to_string()),
                Some(tenant),
            ),
        )
        .await;
        assert_eq!(issued.status, StatusCode::OK, "{}", issued.body);
        let token = serde_json::from_str::<Value>(&issued.body).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let archive = binary_status(
            &env,
            request(
                "GET",
                &format!("/api/buckets/b1/archive?token={token}"),
                None,
                Some(tenant),
            ),
        )
        .await;
        assert_eq!(archive, StatusCode::OK);

        let seen = env.s3.seen();
        assert!(seen.len() >= 8, "{:?}", env.s3.lines());
        for call in &seen {
            assert_eq!(signing_key(call), TENANT_KEY, "{}", call.line);
            assert!(!call.authorization.contains("PROJECT"), "{}", call.line);
        }

        let shared = exchange(
            &env.app,
            request(
                "POST",
                "/api/share",
                Some(
                    &json!({ "ttl_seconds": 60, "bucket": "b1", "key": "a.txt" }).to_string(),
                ),
                Some(tenant),
            ),
        )
        .await;
        assert_eq!(shared.status, StatusCode::OK, "{}", shared.body);
        let url = serde_json::from_str::<Value>(&shared.body).unwrap()["url"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(url.contains(&format!("X-Amz-Credential={TENANT_KEY}")), "{url}");
        assert!(!url.contains("PROJECT"), "{url}");
        assert_eq!(env.s3.seen().len(), seen.len());
    }

    #[tokio::test]
    async fn tenant_gets_garage_denied_after_one_upstream_attempt() {
        let env = tenant_env(false, true).await;
        let download = tenant_get(&env, "/api/buckets/b1/object?key=a.txt&download=1").await;
        assert_eq!(download.status, StatusCode::FORBIDDEN, "{}", download.body);
        assert_eq!(code_of(&download.body), "garage_denied", "{}", download.body);
        assert_eq!(env.s3.seen().len(), 1, "{:?}", env.s3.lines());
        let upload = exchange(
            &env.app,
            put_bytes(
                "/api/buckets/b2/object?key=up.txt",
                b"hello",
                Some("5"),
                &env.tenant,
            ),
        )
        .await;
        assert_eq!(upload.status, StatusCode::FORBIDDEN, "{}", upload.body);
        assert_eq!(code_of(&upload.body), "garage_denied", "{}", upload.body);
        assert_eq!(env.s3.seen().len(), 2, "{:?}", env.s3.lines());
    }

    #[tokio::test]
    async fn cached_thumbnail_is_served_to_a_tenant_only_after_its_own_key_succeeds() {
        let env = tenant_env(false, true).await;
        let uri = "/api/buckets/b1/object?key=photo.png&thumbnail=1";
        let admin = binary_status(&env, request("GET", uri, None, Some(&env.admin))).await;
        assert_eq!(admin, StatusCode::OK);
        let tenant = tenant_get(&env, uri).await;
        assert_eq!(tenant.status, StatusCode::FORBIDDEN, "{}", tenant.body);
        assert_eq!(code_of(&tenant.body), "garage_denied", "{}", tenant.body);
        let tenant_calls: Vec<_> = env
            .s3
            .seen()
            .into_iter()
            .filter(|call| signing_key(call) == TENANT_KEY)
            .collect();
        assert_eq!(tenant_calls.len(), 1);
        assert!(tenant_calls[0].line.starts_with("HEAD "));
    }

    #[tokio::test]
    async fn tenant_whose_key_was_deleted_gets_tenant_key_unavailable() {
        let env = tenant_env(true, false).await;
        for uri in [
            "/api/buckets",
            "/api/buckets/b1",
            "/api/buckets/b1/objects",
            "/api/buckets/b1/object?key=a.txt&download=1",
        ] {
            let response = tenant_get(&env, uri).await;
            assert_eq!(response.status, StatusCode::FORBIDDEN, "{uri}: {}", response.body);
            assert_eq!(code_of(&response.body), "tenant_key_unavailable", "{uri}");
        }
        let upload = exchange(
            &env.app,
            put_bytes(
                "/api/buckets/b1/object?key=up.txt",
                b"hello",
                Some("5"),
                &env.tenant,
            ),
        )
        .await;
        assert_eq!(upload.status, StatusCode::FORBIDDEN, "{}", upload.body);
        assert_eq!(code_of(&upload.body), "tenant_key_unavailable");
        assert!(env.s3.seen().is_empty());
    }

    #[tokio::test]
    async fn tenant_is_denied_cluster_key_operations_audit_user_and_proxy_routes() {
        let env = tenant_env(false, false).await;
        let tenant = &env.tenant;
        let calls = [
            request("GET", "/api/cluster/health", None, Some(tenant)),
            request("GET", "/api/cluster/status", None, Some(tenant)),
            request("GET", "/api/cluster/statistics", None, Some(tenant)),
            request("GET", "/api/metrics", None, Some(tenant)),
            request("GET", "/api/keys", None, Some(tenant)),
            request("GET", "/api/keys/GKtenant", None, Some(tenant)),
            request("GET", "/api/audit", None, Some(tenant)),
            request("GET", "/api/users", None, Some(tenant)),
            request("GET", "/api/buckets/b1/inspect?key=a.txt", None, Some(tenant)),
            request(
                "POST",
                "/api/buckets/b1/cleanup-uploads",
                Some(&json!({ "olderThanSecs": 0 }).to_string()),
                Some(tenant),
            ),
            request("GET", "/api/garage/v2/GetClusterHealth", None, Some(tenant)),
            request("GET", "/api/garage/v2/ListBuckets", None, Some(tenant)),
            request("GET", "/api/garage/v2/GetBucketInfo?id=b3", None, Some(tenant)),
            request("GET", "/api/garage/v2/GetKeyInfo?id=GKtenant", None, Some(tenant)),
            request("GET", "/api/objects/preview?name=x", None, Some(tenant)),
            request("GET", "/api/objects/download?name=x", None, Some(tenant)),
            Request::builder()
                .method("POST")
                .uri("/api/objects")
                .header("cookie", cookie_header(tenant))
                .header("x-csrf-token", &tenant.csrf)
                .header("content-length", "5")
                .body(Body::from("hello"))
                .unwrap(),
        ];
        for call in calls {
            let label = format!("{} {}", call.method(), call.uri());
            let response = exchange(&env.app, call).await;
            assert_eq!(response.status, StatusCode::FORBIDDEN, "{label}: {}", response.body);
        }
        assert!(env.s3.seen().is_empty(), "{:?}", env.s3.lines());
        let lines = env.garage.lines();
        assert!(
            lines
                .iter()
                .all(|line| !line.contains("GetClusterHealth") && !line.contains("b3")),
            "{lines:?}"
        );
    }
