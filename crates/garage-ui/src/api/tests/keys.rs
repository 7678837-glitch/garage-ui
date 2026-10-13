
    #[tokio::test]
    async fn rejected_key_name_does_not_call_garage() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"accessKeyId":"GK1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        for name in ["my key", "my.key", "名字", ""] {
            let response = exchange(
                &app,
                request(
                    "POST",
                    "/api/keys",
                    Some(&json!({ "name": name }).to_string()),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &response,
                StatusCode::BAD_REQUEST,
                "invalid_key_name",
                "Key name is invalid",
            );
        }
        assert_eq!(mock.hits(), 0);
    }

    #[tokio::test]
    async fn create_key_invalid_name_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let name = "my key";
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/keys",
                Some(&json!({ "name": name }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "invalid_key_name",
            "Key name is invalid",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_key_name");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/keys");
        assert_eq!(row.target, name);
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn patch_key_invalid_body_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request("PATCH", "/api/keys/GK1", Some("{}"), Some(&admin)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "invalid_key_patch",
            "Send a name or createBucket",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_key_patch");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/keys");
        assert_eq!(row.target, "GK1");
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn key_write_denials_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/keys",
                Some(&json!({ "name": "photos" }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&created, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/keys");
        assert_eq!(row.target, "photos");
        assert_eq!(row.status, 403);

        let patched = exchange(
            &app,
            request(
                "PATCH",
                "/api/keys/GK1",
                Some(&json!({ "name": "renamed" }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&patched, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/keys");
        assert_eq!(row.target, "GK1");
        assert_eq!(row.status, 403);

        let removed = exchange(
            &app,
            request("DELETE", "/api/keys/GK1", None, Some(&viewer)),
        )
        .await;
        assert_error(&removed, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 3, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/keys");
        assert_eq!(row.target, "GK1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn key_secret_denial_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request("POST", "/api/keys/GK1/secret", None, Some(&viewer)),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/keys/secret");
        assert_eq!(row.target, "GK1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn key_secret_unconfirmed_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request("POST", "/api/keys/GK1/secret", None, Some(&admin)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::FORBIDDEN,
            "confirmation_required",
            "Confirmation required",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "confirmation_required");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/keys/secret");
        assert_eq!(row.target, "GK1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn admin_create_hits_create_key_once() {
        let secret = "wJalrXUtnFEMI";
        let created = json!({
            "accessKeyId": "GK1",
            "name": "photo_roll-1",
            "secretAccessKey": secret,
            "expired": false,
            "permissions": { "createBucket": false },
            "buckets": []
        })
        .to_string();
        let mock = Upstream::start(UpstreamReply::Ok(created.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/keys",
                Some(&json!({ "name": "photo_roll-1" }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, created);
        assert_eq!(
            response
                .headers
                .get("cache-control")
                .and_then(|value| value.to_str().ok()),
            Some("private, no-store")
        );
        let creates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/CreateKey "))
            .collect();
        assert_eq!(
            creates.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&creates[0].body).unwrap(),
            json!({ "name": "photo_roll-1" })
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert!(rows.iter().any(|row| row.target == "GK1"));
        assert!(
            rows.iter()
                .all(|row| !row.target.contains(secret) && !row.path.contains(secret))
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
    }

    #[tokio::test]
    async fn viewer_create_key_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"accessKeyId":"GK1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/keys",
                Some(r#"{"name":"photos"}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(mock.hits(), 0);
    }

    #[tokio::test]
    async fn rename_forwards_the_name_body() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"accessKeyId":"GK1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "PATCH",
                "/api/keys/a%20b",
                Some(r#"{"name":"已有 名称"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let updates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/UpdateKey?"))
            .collect();
        assert_eq!(updates.len(), 1);
        assert!(updates[0].line.contains("id=a%20b"), "{}", updates[0].line);
        assert_eq!(
            serde_json::from_str::<Value>(&updates[0].body).unwrap(),
            json!({ "name": "已有 名称" })
        );
    }

    #[tokio::test]
    async fn create_bucket_switch_sends_allow_or_deny() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"accessKeyId":"GK1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        for (body, forwarded) in [
            (
                r#"{"createBucket":true}"#,
                json!({ "allow": { "createBucket": true } }),
            ),
            (
                r#"{"createBucket":false}"#,
                json!({ "deny": { "createBucket": true } }),
            ),
        ] {
            let response = exchange(
                &app,
                request("PATCH", "/api/keys/GK1", Some(body), Some(&admin)),
            )
            .await;
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            let updates: Vec<_> = mock
                .calls()
                .into_iter()
                .filter(|call| call.line.contains("POST /v2/UpdateKey?id=GK1 "))
                .collect();
            let sent =
                serde_json::from_str::<Value>(&updates.last().expect("update").body).unwrap();
            assert_eq!(sent, forwarded);
        }
    }

    #[tokio::test]
    async fn delete_key_puts_encoded_id_in_the_query() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"ok":true}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("DELETE", "/api/keys/a%20b%26c%3Dd", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let deletes: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("DeleteKey"))
            .collect();
        assert_eq!(deletes.len(), 1);
        assert!(
            deletes[0]
                .line
                .contains("POST /v2/DeleteKey?id=a%20b%26c%3Dd "),
            "{}",
            deletes[0].line
        );
        assert!(deletes[0].body.is_empty(), "{}", deletes[0].body);
    }

    #[tokio::test]
    async fn key_mutations_require_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        for (method, path, body) in [
            ("POST", "/api/keys", Some(r#"{"name":"photos"}"#)),
            ("PATCH", "/api/keys/GK1", Some(r#"{"name":"renamed"}"#)),
            ("DELETE", "/api/keys/GK1", None),
        ] {
            let response = exchange(&app, request(method, path, body, None)).await;
            assert_error(
                &response,
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Login required",
            );
        }
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/keys",
                Some(r#"{"name":"photos"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not configured",
        );
    }

    #[tokio::test]
    async fn get_key_returns_buckets_from_get_key_info() {
        let secret = "wJalrXUtnFEMI";
        let buckets = json!([
            {
                "id": "bkt-photos",
                "globalAliases": ["photos"],
                "localAliases": ["roll"],
                "permissions": { "owner": true, "read": true, "write": false }
            },
            {
                "id": "bkt-logs",
                "globalAliases": [],
                "localAliases": [],
                "permissions": { "owner": false, "read": false, "write": true }
            }
        ]);
        let upstream = json!({
            "accessKeyId": "GK1",
            "name": "photos",
            "secretAccessKey": secret,
            "expired": false,
            "permissions": { "createBucket": false },
            "buckets": buckets
        })
        .to_string();
        let mock = Upstream::start(UpstreamReply::Ok(upstream)).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/keys/GK1?showSecretKey=true",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let body: Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(body["accessKeyId"], "GK1");
        assert_eq!(body["buckets"], buckets);
        assert!(body.get("secretAccessKey").is_none(), "{}", response.body);
        assert!(!response.body.contains(secret), "{}", response.body);
        let calls = mock.calls();
        assert_eq!(
            calls.len(),
            1,
            "{:?}",
            calls
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            calls[0].line.contains("GET /v2/GetKeyInfo?id=GK1 "),
            "{}",
            calls[0].line
        );
        assert!(
            !calls[0].line.to_ascii_lowercase().contains("showsecretkey"),
            "{}",
            calls[0].line
        );
        let viewer = viewer_session(&app, &admin).await;
        let viewed = exchange(
            &app,
            request("GET", "/api/keys/GK1", None, Some(&viewer)),
        )
        .await;
        assert_eq!(viewed.status, StatusCode::OK, "{}", viewed.body);
        let viewed_body: Value = serde_json::from_str(&viewed.body).unwrap();
        assert_eq!(viewed_body["buckets"], buckets);
        assert!(viewed_body.get("secretAccessKey").is_none(), "{}", viewed.body);
    }
