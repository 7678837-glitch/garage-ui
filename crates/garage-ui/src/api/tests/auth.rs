
    fn capability_body(version: &Value, buckets: &str, keys: &str) -> Value {
        json!({
            "version": version,
            "listBucketsInfo": buckets,
            "listKeysInfo": keys,
        })
    }

    #[tokio::test]
    async fn capabilities_are_unknown_before_any_list_and_a_viewer_can_read_them() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_task = Arc::clone(&hits);
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                hits_task.fetch_add(1, Ordering::SeqCst);
                drop(socket);
            }
        });
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &format!("http://127.0.0.1:{port}")).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let missing = exchange(&app, request("GET", "/api/capabilities", None, None)).await;
        assert_error(
            &missing,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
        let health = exchange(&app, request("GET", "/healthz", None, None)).await;
        assert_eq!(health.status, StatusCode::OK, "{}", health.body);
        let health_body: Value = serde_json::from_str(&health.body).unwrap();
        let response = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&viewer)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            capability_body(&health_body["version"], "unknown", "unknown")
        );
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        let bare = crate::util::temp_dir();
        let plain = state::test_app(&bare).await;
        let (plain_admin, _) = login(&plain).await;
        let plain_caps = exchange(
            &plain,
            request("GET", "/api/capabilities", None, Some(&plain_admin)),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&plain_caps.body).unwrap(),
            capability_body(&health_body["version"], "unknown", "unknown")
        );
        task.abort();
    }

    #[tokio::test]
    async fn capabilities_follow_info_404_and_info_200() {
        let absent = InfoSocket::start(404).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &absent.url).await;
        let (admin, _) = login(&app).await;
        let health = exchange(&app, request("GET", "/healthz", None, None)).await;
        let health_body: Value = serde_json::from_str(&health.body).unwrap();
        let before = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&admin)),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&before.body).unwrap(),
            capability_body(&health_body["version"], "unknown", "unknown")
        );
        assert_eq!(absent.hits(), 0);
        let buckets = exchange(
            &app,
            request("GET", "/api/buckets?limit=1", None, Some(&admin)),
        )
        .await;
        assert_eq!(buckets.status, StatusCode::OK, "{}", buckets.body);
        let after_buckets = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&admin)),
        )
        .await;
        let after_buckets_hits = absent.hits();
        assert_eq!(
            serde_json::from_str::<Value>(&after_buckets.body).unwrap(),
            capability_body(&health_body["version"], "absent", "unknown")
        );
        let again = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&admin)),
        )
        .await;
        assert_eq!(again.body, after_buckets.body);
        assert_eq!(absent.hits(), after_buckets_hits);
        let keys = exchange(
            &app,
            request("GET", "/api/keys?limit=1", None, Some(&admin)),
        )
        .await;
        assert_eq!(keys.status, StatusCode::OK, "{}", keys.body);
        let after_keys = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&admin)),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&after_keys.body).unwrap(),
            capability_body(&health_body["version"], "absent", "absent")
        );

        let present = InfoSocket::start(200).await;
        let other = crate::util::temp_dir();
        let app2 = app_for(&other, &present.url).await;
        let (admin2, _) = login(&app2).await;
        let listed = exchange(
            &app2,
            request("GET", "/api/buckets?limit=1", None, Some(&admin2)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let shown = exchange(
            &app2,
            request("GET", "/api/capabilities", None, Some(&admin2)),
        )
        .await;
        let shown_hits = present.hits();
        assert_eq!(
            serde_json::from_str::<Value>(&shown.body).unwrap(),
            capability_body(&health_body["version"], "present", "unknown")
        );
        let shown_again = exchange(
            &app2,
            request("GET", "/api/capabilities", None, Some(&admin2)),
        )
        .await;
        assert_eq!(shown_again.body, shown.body);
        assert_eq!(present.hits(), shown_hits);
        let listed_keys = exchange(
            &app2,
            request("GET", "/api/keys?limit=1", None, Some(&admin2)),
        )
        .await;
        assert_eq!(listed_keys.status, StatusCode::OK, "{}", listed_keys.body);
        let both = exchange(
            &app2,
            request("GET", "/api/capabilities", None, Some(&admin2)),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&both.body).unwrap(),
            capability_body(&health_body["version"], "present", "present")
        );
    }

    #[tokio::test]
    async fn connection_failure_leaves_capabilities_unknown() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_task = Arc::clone(&hits);
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                hits_task.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0_u8; 1024];
                let _ = socket.read(&mut buf).await;
                let _ = socket.shutdown().await;
            }
        });
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &format!("http://127.0.0.1:{port}")).await;
        let (admin, _) = login(&app).await;
        let failed = exchange(
            &app,
            request("GET", "/api/buckets?limit=1", None, Some(&admin)),
        )
        .await;
        assert_error(
            &failed,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not reachable",
        );
        let tried = hits.load(Ordering::SeqCst);
        assert!(tried > 0, "the list did not reach the upstream");
        let health = exchange(&app, request("GET", "/healthz", None, None)).await;
        let health_body: Value = serde_json::from_str(&health.body).unwrap();
        let response = exchange(
            &app,
            request("GET", "/api/capabilities", None, Some(&admin)),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            capability_body(&health_body["version"], "unknown", "unknown")
        );
        assert_eq!(hits.load(Ordering::SeqCst), tried);
        task.abort();
    }

    #[tokio::test]
    async fn csrf_rejection_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let rejected = exchange(
            &app,
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header("cookie", cookie_header(&admin))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_error(
            &rejected,
            StatusCode::FORBIDDEN,
            "csrf_rejected",
            "CSRF token missing or mismatched",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "csrf_rejected");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/logout");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 403);
        assert_eq!(row.username, "Ada");
        assert!(!audit_text(row).contains(&admin.csrf));
        let status = exchange(
            &app,
            request("GET", "/api/auth/status", None, Some(&admin)),
        )
        .await;
        assert_eq!(status.status, StatusCode::OK, "{}", status.body);
        assert_eq!(
            serde_json::from_str::<Value>(&status.body).unwrap()["authenticated"],
            true
        );
    }

    #[tokio::test]
    async fn csrf_rejection_records_the_last_forwarded_hop() {
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", "http://127.0.0.1:9"),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("TRUSTED_PROXY", "true"),
            ],
            test_quota(),
        )
        .await;
        let (admin, _) = login(&app).await;
        let rejected = exchange(
            &app,
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header("cookie", cookie_header(&admin))
                .header("x-forwarded-for", "198.51.100.10, 203.0.113.55, ")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_error(
            &rejected,
            StatusCode::FORBIDDEN,
            "csrf_rejected",
            "CSRF token missing or mismatched",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        let row = rows
            .iter()
            .find(|row| row.reason == "csrf_rejected")
            .expect("csrf rejection audit");
        assert_eq!(row.ip, "203.0.113.55");
        assert_eq!(row.username, "Ada");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/logout");
        assert_eq!(row.status, 403);
        assert!(!audit_text(row).contains("198.51.100.10"));
        assert!(!audit_text(row).contains(&admin.csrf));
    }

    #[tokio::test]
    async fn setup_invalid_username_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let username = "bad name";
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": username, "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{}", response.body);
        assert_eq!(code_of(&response.body), "invalid_username");
        assert!(!response.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, username);
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_username");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/setup");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));
    }

    #[tokio::test]
    async fn setup_invalid_password_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let submitted = "badpass";
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": "Ada", "password": submitted }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{}", response.body);
        assert_eq!(code_of(&response.body), "password_invalid");
        assert!(!response.body.contains(submitted));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "password_invalid");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/setup");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(submitted));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(submitted));
    }

    #[tokio::test]
    async fn setup_already_initialized_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let username = "Other";
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": username, "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
        assert_eq!(code_of(&response.body), "already_initialized");
        assert!(!response.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, username);
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "already_initialized");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/setup");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 409);
        assert!(!audit_text(row).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));
    }

    #[tokio::test]
    async fn change_password_invalid_new_password_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let submitted = "badpass";
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/auth/change-password",
                Some(
                    &json!({
                        "current_password": PASSWORD,
                        "new_password": submitted
                    })
                    .to_string(),
                ),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{}", response.body);
        assert_eq!(code_of(&response.body), "password_invalid");
        assert!(!response.body.contains(submitted));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "password_invalid");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/change-password");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(submitted));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(submitted));
    }

    #[tokio::test]
    async fn password_change_drops_the_other_session() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session_a, _) = login(&app).await;
        let logged_in = exchange(
            &app,
            request(
                "POST",
                "/api/auth/login",
                Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(logged_in.status, StatusCode::OK, "{}", logged_in.body);
        let session_b = session_from(&logged_in.headers);
        let changed = exchange(
            &app,
            request(
                "POST",
                "/api/auth/change-password",
                Some(
                    &json!({
                        "current_password": PASSWORD,
                        "new_password": "updated horse"
                    })
                    .to_string(),
                ),
                Some(&session_a),
            ),
        )
        .await;
        assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
        let replacement = session_from(&changed.headers);
        assert_ne!(replacement.id, session_a.id);

        let other = exchange(&app, request("GET", "/api/config", None, Some(&session_b))).await;
        assert_eq!(other.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&other.body), "unauthenticated");

        let stale = exchange(&app, request("GET", "/api/config", None, Some(&session_a))).await;
        assert_eq!(stale.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&stale.body), "unauthenticated");

        let current =
            exchange(&app, request("GET", "/api/config", None, Some(&replacement))).await;
        assert_eq!(current.status, StatusCode::OK, "{}", current.body);
    }

    #[tokio::test]
    async fn setup_success_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "setup");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/setup");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 200);
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn setup_rate_limit_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.body);
        for _ in 0..9 {
            let conflict = exchange(
                &app,
                request(
                    "POST",
                    "/api/setup",
                    Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                    None,
                ),
            )
            .await;
            assert_eq!(conflict.status, StatusCode::CONFLICT, "{}", conflict.body);
            assert_eq!(code_of(&conflict.body), "already_initialized");
        }
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let blocked = exchange(
            &app,
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS, "{}", blocked.body);
        assert_eq!(code_of(&blocked.body), "rate_limited");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "rate_limited");
        assert_eq!(row.reason, "rate_limited");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/setup");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 429);
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn login_failure_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let submitted = "wrong horse";
        let failed = exchange(
            &app,
            request(
                "POST",
                "/api/auth/login",
                Some(&json!({ "username": "Ada", "password": submitted }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(failed.status, StatusCode::UNAUTHORIZED, "{}", failed.body);
        assert_eq!(code_of(&failed.body), "invalid_credentials");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "failure");
        assert_eq!(row.reason, "invalid_credentials");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/login");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 401);
        assert!(!audit_text(row).contains(submitted));
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn login_rate_limit_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        login(&app).await;
        let submitted = "wrong horse";
        for _ in 0..10 {
            let failed = exchange(
                &app,
                request(
                    "POST",
                    "/api/auth/login",
                    Some(&json!({ "username": "Ada", "password": submitted }).to_string()),
                    None,
                ),
            )
            .await;
            assert_eq!(failed.status, StatusCode::UNAUTHORIZED, "{}", failed.body);
            assert_eq!(code_of(&failed.body), "invalid_credentials");
        }
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let blocked = exchange(
            &app,
            request(
                "POST",
                "/api/auth/login",
                Some(&json!({ "username": "Ada", "password": submitted }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS, "{}", blocked.body);
        assert_eq!(code_of(&blocked.body), "rate_limited");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "rate_limited");
        assert_eq!(row.reason, "rate_limited");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/login");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 429);
        assert!(!audit_text(row).contains(submitted));
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn login_success_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let logged_in = exchange(
            &app,
            request(
                "POST",
                "/api/auth/login",
                Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(logged_in.status, StatusCode::OK, "{}", logged_in.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "login");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/login");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 200);
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn logout_success_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let logged_out = exchange(
            &app,
            request("POST", "/api/auth/logout", None, Some(&session)),
        )
        .await;
        assert_eq!(logged_out.status, StatusCode::NO_CONTENT, "{}", logged_out.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "logout");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/logout");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 204);
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn change_password_invalid_credentials_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let submitted = "wrong horse";
        let replacement = "updated horse";
        let failed = exchange(
            &app,
            request(
                "POST",
                "/api/auth/change-password",
                Some(
                    &json!({
                        "current_password": submitted,
                        "new_password": replacement
                    })
                    .to_string(),
                ),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(failed.status, StatusCode::UNAUTHORIZED, "{}", failed.body);
        assert_eq!(code_of(&failed.body), "invalid_credentials");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "failure");
        assert_eq!(row.reason, "invalid_credentials");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/change-password");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 401);
        assert!(!audit_text(row).contains(submitted));
        assert!(!audit_text(row).contains(replacement));
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn change_password_rate_limit_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let submitted = "wrong horse";
        let replacement = "updated horse";
        for _ in 0..10 {
            let failed = exchange(
                &app,
                request(
                    "POST",
                    "/api/auth/change-password",
                    Some(
                        &json!({
                            "current_password": submitted,
                            "new_password": replacement
                        })
                        .to_string(),
                    ),
                    Some(&session),
                ),
            )
            .await;
            assert_eq!(failed.status, StatusCode::UNAUTHORIZED, "{}", failed.body);
            assert_eq!(code_of(&failed.body), "invalid_credentials");
        }
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let blocked = exchange(
            &app,
            request(
                "POST",
                "/api/auth/change-password",
                Some(
                    &json!({
                        "current_password": submitted,
                        "new_password": replacement
                    })
                    .to_string(),
                ),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS, "{}", blocked.body);
        assert_eq!(code_of(&blocked.body), "rate_limited");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "rate_limited");
        assert_eq!(row.reason, "rate_limited");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/change-password");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 429);
        assert!(!audit_text(row).contains(submitted));
        assert!(!audit_text(row).contains(replacement));
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn change_password_success_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let replacement = "updated horse";
        let changed = exchange(
            &app,
            request(
                "POST",
                "/api/auth/change-password",
                Some(
                    &json!({
                        "current_password": PASSWORD,
                        "new_password": replacement
                    })
                    .to_string(),
                ),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "password_changed");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/auth/change-password");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 200);
        assert!(!audit_text(row).contains(PASSWORD));
        assert!(!audit_text(row).contains(replacement));
    }

    #[tokio::test]
    async fn change_password_preserves_live_permissions_and_rejects_revoked_authentication() {
        for mutation in [
            "permissions",
            "role",
            "disabled",
            "password",
            "session",
            "demoted",
        ] {
            let dir = crate::util::temp_dir();
            let app = state::test_app(&dir).await;
            let (session, _) = login(&app).await;
            let mut headers = HeaderMap::new();
            headers.insert(
                "cookie",
                HeaderValue::from_str(&cookie_header(&session)).unwrap(),
            );
            if mutation == "permissions" {
                let user = crate::db::find_user_by_name(&app.db, "Ada")
                    .await
                    .unwrap()
                    .unwrap();
                crate::db::update_user(&app.db, user.id, "viewer", true, true, false, None)
                    .await
                    .unwrap();
            }
            let current = crate::session::authenticate(&app, &headers, "127.0.0.1")
                .await
                .unwrap();
            let id = current.user.id;
            let original_hash = current.user.password_hash.clone();
            match mutation {
                "permissions" | "role" => {
                    crate::db::update_user(&app.db, id, "viewer", false, false, false, None)
                        .await
                        .unwrap()
                }
                "disabled" => crate::db::update_user(&app.db, id, "admin", false, false, true, None)
                    .await
                    .unwrap(),
                "password" => {
                    let changed_hash = crate::password::hash_async("other password".into(), 4)
                        .await
                        .unwrap();
                    crate::db::update_user(
                        &app.db,
                        id,
                        "admin",
                        false,
                        false,
                        false,
                        Some(&changed_hash),
                    )
                    .await
                    .unwrap();
                }
                "session" => crate::db::delete_user_sessions(&app.db, id).await.unwrap(),
                "demoted" => {
                    crate::db::update_user(&app.db, id, "viewer", false, false, false, None)
                        .await
                        .unwrap();
                    crate::db::delete_user_sessions(&app.db, id).await.unwrap();
                }
                _ => unreachable!(),
            }
            let before = crate::db::find_user_by_id(&app.db, id)
                .await
                .unwrap()
                .unwrap();
            let body = serde_json::from_value(
                json!({"current_password": PASSWORD, "new_password": "updated password"}),
            )
            .unwrap();
            let result = super::auth::change_password(
                axum::extract::State(app.clone()),
                super::Authed(current),
                axum::Json(body),
            )
            .await;
            let after = crate::db::find_user_by_id(&app.db, id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(after.role, before.role, "{mutation} restored the role");
            assert_eq!(
                after.can_download, before.can_download,
                "{mutation} restored download permission"
            );
            assert_eq!(
                after.can_share, before.can_share,
                "{mutation} restored share permission"
            );
            assert_eq!(
                after.disabled, before.disabled,
                "{mutation} restored the account"
            );
            if matches!(mutation, "permissions" | "role") {
                let response = result.unwrap();
                let data = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap();
                let user: Value = serde_json::from_slice(&data).unwrap();
                assert_eq!(user["role"], "viewer");
                assert_eq!(user["can_download"], false);
                assert_ne!(after.password_hash, original_hash);
                assert!(crate::password::verify(
                    "updated password",
                    &after.password_hash
                ));
            } else {
                assert_eq!(
                    result.unwrap_err().status_code(),
                    StatusCode::UNAUTHORIZED,
                    "{mutation}"
                );
                assert_eq!(
                    after.password_hash, before.password_hash,
                    "{mutation} overwrote the password"
                );
                if matches!(mutation, "session" | "demoted") {
                    assert!(
                        crate::db::load_session(&app.db, &session.id)
                            .await
                            .unwrap()
                            .is_none()
                    );
                }
            }
        }
    }
