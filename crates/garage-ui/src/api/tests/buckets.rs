
    fn assert_page(response: &Exchange, items: Value, more: bool) {
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(!response.body.contains(TOKEN), "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "items": items, "hasMore": more })
        );
    }

    #[tokio::test]
    async fn anonymous_catalog_pages_are_unauthorized() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        for path in [
            "/api/buckets",
            "/api/keys",
            "/api/buckets?limit=nope",
            "/api/keys?offset=abc",
        ] {
            let response = exchange(&app, request("GET", path, None, None)).await;
            assert_error(
                &response,
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Login required",
            );
        }
    }

    #[tokio::test]
    async fn catalog_pages_without_garage_are_unavailable() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let (session, _) = login(&app).await;
        for path in ["/api/buckets", "/api/keys"] {
            let response = exchange(&app, request("GET", path, None, Some(&session))).await;
            assert_error(
                &response,
                StatusCode::BAD_GATEWAY,
                "garage_unavailable",
                "Garage admin API is not configured",
            );
        }
    }

    #[tokio::test]
    async fn catalog_pages_reject_a_bad_window() {
        let mock = CatalogMock::start().await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (session, _) = login(&app).await;
        for (path, code, message) in [
            (
                "/api/buckets?offset=abc&limit=2",
                "invalid_offset",
                "Offset must be a non-negative integer",
            ),
            (
                "/api/keys?offset=",
                "invalid_offset",
                "Offset must be a non-negative integer",
            ),
            (
                "/api/buckets?offset=-1&limit=2",
                "invalid_offset",
                "Offset must be a non-negative integer",
            ),
            (
                "/api/keys?offset=1&limit=abc",
                "invalid_limit",
                "Limit must be a non-negative integer",
            ),
            (
                "/api/buckets?limit=",
                "invalid_limit",
                "Limit must be a non-negative integer",
            ),
        ] {
            let response = exchange(&app, request("GET", path, None, Some(&session))).await;
            assert_error(&response, StatusCode::BAD_REQUEST, code, message);
        }
        assert!(
            mock.requests().is_empty(),
            "a rejected window called Garage: {:?}",
            mock.requests()
        );
    }

    #[tokio::test]
    async fn catalog_pages_clamp_an_oversized_limit() {
        let mock = CatalogMock::start().await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (session, _) = login(&app).await;

        let buckets = exchange(
            &app,
            request("GET", "/api/buckets?limit=1001", None, Some(&session)),
        )
        .await;
        assert_page(
            &buckets,
            json!([{ "id": "b0" }, { "id": "b1" }, { "id": "b2" }]),
            false,
        );

        let keys = exchange(
            &app,
            request("GET", "/api/keys?offset=0&limit=5000", None, Some(&session)),
        )
        .await;
        assert_page(
            &keys,
            json!([{ "id": "k0" }, { "id": "k1" }, { "id": "k2" }]),
            false,
        );

        let lines = mock.requests();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("GET /v2/ListBucketsInfo?limit=1000 "));
        assert!(!lines[0].contains("limit=1001"));
        assert!(lines[1].contains("GET /v2/ListKeysInfo?limit=1000 "));
        assert!(!lines[1].contains("offset="));
        assert!(!lines[1].contains("limit=5000"));
    }

    #[tokio::test]
    async fn catalog_pages_return_items_and_more() {
        let mock = CatalogMock::start().await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;

        let first = exchange(
            &app,
            request("GET", "/api/buckets?limit=2", None, Some(&admin)),
        )
        .await;
        assert_page(&first, json!([{ "id": "b0" }, { "id": "b1" }]), true);
        assert_eq!(mock.requests().len(), 1, "{:?}", mock.requests());
        assert!(mock.requests()[0].contains("GET /v2/ListBucketsInfo?limit=2 "));
        assert!(!mock.requests()[0].contains("offset="));

        let tail = exchange(
            &app,
            request("GET", "/api/buckets?offset=2&limit=2", None, Some(&admin)),
        )
        .await;
        assert_page(&tail, json!([{ "id": "b2" }]), false);

        let defaults = exchange(&app, request("GET", "/api/buckets", None, Some(&admin))).await;
        assert_page(
            &defaults,
            json!([{ "id": "b0" }, { "id": "b1" }, { "id": "b2" }]),
            false,
        );
        let bucket_lines: Vec<_> = mock
            .requests()
            .into_iter()
            .filter(|line| line.contains("ListBucketsInfo?limit=100 "))
            .collect();
        assert_eq!(bucket_lines.len(), 1, "{:?}", mock.requests());
        assert!(bucket_lines[0].contains("GET /v2/ListBucketsInfo?limit=100 "));
        assert!(!bucket_lines[0].contains("offset="));

        let wide = exchange(
            &app,
            request("GET", "/api/buckets?limit=1000", None, Some(&admin)),
        )
        .await;
        assert_page(
            &wide,
            json!([{ "id": "b0" }, { "id": "b1" }, { "id": "b2" }]),
            false,
        );
        assert!(
            mock.requests()
                .iter()
                .any(|line| line.contains("ListBucketsInfo?limit=1000 "))
        );

        let empty = exchange(
            &app,
            request("GET", "/api/keys?limit=0", None, Some(&admin)),
        )
        .await;
        assert_page(&empty, json!([]), true);
        assert!(
            mock.requests()
                .iter()
                .any(|line| line.contains("GET /v2/ListKeysInfo?limit=0 "))
        );

        let keys = exchange(
            &app,
            request("GET", "/api/keys?offset=2&limit=2", None, Some(&admin)),
        )
        .await;
        assert_page(&keys, json!([{ "id": "k2" }]), false);
        assert!(
            mock.requests()
                .iter()
                .all(|line| !line.contains("GetBucketInfo") && !line.contains("GetKeyInfo"))
        );

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Bea",
                        "password": "viewer horse",
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let viewer = sign_in(&app, "Bea", "viewer horse").await;
        let viewer_buckets = exchange(
            &app,
            request("GET", "/api/buckets?limit=1", None, Some(&viewer)),
        )
        .await;
        assert_page(&viewer_buckets, json!([{ "id": "b0" }]), true);
        let viewer_keys = exchange(
            &app,
            request("GET", "/api/keys?limit=1", None, Some(&viewer)),
        )
        .await;
        assert_page(&viewer_keys, json!([{ "id": "k0" }]), true);
    }

    #[tokio::test]
    async fn admin_create_hits_create_bucket_once() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"new"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets",
                Some(
                    &json!({
                        "globalAlias": "photos",
                        "localAlias": {
                            "accessKeyId": "GK1",
                            "alias": "home",
                            "allow": { "read": true }
                        }
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, r#"{"id":"new"}"#);
        assert!(!response.body.contains(TOKEN), "{}", response.body);
        let creates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/CreateBucket "))
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
            json!({
                "globalAlias": "photos",
                "localAlias": {
                    "accessKeyId": "GK1",
                    "alias": "home",
                    "allow": { "read": true }
                }
            })
        );
    }

    #[tokio::test]
    async fn viewer_create_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"new"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets",
                Some(r#"{"globalAlias":"photos"}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| &call.line)
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn delete_puts_encoded_id_in_the_query() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"ok":true}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("DELETE", "/api/buckets/a%20b%26c%3Dd", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, r#"{"ok":true}"#);
        let deletes: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("DeleteBucket"))
            .collect();
        assert_eq!(deletes.len(), 1);
        assert!(
            deletes[0]
                .line
                .contains("POST /v2/DeleteBucket?id=a%20b%26c%3Dd "),
            "{}",
            deletes[0].line
        );
    }

    #[tokio::test]
    async fn delete_keeps_garage_400_body() {
        let body = r#"{"message":"Bucket is not empty"}"#.to_string();
        let mock = Upstream::start(UpstreamReply::Fixed("400 Bad Request", body.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("DELETE", "/api/buckets/full", None, Some(&admin)),
        )
        .await;
        assert_eq!(
            response.status,
            StatusCode::BAD_REQUEST,
            "{}",
            response.body
        );
        assert_eq!(response.body, body);
    }

    const BUCKET_DIGITS: &str = r#"{"id":"bkt-1","objects":9007199254740993,"bytes":9007199254740993,"quotas":{"maxSize":9007199254740993,"maxObjects":9007199254740993}}"#;

    #[tokio::test]
    async fn bucket_detail_keeps_upstream_digits() {
        let mock = Upstream::start(UpstreamReply::Ok(BUCKET_DIGITS.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, BUCKET_DIGITS);
        assert!(response.body.contains("9007199254740993"));
        assert!(!response.body.contains("9007199254740992"));
        let details = bucket_info_calls(&mock);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            details[0].line.contains("GET /v2/GetBucketInfo?id=bkt-1 "),
            "{}",
            details[0].line
        );
        assert!(
            !details[0].line.contains("globalAlias"),
            "{}",
            details[0].line
        );
        assert!(!details[0].line.contains("search"), "{}", details[0].line);
    }

    #[tokio::test]
    async fn bucket_detail_encodes_an_id_with_ampersand_or_equals() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"kept"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/a%26b%3Dc", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, r#"{"id":"kept"}"#);
        let details = bucket_info_calls(&mock);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            details
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            details[0]
                .line
                .contains("GET /v2/GetBucketInfo?id=a%26b%3Dc "),
            "{}",
            details[0].line
        );
        assert!(
            !details[0].line.contains("globalAlias"),
            "{}",
            details[0].line
        );
        assert!(!details[0].line.contains("search"), "{}", details[0].line);
    }

    #[tokio::test]
    async fn viewer_can_read_one_bucket() {
        let mock = Upstream::start(UpstreamReply::Ok(BUCKET_DIGITS.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1", None, Some(&viewer)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, BUCKET_DIGITS);
        let details = bucket_info_calls(&mock);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            details[0].line.contains("GET /v2/GetBucketInfo?id=bkt-1 "),
            "{}",
            details[0].line
        );
    }

    #[tokio::test]
    async fn bucket_detail_requires_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let anonymous = exchange(&app, request("GET", "/api/buckets/bkt-1", None, None)).await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1", None, Some(&admin)),
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
    async fn bucket_detail_keeps_upstream_404() {
        let body = r#"{"message":"Bucket not found"}"#.to_string();
        let mock = Upstream::start(UpstreamReply::Fixed("404 Not Found", body.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/missing", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{}", response.body);
        assert_eq!(response.body, body);
        assert!(!response.body.contains("garage_unavailable"));
    }

    #[tokio::test]
    async fn mismatched_alias_bucket_id_stays_local() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"ok":true}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        for method in ["POST", "DELETE"] {
            let response = exchange(
                &app,
                request(
                    method,
                    "/api/buckets/bkt-1/aliases",
                    Some(r#"{"bucketId":"other","globalAlias":"photos"}"#),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &response,
                StatusCode::BAD_REQUEST,
                "bucket_id_mismatch",
                "Bucket id does not match",
            );
        }
        assert_eq!(mock.hits(), 0);
    }

    #[tokio::test]
    async fn alias_routes_send_path_id_to_garage() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let added = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"bucketId":"bkt-1","globalAlias":"photos"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(added.status, StatusCode::OK, "{}", added.body);
        let removed = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"localAlias":"photos","accessKeyId":"GK1"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);
        let calls = mock.calls();
        let add = calls
            .iter()
            .find(|call| call.line.contains("POST /v2/AddBucketAlias "))
            .expect("add");
        assert_eq!(
            serde_json::from_str::<Value>(&add.body).unwrap(),
            json!({"bucketId":"bkt-1","globalAlias":"photos"})
        );
        let remove = calls
            .iter()
            .find(|call| call.line.contains("POST /v2/RemoveBucketAlias "))
            .expect("remove");
        assert_eq!(
            serde_json::from_str::<Value>(&remove.body).unwrap(),
            json!({"bucketId":"bkt-1","localAlias":"photos","accessKeyId":"GK1"})
        );
    }

    #[tokio::test]
    async fn bucket_mutations_require_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        for (method, path, body) in [
            ("POST", "/api/buckets", Some("{}")),
            ("DELETE", "/api/buckets/bkt-1", None),
            (
                "POST",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"globalAlias":"photos"}"#),
            ),
            (
                "DELETE",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"globalAlias":"photos"}"#),
            ),
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
            request("POST", "/api/buckets", Some("{}"), Some(&admin)),
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
    async fn quota_keeps_the_large_size_digits() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/a%20b%26c%3Dd/quotas",
                Some(r#"{"maxObjects":12,"maxSize":9007199254740993}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, r#"{"id":"bkt-1"}"#);
        let updates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("UpdateBucket"))
            .collect();
        assert_eq!(
            updates.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            updates[0]
                .line
                .contains("POST /v2/UpdateBucket?id=a%20b%26c%3Dd "),
            "{}",
            updates[0].line
        );
        assert_eq!(
            updates[0].body,
            r#"{"quotas":{"maxSize":9007199254740993,"maxObjects":12}}"#
        );
    }

    #[tokio::test]
    async fn quota_nulls_clear_both_fields() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxObjects":null,"maxSize":null}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let updates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/UpdateBucket?id=bkt-1 "))
            .collect();
        assert_eq!(updates.len(), 1);
        assert_eq!(
            updates[0].body,
            r#"{"quotas":{"maxSize":null,"maxObjects":null}}"#
        );
    }

    #[tokio::test]
    async fn rejected_quota_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        for body in [
            r#"{"maxSize":1}"#,
            r#"{"maxObjects":1}"#,
            r#"{"maxSize":-1,"maxObjects":1}"#,
            r#"{"maxSize":1.5,"maxObjects":1}"#,
            r#"{"maxSize":1e2,"maxObjects":2}"#,
            r#"{"maxSize":01,"maxObjects":1}"#,
        ] {
            let response = exchange(
                &app,
                request("PUT", "/api/buckets/bkt-1/quotas", Some(body), Some(&admin)),
            )
            .await;
            assert_error(
                &response,
                StatusCode::BAD_REQUEST,
                "invalid_quota",
                "maxSize and maxObjects must be non-negative integers or null",
            );
        }
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn bucket_quota_rejection_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxSize":1}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "invalid_quota",
            "maxSize and maxObjects must be non-negative integers or null",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_quota");
        assert_eq!(row.method, "PUT");
        assert_eq!(row.path, "/api/buckets/quotas");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn viewer_quota_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxSize":1,"maxObjects":2}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn bucket_cors_put_replaces_the_rules_and_get_returns_them() {
        let rules = json!([{
            "ID": "photos",
            "AllowedOrigin": ["https://photos.example"],
            "AllowedMethod": ["GET", "HEAD"],
            "AllowedHeader": ["*"],
            "ExposeHeader": ["ETag"],
            "MaxAgeSeconds": 600
        }]);
        let info = json!({
            "id": "bkt-1",
            "corsRules": rules.clone(),
            "lifecycleRules": [{ "ID": "expire", "Status": "Enabled" }]
        });
        let mock = Upstream::start(UpstreamReply::Ok(info.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let read = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/cors", None, Some(&admin)),
        )
        .await;
        assert_eq!(read.status, StatusCode::OK, "{}", read.body);
        assert_eq!(
            serde_json::from_str::<Value>(&read.body).unwrap(),
            json!({ "corsRules": rules })
        );
        assert!(!read.body.contains("lifecycleRules"), "{}", read.body);
        let details = bucket_info_calls(&mock);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            details
                .iter()
                .map(|call| &call.line)
                .collect::<Vec<_>>()
        );
        assert!(
            details[0].line.contains("GET /v2/GetBucketInfo?id=bkt-1 "),
            "{}",
            details[0].line
        );

        let replaced = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/cors",
                Some(&json!({ "corsRules": rules }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(replaced.status, StatusCode::OK, "{}", replaced.body);
        let updates = |mock: &Upstream| {
            mock.calls()
                .into_iter()
                .filter(|call| call.line.contains("UpdateBucket"))
                .collect::<Vec<_>>()
        };
        let sent = updates(&mock);
        assert_eq!(
            sent.len(),
            1,
            "{:?}",
            sent.iter().map(|call| &call.line).collect::<Vec<_>>()
        );
        assert!(
            sent[0].line.contains("POST /v2/UpdateBucket?id=bkt-1 "),
            "{}",
            sent[0].line
        );
        let sent_body: Value = serde_json::from_str(&sent[0].body).unwrap();
        assert_eq!(sent_body, json!({ "corsRules": rules }));
        assert!(sent_body.get("lifecycleRules").is_none(), "{}", sent[0].body);

        let cleared = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/cors",
                Some(r#"{"corsRules":[]}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.body);
        let sent = updates(&mock);
        assert_eq!(sent.len(), 2);
        assert_eq!(
            serde_json::from_str::<Value>(&sent[1].body).unwrap(),
            json!({ "corsRules": [] })
        );

        let viewer = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/cors",
                Some(&json!({ "corsRules": rules }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(updates(&mock).len(), 2);

        let missing = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/cors",
                Some("{}"),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(missing.status, StatusCode::BAD_REQUEST, "{}", missing.body);
        assert_eq!(updates(&mock).len(), 2);
    }

    #[tokio::test]
    async fn bucket_lifecycle_put_replaces_the_rules_and_get_returns_them() {
        let rules = json!([{
            "ID": "expire",
            "Status": "Enabled"
        }]);
        let info = json!({
            "id": "bkt-1",
            "corsRules": [{
                "ID": "photos",
                "AllowedOrigin": ["https://photos.example"]
            }],
            "lifecycleRules": rules.clone(),
        });
        let mock = Upstream::start(UpstreamReply::Ok(info.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let read = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/lifecycle", None, Some(&admin)),
        )
        .await;
        assert_eq!(read.status, StatusCode::OK, "{}", read.body);
        assert_eq!(
            serde_json::from_str::<Value>(&read.body).unwrap(),
            json!({ "lifecycleRules": rules })
        );
        assert!(!read.body.contains("corsRules"), "{}", read.body);
        let details = bucket_info_calls(&mock);
        assert_eq!(
            details.len(),
            1,
            "{:?}",
            details
                .iter()
                .map(|call| &call.line)
                .collect::<Vec<_>>()
        );
        assert!(
            details[0].line.contains("GET /v2/GetBucketInfo?id=bkt-1 "),
            "{}",
            details[0].line
        );

        let replaced = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/lifecycle",
                Some(&json!({ "lifecycleRules": rules }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(replaced.status, StatusCode::OK, "{}", replaced.body);
        let updates = |mock: &Upstream| {
            mock.calls()
                .into_iter()
                .filter(|call| call.line.contains("UpdateBucket"))
                .collect::<Vec<_>>()
        };
        let sent = updates(&mock);
        assert_eq!(
            sent.len(),
            1,
            "{:?}",
            sent.iter().map(|call| &call.line).collect::<Vec<_>>()
        );
        assert!(
            sent[0].line.contains("POST /v2/UpdateBucket?id=bkt-1 "),
            "{}",
            sent[0].line
        );
        let sent_body: Value = serde_json::from_str(&sent[0].body).unwrap();
        assert_eq!(sent_body, json!({ "lifecycleRules": rules }));
        assert!(sent_body.get("corsRules").is_none(), "{}", sent[0].body);

        let cleared = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/lifecycle",
                Some(r#"{"lifecycleRules":[]}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.body);
        let sent = updates(&mock);
        assert_eq!(sent.len(), 2);
        assert_eq!(
            serde_json::from_str::<Value>(&sent[1].body).unwrap(),
            json!({ "lifecycleRules": [] })
        );

        let viewer = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/lifecycle",
                Some(&json!({ "lifecycleRules": rules }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(updates(&mock).len(), 2);

        let missing = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/lifecycle",
                Some("{}"),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &missing,
            StatusCode::BAD_REQUEST,
            "invalid_lifecycle",
            "lifecycleRules must be an array",
        );
        assert_eq!(updates(&mock).len(), 2);
    }

    fn multipart_uploads_xml(uploads: &[(&str, &str, &str)]) -> String {
        let mut xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>bkt-1</Bucket><IsTruncated>false</IsTruncated>"#,
        );
        for (key, upload_id, initiated) in uploads {
            xml.push_str(&format!(
                "<Upload><Key>{key}</Key><UploadId>{upload_id}</UploadId><Initiated>{initiated}</Initiated></Upload>"
            ));
        }
        xml.push_str("</ListMultipartUploadsResult>");
        http_xml(&xml)
    }

    fn cleanup_calls(mock: &Upstream) -> Vec<UpstreamCall> {
        mock.calls()
            .into_iter()
            .filter(|call| call.line.contains("CleanupIncompleteUploads"))
            .collect()
    }

    #[tokio::test]
    async fn cleanup_drops_uploads_older_than_the_threshold() {
        let admin = Upstream::start(UpstreamReply::Ok(
            r#"{"uploadsDeleted":1}"#.to_string(),
        ))
        .await;
        let calls = Arc::clone(&admin.calls);
        let s3 = S3Mock::start(move |line| {
            if !line.contains("uploads") {
                return "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string();
            }
            let cleaned = calls.lock().expect("admin calls").iter().any(|call| {
                call.line.contains("CleanupIncompleteUploads")
            });
            if cleaned {
                multipart_uploads_xml(&[])
            } else {
                multipart_uploads_xml(&[("old.bin", "up-old", "2000-01-01T00:00:00Z")])
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", admin.url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("S3_ENDPOINT_URL", s3.url.as_str()),
                ("S3_REGION", "garage"),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
            ],
            test_quota(),
        )
        .await;
        let (session, _) = login(&app).await;

        let rejected = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/cleanup-uploads",
                Some(r#"{"olderThanSecs":-1}"#),
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &rejected,
            StatusCode::BAD_REQUEST,
            "invalid_age",
            "olderThanSecs must be an integer that is at least 0",
        );
        assert!(
            cleanup_calls(&admin).is_empty(),
            "{:?}",
            admin.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );

        let listed = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/multipart",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "uploads": [{
                    "key": "old.bin",
                    "uploadId": "up-old",
                    "initiated": "2000-01-01T00:00:00Z"
                }]
            })
        );

        let cleaned = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/cleanup-uploads",
                Some(r#"{"olderThanSecs":3600}"#),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(cleaned.status, StatusCode::OK, "{}", cleaned.body);
        assert_eq!(
            serde_json::from_str::<Value>(&cleaned.body).unwrap(),
            json!({ "uploadsDeleted": 1 })
        );
        let sent = cleanup_calls(&admin);
        assert_eq!(
            sent.len(),
            1,
            "{:?}",
            admin.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            sent[0].line.contains("POST /v2/CleanupIncompleteUploads "),
            "{}",
            sent[0].line
        );
        assert!(!sent[0].line.contains('?'), "{}", sent[0].line);
        let sent_body: Value = serde_json::from_str(&sent[0].body).unwrap();
        assert_eq!(
            sent_body,
            json!({ "bucketId": "bkt-1", "olderThanSecs": 3600 })
        );
        assert!(!sent[0].body.contains("uploadsDeleted"), "{}", sent[0].body);

        let empty = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/multipart",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(empty.status, StatusCode::OK, "{}", empty.body);
        assert_eq!(
            serde_json::from_str::<Value>(&empty.body).unwrap(),
            json!({ "uploads": [] })
        );
        assert!(!empty.body.contains("up-old"), "{}", empty.body);

        let viewer = viewer_session(&app, &session).await;
        let denied = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/cleanup-uploads",
                Some(r#"{"olderThanSecs":3600}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(cleanup_calls(&admin).len(), 1);
    }

    #[tokio::test]
    async fn abort_one_leaves_the_other_and_an_empty_body_aborts_the_rest() {
        let aborted = Arc::new(Mutex::new(Vec::<String>::new()));
        let recorded = Arc::clone(&aborted);
        let s3 = S3Mock::start(move |line| {
            if line.contains("uploadId=") {
                let id = query_value(request_target(line), "uploadId")
                    .map(percent_decode)
                    .unwrap_or_default();
                if id == "nope" {
                    return head_missing();
                }
                recorded.lock().expect("aborted uploads").push(id);
                return delete_ok();
            }
            if line.contains("uploads") {
                let gone = recorded.lock().expect("aborted uploads").clone();
                let pending: Vec<_> = [
                    ("old.bin", "up-old", "2000-01-01T00:00:00Z"),
                    ("new.bin", "up-new", "2000-01-02T00:00:00Z"),
                ]
                .into_iter()
                .filter(|(_, id, _)| !gone.iter().any(|seen| seen == id))
                .collect();
                return multipart_uploads_xml(&pending);
            }
            head_missing()
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &s3.url, true).await;
        let (session, _) = login(&app).await;
        let abort_lines = |mock: &S3Mock| {
            mock.requests()
                .into_iter()
                .filter(|line| line.contains("uploadId="))
                .collect::<Vec<_>>()
        };

        let missing = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/multipart",
                Some(r#"{"key":"missing","uploadId":"nope"}"#),
                Some(&session),
            ),
        )
        .await;
        assert_error(&missing, StatusCode::NOT_FOUND, "not_found", "Not found");
        assert!(
            s3.requests().iter().any(|line| line.contains("uploadId=nope")),
            "missing upload was not sent to S3: {:?}",
            s3.requests()
        );
        assert!(
            aborted.lock().expect("aborted uploads").is_empty(),
            "404 was recorded as a successful abort: {:?}",
            aborted.lock().expect("aborted uploads")
        );

        let one = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/multipart",
                Some(r#"{"key":"old.bin","uploadId":"up-old"}"#),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(one.status, StatusCode::OK, "{}", one.body);
        assert_eq!(
            serde_json::from_str::<Value>(&one.body).unwrap(),
            json!({ "aborted": 1 })
        );
        let lines = abort_lines(&s3);
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("up-old") && !line.contains("up-new"))
                .count(),
            1,
            "{lines:?}"
        );
        assert!(
            s3.requests().iter().all(|line| !line.contains("uploads")),
            "aborting one upload listed first: {:?}",
            s3.requests()
        );

        let listed = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/multipart", None, Some(&session)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "uploads": [{
                    "key": "new.bin",
                    "uploadId": "up-new",
                    "initiated": "2000-01-02T00:00:00Z"
                }]
            })
        );

        let before = abort_lines(&s3);
        let rest = exchange(
            &app,
            request("DELETE", "/api/buckets/bkt-1/multipart", None, Some(&session)),
        )
        .await;
        assert_eq!(rest.status, StatusCode::OK, "{}", rest.body);
        assert_eq!(
            serde_json::from_str::<Value>(&rest.body).unwrap(),
            json!({ "aborted": 1 })
        );
        let lines = abort_lines(&s3);
        assert_eq!(lines.len(), before.len() + 1, "{lines:?}");
        assert!(
            lines[before.len()].contains("up-new"),
            "{lines:?}"
        );

        let empty = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/multipart", None, Some(&session)),
        )
        .await;
        assert_eq!(empty.status, StatusCode::OK, "{}", empty.body);
        assert_eq!(
            serde_json::from_str::<Value>(&empty.body).unwrap(),
            json!({ "uploads": [] })
        );

        let viewer = viewer_session(&app, &session).await;
        let kept = abort_lines(&s3).len();
        let denied = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/multipart",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(abort_lines(&s3).len(), kept);
    }

    #[tokio::test]
    async fn bucket_write_denials_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/buckets",
                Some(&json!({ "globalAlias": "photos" }).to_string()),
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
        assert_eq!(row.path, "/api/buckets");
        assert_eq!(row.target, "photos");
        assert_eq!(row.status, 403);

        let removed = exchange(
            &app,
            request("DELETE", "/api/buckets/bkt-1", None, Some(&viewer)),
        )
        .await;
        assert_error(&removed, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);

        let quotas = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxSize":null,"maxObjects":null}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&quotas, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 3, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "PUT");
        assert_eq!(row.path, "/api/buckets/quotas");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn bucket_alias_denials_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let added = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"globalAlias":"photos"}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&added, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/aliases");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);

        let removed = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"globalAlias":"photos"}"#),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&removed, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets/aliases");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn bucket_alias_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let empty = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/aliases",
                Some("{}"),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &empty,
            StatusCode::BAD_REQUEST,
            "invalid_alias",
            "Alias must be global or local",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_alias");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/aliases");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);

        let mismatch = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/aliases",
                Some(r#"{"bucketId":"other","globalAlias":"photos"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &mismatch,
            StatusCode::BAD_REQUEST,
            "bucket_id_mismatch",
            "Bucket id does not match",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "bucket_id_mismatch");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/aliases");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn bucket_permission_denials_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let body =
            r#"{"accessKeyId":"GK1","permissions":{"owner":false,"read":true,"write":false}}"#;

        let granted = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/permissions",
                Some(body),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&granted, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/permissions");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);

        let revoked = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/permissions",
                Some(body),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&revoked, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets/permissions");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn bucket_permission_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let empty = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/permissions",
                Some("{}"),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &empty,
            StatusCode::BAD_REQUEST,
            "invalid_permission",
            "accessKeyId and boolean permissions are required",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_permission");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/permissions");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);

        let mismatch = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/permissions",
                Some(
                    r#"{"bucketId":"other","accessKeyId":"GK1","permissions":{"owner":false,"read":true,"write":false}}"#,
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &mismatch,
            StatusCode::BAD_REQUEST,
            "bucket_id_mismatch",
            "Bucket id does not match",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "bucket_id_mismatch");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/permissions");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn quota_requires_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let anonymous = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxSize":1,"maxObjects":2}"#),
                None,
            ),
        )
        .await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "PUT",
                "/api/buckets/bkt-1/quotas",
                Some(r#"{"maxSize":1,"maxObjects":2}"#),
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
    async fn grant_and_revoke_forward_every_permission_bit() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"a&b=c"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let path = "/api/buckets/a%26b%3Dc/permissions";
        let granted = exchange(
            &app,
            request(
                "POST",
                path,
                Some(
                    r#"{"bucketId":"a&b=c","accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":true}}"#,
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(granted.status, StatusCode::OK, "{}", granted.body);
        assert_eq!(granted.body, r#"{"id":"a&b=c"}"#);
        let revoked = exchange(
            &app,
            request(
                "DELETE",
                path,
                Some(
                    r#"{"accessKeyId":"GK1","permissions":{"owner":false,"read":true,"write":false}}"#,
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(revoked.status, StatusCode::OK, "{}", revoked.body);
        let calls = mock.calls();
        let allows: Vec<_> = calls
            .iter()
            .filter(|call| call.line.contains("AllowBucketKey"))
            .collect();
        let denies: Vec<_> = calls
            .iter()
            .filter(|call| call.line.contains("DenyBucketKey"))
            .collect();
        assert_eq!(
            allows.len(),
            1,
            "{:?}",
            calls.iter().map(|call| &call.line).collect::<Vec<_>>()
        );
        assert_eq!(
            denies.len(),
            1,
            "{:?}",
            calls.iter().map(|call| &call.line).collect::<Vec<_>>()
        );
        assert!(
            allows[0].line.contains("POST /v2/AllowBucketKey "),
            "{}",
            allows[0].line
        );
        assert!(
            denies[0].line.contains("POST /v2/DenyBucketKey "),
            "{}",
            denies[0].line
        );
        assert!(!allows[0].line.contains('?'), "{}", allows[0].line);
        assert!(!denies[0].line.contains('?'), "{}", denies[0].line);
        assert_eq!(
            allows[0].body,
            r#"{"bucketId":"a&b=c","accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":true}}"#
        );
        assert_eq!(
            denies[0].body,
            r#"{"bucketId":"a&b=c","accessKeyId":"GK1","permissions":{"owner":false,"read":true,"write":false}}"#
        );
    }

    #[tokio::test]
    async fn rejected_permission_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let path = "/api/buckets/bkt-1/permissions";
        for method in ["POST", "DELETE"] {
            let none = exchange(
                &app,
                request(
                    method,
                    path,
                    Some(
                        r#"{"accessKeyId":"GK1","permissions":{"owner":false,"read":false,"write":false}}"#,
                    ),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &none,
                StatusCode::BAD_REQUEST,
                "invalid_permission",
                "Select at least one permission",
            );
            let mismatch = exchange(
                &app,
                request(
                    method,
                    path,
                    Some(
                        r#"{"bucketId":"other","accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":false}}"#,
                    ),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &mismatch,
                StatusCode::BAD_REQUEST,
                "bucket_id_mismatch",
                "Bucket id does not match",
            );
            for body in [
                r#"{"accessKeyId":"","permissions":{"owner":true,"read":false,"write":false}}"#,
                r#"{"permissions":{"owner":true,"read":true,"write":false}}"#,
                r#"{"accessKeyId":"GK1","permissions":{"owner":true,"write":false}}"#,
                r#"{"accessKeyId":"GK1","permissions":{"owner":true,"read":"yes","write":false}}"#,
                r#"{"accessKeyId":"GK1","websiteAccess":true,"permissions":{"owner":true,"read":true,"write":false}}"#,
                r#"{"accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":false,"websiteAccess":true}}"#,
            ] {
                let response =
                    exchange(&app, request(method, path, Some(body), Some(&admin))).await;
                assert_error(
                    &response,
                    StatusCode::BAD_REQUEST,
                    "invalid_permission",
                    "accessKeyId and boolean permissions are required",
                );
            }
        }
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn viewer_permission_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{"id":"bkt-1"}"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let body = r#"{"accessKeyId":"GK1","permissions":{"owner":true,"read":true,"write":true}}"#;
        for method in ["POST", "DELETE"] {
            let response = exchange(
                &app,
                request(
                    method,
                    "/api/buckets/bkt-1/permissions",
                    Some(body),
                    Some(&viewer),
                ),
            )
            .await;
            assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        }
        assert_eq!(
            mock.hits(),
            0,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn permission_requires_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let body =
            r#"{"accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":false}}"#;
        for method in ["POST", "DELETE"] {
            let response = exchange(
                &app,
                request(method, "/api/buckets/bkt-1/permissions", Some(body), None),
            )
            .await;
            assert_error(
                &response,
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Login required",
            );
        }
        let (admin, _) = login(&app).await;
        for method in ["POST", "DELETE"] {
            let response = exchange(
                &app,
                request(
                    method,
                    "/api/buckets/bkt-1/permissions",
                    Some(body),
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
    }

    #[tokio::test]
    async fn old_garage_blocks_bucket_permission() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/permissions",
                Some(
                    r#"{"accessKeyId":"GK1","permissions":{"owner":true,"read":false,"write":false}}"#,
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::CONFLICT,
            "garage_too_old",
            "Garage v2.3.0 or newer is required",
        );
        assert!(
            mock.requests()
                .iter()
                .all(|line| !line.contains("AllowBucketKey")),
            "{:?}",
            mock.requests()
        );
    }

    #[tokio::test]
    async fn old_garage_blocks_bucket_create() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("POST", "/api/buckets", Some("{}"), Some(&admin)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::CONFLICT,
            "garage_too_old",
            "Garage v2.3.0 or newer is required",
        );
        assert!(
            mock.requests()
                .iter()
                .all(|line| !line.contains("CreateBucket"))
        );
    }

    #[tokio::test]
    async fn bucket_list_keeps_upstream_status_and_404_stays_absent() {
        let denied = ListStatus::start(ListReply::InfoThenPage).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &denied.url).await;
        let (session, _) = login(&app).await;

        let blocked = exchange(&app, request("GET", "/api/buckets", None, Some(&session))).await;
        assert_eq!(blocked.status, StatusCode::FORBIDDEN, "{}", blocked.body);
        assert_eq!(
            serde_json::from_str::<Value>(&blocked.body).unwrap(),
            json!({
                "code": "upstream_error",
                "message": "denied by policy",
                "garageStatus": 403
            })
        );
        assert!(
            denied
                .requests()
                .iter()
                .any(|line| line.contains("ListBucketsInfo"))
        );
        assert!(
            denied
                .requests()
                .iter()
                .all(|line| !line.contains("ListBuckets "))
        );

        let page = exchange(&app, request("GET", "/api/buckets", None, Some(&session))).await;
        assert_page(&page, json!([{ "id": "b0" }]), false);
        assert_eq!(
            denied
                .requests()
                .iter()
                .filter(|line| line.contains("ListBucketsInfo"))
                .count(),
            2
        );
        assert!(
            denied
                .requests()
                .iter()
                .all(|line| !line.contains("ListBuckets "))
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(TOKEN));
        assert!(!sink.contains("denied by policy"));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let closed = crate::util::temp_dir();
        let refused = app_for(&closed, &format!("http://127.0.0.1:{port}")).await;
        let (refused_session, _) = login(&refused).await;
        let down = exchange(
            &refused,
            request("GET", "/api/buckets", None, Some(&refused_session)),
        )
        .await;
        assert_error(
            &down,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not reachable",
        );

        let ids = ListStatus::start(ListReply::Fixed(
            "404 Not Found",
            "application/json",
            r#"{"error":"not found"}"#,
        ))
        .await;
        let fallback = crate::util::temp_dir();
        let fallback_app = app_for(&fallback, &ids.url).await;
        let (fallback_session, _) = login(&fallback_app).await;
        let listed = exchange(
            &fallback_app,
            request("GET", "/api/buckets", None, Some(&fallback_session)),
        )
        .await;
        assert_eq!(
            listed.status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{}",
            listed.body
        );
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "code": "upstream_error",
                "message": "id list",
                "garageStatus": 500
            })
        );
        assert!(
            ids.requests()
                .iter()
                .any(|line| line.contains("ListBucketsInfo"))
        );
        assert!(
            ids.requests()
                .iter()
                .any(|line| line.contains("ListBuckets "))
        );
        assert!(
            ids.requests()
                .iter()
                .all(|line| !line.contains("GetBucketInfo"))
        );

        let json_error = ListStatus::start(ListReply::Fixed(
            "400 Bad Request",
            "application/json",
            r#"{"error":"nope"}"#,
        ))
        .await;
        let json_dir = crate::util::temp_dir();
        let json_app = app_for(&json_dir, &json_error.url).await;
        let (json_session, _) = login(&json_app).await;
        let passed = exchange(
            &json_app,
            request("GET", "/api/buckets", None, Some(&json_session)),
        )
        .await;
        assert_eq!(passed.status, StatusCode::BAD_REQUEST, "{}", passed.body);
        assert_eq!(passed.body, r#"{"error":"nope"}"#);
        assert!(
            json_error
                .requests()
                .iter()
                .all(|line| !line.contains("ListBuckets "))
        );
    }

    #[tokio::test]
    async fn admin_timeout_is_504_and_refusal_stays_502() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stall_port = listener.local_addr().unwrap().port();
        let stall = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let _hold = socket;
                std::future::pending::<()>().await;
            }
        });
        let stall_url = format!("http://127.0.0.1:{stall_port}");
        let stall_dir = crate::util::temp_dir();
        let stalled = state::test_app_with(
            &stall_dir,
            &[
                ("GARAGE_ADMIN_URL", stall_url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("GARAGE_ADMIN_CONNECT_TIMEOUT_SECS", "1"),
                ("GARAGE_ADMIN_TIMEOUT_SECS", "1"),
            ],
            test_quota(),
        )
        .await;
        let (admin, _) = login(&stalled).await;
        let timed_out =
            exchange(&stalled, request("GET", "/api/buckets", None, Some(&admin))).await;
        stall.abort();
        assert_eq!(timed_out.status, StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(code_of(&timed_out.body), "garage_timeout");
        assert!(!timed_out.body.contains(TOKEN));

        let refused = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let refused_port = refused.local_addr().unwrap().port();
        drop(refused);
        let refused_url = format!("http://127.0.0.1:{refused_port}");
        let refused_dir = crate::util::temp_dir();
        let down = state::test_app_with(
            &refused_dir,
            &[
                ("GARAGE_ADMIN_URL", refused_url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("GARAGE_ADMIN_CONNECT_TIMEOUT_SECS", "1"),
                ("GARAGE_ADMIN_TIMEOUT_SECS", "1"),
            ],
            test_quota(),
        )
        .await;
        let (admin, _) = login(&down).await;
        let refused_response =
            exchange(&down, request("GET", "/api/buckets", None, Some(&admin))).await;
        assert_eq!(refused_response.status, StatusCode::BAD_GATEWAY);
        assert_eq!(code_of(&refused_response.body), "garage_unavailable");
        assert!(!refused_response.body.contains(TOKEN));
    }
