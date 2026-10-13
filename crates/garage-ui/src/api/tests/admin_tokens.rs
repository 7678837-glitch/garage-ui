
    #[tokio::test]
    async fn admin_token_list_hides_the_secret_and_marks_a_null_id() {
        let secret = "fixture-not-a-token";
        let garage = json!([
            {
                "id": null,
                "name": "admin_token",
                "created": null,
                "expiration": null,
                "expired": false,
                "scope": ["*"],
                "secretToken": secret
            },
            {
                "id": "gk-admin-1",
                "name": "reader",
                "created": "2026-03-01T00:00:00Z",
                "expiration": null,
                "expired": false,
                "scope": ["GetClusterStatus", "Metrics"],
                "secretToken": secret
            }
        ])
        .to_string();
        let mock = Upstream::start(UpstreamReply::Ok(garage)).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let listed = exchange(
            &app,
            request("GET", "/api/admin-tokens", None, Some(&admin)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "items": [
                    {
                        "id": null,
                        "name": "admin_token",
                        "created": null,
                        "expiration": null,
                        "expired": false,
                        "scope": ["*"],
                        "fromConfig": true
                    },
                    {
                        "id": "gk-admin-1",
                        "name": "reader",
                        "created": "2026-03-01T00:00:00Z",
                        "expiration": null,
                        "expired": false,
                        "scope": ["GetClusterStatus", "Metrics"],
                        "fromConfig": false
                    }
                ],
                "hasMore": false
            })
        );
        assert!(!listed.body.contains("secretToken"));
        assert!(!listed.body.contains(secret));
        let admin_calls = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("ListAdminTokens"))
            .count();
        assert_eq!(admin_calls, 1);

        let viewer = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            request("GET", "/api/admin-tokens", None, Some(&viewer)),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        let denied_rows: Vec<_> = rows
            .iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        let viewer_calls = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("ListAdminTokens"))
            .count();
        assert_eq!(viewer_calls, 1);
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));
    }

    #[tokio::test]
    async fn admin_token_get_drops_the_secret() {
        let token_id = "fixture-get-1";
        let secret = "fixture-get-secret";
        let path = format!("/api/admin-tokens/{token_id}?search=nope");
        let upstream = json!({
            "secretToken": secret,
            "id": token_id,
            "name": "reader",
            "created": "2026-03-01T00:00:00Z",
            "expiration": null,
            "expired": false,
            "scope": ["GetClusterStatus"],
            "neverExpires": false
        });
        let mock = Upstream::start(UpstreamReply::Ok(upstream.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap().len();
        let response = exchange(&app, request("GET", &path, None, Some(&admin))).await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({
                "id": token_id,
                "name": "reader",
                "created": "2026-03-01T00:00:00Z",
                "expiration": null,
                "expired": false,
                "scope": ["GetClusterStatus"],
                "fromConfig": false
            })
        );
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        assert!(!response.body.contains(secret));
        assert!(!response.body.contains("secretToken"));
        let gets: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("GET /v2/GetAdminTokenInfo"))
            .collect();
        assert_eq!(
            gets.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            gets[0].line.contains(&format!("id={token_id}")),
            "{}",
            gets[0].line
        );
        assert!(!gets[0].line.contains("search"), "{}", gets[0].line);
        assert_eq!(
            crate::db::recent_audit(&app.db).await.unwrap().len(),
            before
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));

        let blocked = Upstream::start(UpstreamReply::Ok(upstream.to_string())).await;
        let blocked_dir = crate::util::temp_dir();
        let blocked_app = app_for(&blocked_dir, &blocked.url).await;
        let (blocked_admin, _) = login(&blocked_app).await;
        let viewer = viewer_session(&blocked_app, &blocked_admin).await;
        let denied = exchange(&blocked_app, request("GET", &path, None, Some(&viewer))).await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let denied_rows: Vec<_> = crate::db::recent_audit(&blocked_app.db)
            .await
            .unwrap()
            .into_iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        assert!(
            blocked
                .calls()
                .iter()
                .all(|call| !call.line.contains("GetAdminTokenInfo"))
        );
        let blocked_sink = blocked_app.log_sink.lock().expect("logs").join("\n");
        assert!(!blocked_sink.contains(secret));
        assert!(!blocked_sink.contains("secretToken"));
    }

    #[tokio::test]
    async fn current_admin_token_hides_the_server_token() {
        let token_id = "fixture-current-id";
        let secret = "fixture-current-secret";
        let upstream = json!({
            "secretToken": secret,
            "id": token_id,
            "name": "server",
            "created": "2026-03-01T00:00:00Z",
            "expiration": "2026-12-01T00:00:00Z",
            "expired": false,
            "scope": ["GetClusterStatus", "Metrics"],
            "neverExpires": false
        });
        let mock = Upstream::start(UpstreamReply::Ok(upstream.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap().len();
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/admin-tokens/current?search=nope",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        let body = serde_json::from_str::<Value>(&response.body).unwrap();
        assert!(body.get("id").is_none(), "{}", response.body);
        assert_eq!(
            body,
            json!({
                "name": "server",
                "created": "2026-03-01T00:00:00Z",
                "expiration": "2026-12-01T00:00:00Z",
                "expired": false,
                "scope": ["GetClusterStatus", "Metrics"],
                "fromConfig": false
            })
        );
        assert!(!response.body.contains(secret));
        assert!(!response.body.contains("secretToken"));
        assert!(!response.body.contains(token_id));
        let gets: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("GET /v2/GetCurrentAdminTokenInfo"))
            .collect();
        assert_eq!(
            gets.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(!gets[0].line.contains('?'), "{}", gets[0].line);
        assert!(!gets[0].line.contains("search"), "{}", gets[0].line);
        assert!(gets[0].body.is_empty(), "{}", gets[0].body);
        assert_eq!(
            crate::db::recent_audit(&app.db).await.unwrap().len(),
            before
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));
        assert!(!sink.contains(token_id));

        let null_upstream = json!({
            "secretToken": secret,
            "id": null,
            "name": "admin_token",
            "created": null,
            "expiration": null,
            "expired": false,
            "scope": ["*"]
        });
        let null_mock = Upstream::start(UpstreamReply::Ok(null_upstream.to_string())).await;
        let null_dir = crate::util::temp_dir();
        let null_app = app_for(&null_dir, &null_mock.url).await;
        let (null_admin, _) = login(&null_app).await;
        let null_response = exchange(
            &null_app,
            request(
                "GET",
                "/api/admin-tokens/current?search=nope",
                None,
                Some(&null_admin),
            ),
        )
        .await;
        assert_eq!(
            null_response.status,
            StatusCode::OK,
            "{}",
            null_response.body
        );
        let null_body = serde_json::from_str::<Value>(&null_response.body).unwrap();
        assert!(null_body.get("id").is_none(), "{}", null_response.body);
        assert_eq!(
            null_body,
            json!({
                "name": "admin_token",
                "created": null,
                "expiration": null,
                "expired": false,
                "scope": ["*"],
                "fromConfig": true
            })
        );
        assert!(!null_response.body.contains(secret));
        assert!(!null_response.body.contains("secretToken"));
        let null_sink = null_app.log_sink.lock().expect("logs").join("\n");
        assert!(!null_sink.contains(secret));
        assert!(!null_sink.contains("secretToken"));

        let blocked = Upstream::start(UpstreamReply::Ok(upstream.to_string())).await;
        let blocked_dir = crate::util::temp_dir();
        let blocked_app = app_for(&blocked_dir, &blocked.url).await;
        let (blocked_admin, _) = login(&blocked_app).await;
        let viewer = viewer_session(&blocked_app, &blocked_admin).await;
        let denied = exchange(
            &blocked_app,
            request(
                "GET",
                "/api/admin-tokens/current?search=nope",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let denied_rows: Vec<_> = crate::db::recent_audit(&blocked_app.db)
            .await
            .unwrap()
            .into_iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        assert!(
            blocked
                .calls()
                .iter()
                .all(|call| !call.line.contains("GetCurrentAdminTokenInfo"))
        );
        let blocked_sink = blocked_app.log_sink.lock().expect("logs").join("\n");
        assert!(!blocked_sink.contains(secret));
        assert!(!blocked_sink.contains("secretToken"));
        assert!(!blocked_sink.contains(token_id));
    }

    #[tokio::test]
    async fn admin_token_create_returns_the_secret_once() {
        let secret = "shown-once-fixture";
        let created =
            format!(r#"{{"secretToken":"{secret}","id":"tok-1","name":"reader","expired":false}}"#);
        let sent = json!({
            "name": "reader",
            "expiration": "2026-12-01T00:00:00Z",
            "scope": ["GetClusterStatus", "Metrics"]
        });
        let mock = Upstream::start(UpstreamReply::Ok(created.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            with_confirm(request(
                "POST",
                "/api/admin-tokens",
                Some(&sent.to_string()),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, created);
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        let creates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/CreateAdminToken "))
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
            sent
        );
        assert!(!creates[0].body.contains("secretToken"));
        assert!(!creates[0].body.contains(secret));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        let listed = rows
            .iter()
            .map(|row| {
                format!(
                    "{} {} {} {} {} {} {}",
                    row.username, row.ip, row.result, row.reason, row.method, row.path, row.target
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!listed.contains(secret), "{listed}");
        assert!(rows.iter().any(|row| {
            row.result == "success"
                && row.reason == "ok"
                && row.method == "POST"
                && row.path == "/api/admin-tokens"
                && row.target == "tok-1"
        }));
        assert!(
            rows.iter()
                .any(|row| row.result == "success" && row.target == "CreateAdminToken")
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));

        let bare = Upstream::start(UpstreamReply::Ok(created.clone())).await;
        let bare_dir = crate::util::temp_dir();
        let bare_app = app_for(&bare_dir, &bare.url).await;
        let (bare_admin, _) = login(&bare_app).await;
        let before = crate::db::recent_audit(&bare_app.db).await.unwrap().len();
        let unconfirmed = exchange(
            &bare_app,
            request(
                "POST",
                "/api/admin-tokens",
                Some(&sent.to_string()),
                Some(&bare_admin),
            ),
        )
        .await;
        assert_error(
            &unconfirmed,
            StatusCode::FORBIDDEN,
            "confirmation_required",
            "Confirmation required",
        );
        assert!(
            bare.calls()
                .iter()
                .all(|call| !call.line.contains("CreateAdminToken"))
        );
        assert_eq!(
            crate::db::recent_audit(&bare_app.db).await.unwrap().len(),
            before
        );

        let blocked = Upstream::start(UpstreamReply::Ok(created)).await;
        let blocked_dir = crate::util::temp_dir();
        let blocked_app = app_for(&blocked_dir, &blocked.url).await;
        let (blocked_admin, _) = login(&blocked_app).await;
        let viewer = viewer_session(&blocked_app, &blocked_admin).await;
        let denied = exchange(
            &blocked_app,
            with_confirm(request(
                "POST",
                "/api/admin-tokens",
                Some(&sent.to_string()),
                Some(&viewer),
            )),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let denied_rows: Vec<_> = crate::db::recent_audit(&blocked_app.db)
            .await
            .unwrap()
            .into_iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        assert!(
            blocked
                .calls()
                .iter()
                .all(|call| !call.line.contains("CreateAdminToken"))
        );
    }

    #[tokio::test]
    async fn admin_token_update_drops_the_secret() {
        let token_id = "tok-upd-1";
        let secret = "upd-fixture-secret";
        let path = format!("/api/admin-tokens/{token_id}");
        let upstream = json!({
            "secretToken": secret,
            "id": token_id,
            "name": "renamed",
            "created": "2026-03-01T00:00:00Z",
            "expiration": "2027-01-01T00:00:00Z",
            "expired": false,
            "scope": ["GetClusterStatus"],
            "neverExpires": false
        });
        let sent = json!({
            "name": "renamed",
            "expiration": "2027-01-01T00:00:00Z",
            "scope": ["GetClusterStatus"],
            "neverExpires": false
        });
        let upstream_body = upstream.to_string();
        let mock = Upstream::start(UpstreamReply::Ok(upstream_body.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            with_confirm(request(
                "PATCH",
                &path,
                Some(&sent.to_string()),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let mut expected = upstream;
        expected.as_object_mut().unwrap().remove("secretToken");
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            expected
        );
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        assert!(!response.body.contains(secret));
        assert!(!response.body.contains("secretToken"));
        let updates: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/UpdateAdminToken?"))
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
            updates[0].line.contains(&format!("id={token_id}")),
            "{}",
            updates[0].line
        );
        assert_eq!(
            serde_json::from_str::<Value>(&updates[0].body).unwrap(),
            sent
        );
        assert!(!updates[0].body.contains(secret));
        assert!(!updates[0].body.contains("secretToken"));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        let listed = rows
            .iter()
            .map(|row| {
                format!(
                    "{} {} {} {} {} {} {} {}",
                    row.username,
                    row.ip,
                    row.result,
                    row.reason,
                    row.method,
                    row.path,
                    row.target,
                    row.status
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!listed.contains(secret), "{listed}");
        assert!(rows.iter().any(|row| {
            row.result == "success"
                && row.reason == "ok"
                && row.method == "PATCH"
                && row.path == path
                && row.target == token_id
        }));
        assert!(
            rows.iter()
                .any(|row| row.result == "success" && row.target == "UpdateAdminToken")
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));

        let bare = Upstream::start(UpstreamReply::Ok(upstream_body.clone())).await;
        let bare_dir = crate::util::temp_dir();
        let bare_app = app_for(&bare_dir, &bare.url).await;
        let (bare_admin, _) = login(&bare_app).await;
        let before = crate::db::recent_audit(&bare_app.db).await.unwrap().len();
        let unconfirmed = exchange(
            &bare_app,
            request("PATCH", &path, Some(&sent.to_string()), Some(&bare_admin)),
        )
        .await;
        assert_error(
            &unconfirmed,
            StatusCode::FORBIDDEN,
            "confirmation_required",
            "Confirmation required",
        );
        assert!(
            bare.calls()
                .iter()
                .all(|call| !call.line.contains("UpdateAdminToken"))
        );
        assert_eq!(
            crate::db::recent_audit(&bare_app.db).await.unwrap().len(),
            before
        );

        let blocked = Upstream::start(UpstreamReply::Ok(upstream_body)).await;
        let blocked_dir = crate::util::temp_dir();
        let blocked_app = app_for(&blocked_dir, &blocked.url).await;
        let (blocked_admin, _) = login(&blocked_app).await;
        let viewer = viewer_session(&blocked_app, &blocked_admin).await;
        let denied = exchange(
            &blocked_app,
            with_confirm(request(
                "PATCH",
                &path,
                Some(&sent.to_string()),
                Some(&viewer),
            )),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let denied_rows: Vec<_> = crate::db::recent_audit(&blocked_app.db)
            .await
            .unwrap()
            .into_iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        assert!(
            blocked
                .calls()
                .iter()
                .all(|call| !call.line.contains("UpdateAdminToken"))
        );
    }

    #[tokio::test]
    async fn admin_token_delete_drops_the_secret() {
        let token_id = "tok-del-1";
        let secret = "del-fixture-secret";
        let path = format!("/api/admin-tokens/{token_id}");
        let upstream = json!({
            "secretToken": secret,
            "id": token_id,
            "name": "gone",
            "created": "2026-03-01T00:00:00Z",
            "expiration": null,
            "expired": false,
            "scope": ["GetClusterStatus"]
        });
        let upstream_body = upstream.to_string();
        let mock = Upstream::start(UpstreamReply::Ok(upstream_body.clone())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(&app, request("DELETE", &path, None, Some(&admin))).await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let mut expected = upstream;
        expected.as_object_mut().unwrap().remove("secretToken");
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            expected
        );
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        assert!(!response.body.contains(secret));
        assert!(!response.body.contains("secretToken"));
        let deletes: Vec<_> = mock
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("POST /v2/DeleteAdminToken?"))
            .collect();
        assert_eq!(
            deletes.len(),
            1,
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            deletes[0].line.contains(&format!("id={token_id}")),
            "{}",
            deletes[0].line
        );
        assert!(deletes[0].body.is_empty(), "{}", deletes[0].body);
        assert!(!deletes[0].body.contains(secret));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        let listed = rows
            .iter()
            .map(|row| {
                format!(
                    "{} {} {} {} {} {} {} {}",
                    row.username,
                    row.ip,
                    row.result,
                    row.reason,
                    row.method,
                    row.path,
                    row.target,
                    row.status
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!listed.contains(secret), "{listed}");
        assert!(rows.iter().any(|row| {
            row.result == "success"
                && row.reason == "ok"
                && row.method == "DELETE"
                && row.path == path
                && row.target == token_id
        }));
        assert!(
            rows.iter()
                .any(|row| row.result == "success" && row.target == "DeleteAdminToken")
        );
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(secret));
        assert!(!sink.contains("secretToken"));

        let blocked = Upstream::start(UpstreamReply::Ok(upstream_body)).await;
        let blocked_dir = crate::util::temp_dir();
        let blocked_app = app_for(&blocked_dir, &blocked.url).await;
        let (blocked_admin, _) = login(&blocked_app).await;
        let viewer = viewer_session(&blocked_app, &blocked_admin).await;
        let denied = exchange(&blocked_app, request("DELETE", &path, None, Some(&viewer))).await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let denied_rows: Vec<_> = crate::db::recent_audit(&blocked_app.db)
            .await
            .unwrap()
            .into_iter()
            .filter(|row| row.result == "denied" || row.reason == "forbidden")
            .collect();
        assert_eq!(denied_rows.len(), 1);
        assert_eq!(denied_rows[0].result, "denied");
        assert_eq!(denied_rows[0].reason, "forbidden");
        assert!(
            blocked
                .calls()
                .iter()
                .all(|call| !call.line.contains("DeleteAdminToken"))
        );
    }
