
    fn user_items(body: &str) -> Vec<Value> {
        serde_json::from_str::<Value>(body).unwrap()["items"]
            .as_array()
            .expect("items")
            .clone()
    }

    #[tokio::test]
    async fn user_list_pages_like_buckets() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let ada_created: i64 = sqlx::query_scalar(
            "SELECT created_at FROM users WHERE username = 'Ada' COLLATE NOCASE",
        )
        .fetch_one(&app.db)
        .await
        .unwrap();
        let mut tx = app.db.begin().await.unwrap();
        for index in 0..1000 {
            sqlx::query(
                "INSERT INTO users (
                    username, password_hash, role, can_download, can_share, disabled, created_at
                 ) VALUES (?, 'stored-hash', 'viewer', 0, 0, 0, ?)",
            )
            .bind(format!("n{index:04}"))
            .bind(1_700_000_000 + i64::from(index))
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();

        let listed = exchange(&app, request("GET", "/api/users", None, Some(&session))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let page: Value = serde_json::from_str(&listed.body).unwrap();
        let items = page["items"].as_array().expect("items");
        assert_eq!(items.len(), 100);
        assert_eq!(page["hasMore"], true);
        assert!(!listed.body.contains("password_hash"));
        assert!(!listed.body.contains("stored-hash"));
        let ada = items
            .iter()
            .find(|user| user["username"] == "Ada")
            .expect("Ada");
        assert_eq!(ada["created_at"].as_i64(), Some(ada_created));

        let capped = exchange(
            &app,
            request("GET", "/api/users?limit=1001", None, Some(&session)),
        )
        .await;
        assert_eq!(capped.status, StatusCode::OK, "{}", capped.body);
        let capped_page: Value = serde_json::from_str(&capped.body).unwrap();
        assert_eq!(capped_page["items"].as_array().expect("items").len(), 1000);
        assert_eq!(capped_page["hasMore"], true);
        assert!(!capped.body.contains("password_hash"));

        let last = exchange(
            &app,
            request(
                "GET",
                "/api/users?offset=1000&limit=1000",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(last.status, StatusCode::OK, "{}", last.body);
        let last_page: Value = serde_json::from_str(&last.body).unwrap();
        let last_items = last_page["items"].as_array().expect("items");
        assert_eq!(last_items.len(), 1);
        assert_eq!(last_page["hasMore"], false);
        assert!(!last.body.contains("password_hash"));
        assert!(!last.body.contains("stored-hash"));
        let last_user = &last_items[0];
        assert_eq!(last_user["username"], "n0999");
        let last_id = last_user["id"].as_i64().expect("id");
        let stored_last: Option<i64> =
            sqlx::query_scalar("SELECT created_at FROM users WHERE id = ?")
                .bind(last_id)
                .fetch_one(&app.db)
                .await
                .unwrap();
        match stored_last {
            Some(created_at) => assert_eq!(last_user["created_at"].as_i64(), Some(created_at)),
            None => assert!(last_user.get("created_at").is_none()),
        }

        let rejected = exchange(
            &app,
            request("GET", "/api/users?limit=nope", None, Some(&session)),
        )
        .await;
        assert_error(
            &rejected,
            StatusCode::BAD_REQUEST,
            "invalid_limit",
            "Limit must be a non-negative integer",
        );
    }

    #[tokio::test]
    async fn user_list_reports_created_at() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let stored: i64 = sqlx::query_scalar(
            "SELECT created_at FROM users WHERE username = 'Ada' COLLATE NOCASE",
        )
        .fetch_one(&app.db)
        .await
        .unwrap();
        let response = exchange(&app, request("GET", "/api/users", None, Some(&session))).await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let users = user_items(&response.body);
        let ada = users
            .iter()
            .find(|user| user["username"] == "Ada")
            .expect("user");
        assert_eq!(ada["created_at"].as_i64(), Some(stored));
        assert!(ada.get("password_hash").is_none());
    }

    #[tokio::test]
    async fn admin_reset_drops_the_user_session() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let other_id = users
            .iter()
            .find(|user| user["username"] == "Bea")
            .expect("user")["id"]
            .as_i64()
            .expect("id");
        let submitted = "rotated horse";
        let reset = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{other_id}/reset-password"),
                Some(&json!({ "password": submitted }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert!(!reset.body.contains(submitted));
        assert_eq!(reset.status, StatusCode::NO_CONTENT);

        let other = exchange(&app, request("GET", "/api/config", None, Some(&viewer))).await;
        assert_eq!(other.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&other.body), "unauthenticated");

        let kept = exchange(&app, request("GET", "/api/config", None, Some(&admin))).await;
        assert_eq!(kept.status, StatusCode::OK, "{}", kept.body);
    }

    #[tokio::test]
    async fn disable_drops_the_user_session_after_reenable() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let other_id = users
            .iter()
            .find(|user| user["username"] != "Ada")
            .expect("other user")["id"]
            .as_i64()
            .expect("id");

        let disabled = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{other_id}"),
                Some(&json!({ "disabled": true }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(disabled.status, StatusCode::OK, "{}", disabled.body);

        let enabled = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{other_id}"),
                Some(&json!({ "disabled": false }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(enabled.status, StatusCode::OK, "{}", enabled.body);

        let other = exchange(&app, request("GET", "/api/config", None, Some(&viewer))).await;
        assert_eq!(other.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&other.body), "unauthenticated");

        let kept = exchange(&app, request("GET", "/api/config", None, Some(&admin))).await;
        assert_eq!(kept.status, StatusCode::OK, "{}", kept.body);
    }

    #[tokio::test]
    async fn demote_drops_the_user_session() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cam",
                        "password": PASSWORD,
                        "role": "admin"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let second = sign_in(&app, "Cam", PASSWORD).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let other_id = users
            .iter()
            .find(|user| user["username"] == "Cam")
            .expect("user")["id"]
            .as_i64()
            .expect("id");
        let demoted = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{other_id}"),
                Some(&json!({ "role": "viewer" }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(demoted.status, StatusCode::OK, "{}", demoted.body);

        let stale = exchange(&app, request("GET", "/api/config", None, Some(&second))).await;
        assert_eq!(stale.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&stale.body), "unauthenticated");

        let kept = exchange(&app, request("GET", "/api/config", None, Some(&admin))).await;
        assert_eq!(kept.status, StatusCode::OK, "{}", kept.body);
    }

    #[tokio::test]
    async fn delete_user_drops_the_session() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let other_id = users
            .iter()
            .find(|user| user["username"] == "Bea")
            .expect("user")["id"]
            .as_i64()
            .expect("id");
        let deleted = exchange(
            &app,
            request(
                "DELETE",
                &format!("/api/users/{other_id}"),
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.body);

        let other = exchange(&app, request("GET", "/api/config", None, Some(&viewer))).await;
        assert_eq!(other.status, StatusCode::UNAUTHORIZED);
        assert_eq!(code_of(&other.body), "unauthenticated");

        let kept = exchange(&app, request("GET", "/api/config", None, Some(&admin))).await;
        assert_eq!(kept.status, StatusCode::OK, "{}", kept.body);
    }

    #[tokio::test]
    async fn create_user_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let bad_name = "bad name";
        let submitted = "shortpw";

        let name = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": bad_name,
                        "password": PASSWORD,
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(name.status, StatusCode::BAD_REQUEST, "{}", name.body);
        assert_eq!(code_of(&name.body), "invalid_username");
        assert!(!name.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_username");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, bad_name);
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(PASSWORD));

        let valid_name = "Cara";
        let invalid = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": valid_name,
                        "password": submitted,
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(invalid.status, StatusCode::BAD_REQUEST, "{}", invalid.body);
        assert_eq!(code_of(&invalid.body), "password_invalid");
        assert!(!invalid.body.contains(submitted));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "password_invalid");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, valid_name);
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(submitted));
        assert!(!audit_text(&rows[1]).contains(submitted));
        assert!(!audit_text(&rows[1]).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(submitted));
        assert!(!sink.contains(PASSWORD));
    }

    #[tokio::test]
    async fn create_user_role_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let invalid_role = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": PASSWORD,
                        "role": "editor"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(
            invalid_role.status,
            StatusCode::BAD_REQUEST,
            "{}",
            invalid_role.body
        );
        assert_eq!(code_of(&invalid_role.body), "invalid_role");
        assert!(!invalid_role.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_role");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Cara");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(PASSWORD));

        let share = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Dana",
                        "password": PASSWORD,
                        "role": "viewer",
                        "can_download": false,
                        "can_share": true
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(share.status, StatusCode::BAD_REQUEST, "{}", share.body);
        assert_eq!(code_of(&share.body), "share_requires_download");
        assert!(!share.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let newest = &rows[0];
        assert_eq!(newest.username, "Ada");
        assert_eq!(newest.result, "error");
        assert_eq!(newest.reason, "share_requires_download");
        assert_eq!(newest.method, "POST");
        assert_eq!(newest.path, "/api/users");
        assert_eq!(newest.target, "Dana");
        assert_eq!(newest.status, 400);
        let earlier = &rows[1];
        assert_eq!(earlier.username, "Ada");
        assert_eq!(earlier.result, "error");
        assert_eq!(earlier.reason, "invalid_role");
        assert_eq!(earlier.method, "POST");
        assert_eq!(earlier.path, "/api/users");
        assert_eq!(earlier.target, "Cara");
        assert_eq!(earlier.status, 400);
        assert!(!audit_text(newest).contains(PASSWORD));
        assert!(!audit_text(earlier).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        assert_eq!(users.len(), 1, "{users:?}");
        assert_eq!(users[0]["username"], "Ada");
    }

    #[tokio::test]
    async fn patch_user_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Bea",
                        "password": PASSWORD,
                        "role": "viewer",
                        "can_download": false,
                        "can_share": false
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let created_body: Value = serde_json::from_str(&created.body).unwrap();
        let bea_id = created_body["id"].as_i64().expect("id");
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let invalid_role = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{bea_id}"),
                Some(&json!({ "role": "editor" }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(
            invalid_role.status,
            StatusCode::BAD_REQUEST,
            "{}",
            invalid_role.body
        );
        assert_eq!(code_of(&invalid_role.body), "invalid_role");
        assert!(!invalid_role.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_role");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Bea");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(PASSWORD));

        let share = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{bea_id}"),
                Some(&json!({ "can_share": true }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(share.status, StatusCode::BAD_REQUEST, "{}", share.body);
        assert_eq!(code_of(&share.body), "share_requires_download");
        assert!(!share.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let newest = &rows[0];
        assert_eq!(newest.username, "Ada");
        assert_eq!(newest.result, "error");
        assert_eq!(newest.reason, "share_requires_download");
        assert_eq!(newest.method, "PATCH");
        assert_eq!(newest.path, "/api/users");
        assert_eq!(newest.target, "Bea");
        assert_eq!(newest.status, 400);
        let earlier = &rows[1];
        assert_eq!(earlier.username, "Ada");
        assert_eq!(earlier.result, "error");
        assert_eq!(earlier.reason, "invalid_role");
        assert_eq!(earlier.method, "PATCH");
        assert_eq!(earlier.path, "/api/users");
        assert_eq!(earlier.target, "Bea");
        assert_eq!(earlier.status, 400);
        assert!(!audit_text(newest).contains(PASSWORD));
        assert!(!audit_text(earlier).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));

        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let bea = users
            .iter()
            .find(|user| user["username"] == "Bea")
            .expect("user");
        assert_eq!(bea["role"], "viewer");
        assert_eq!(bea["can_share"], false);
        assert_eq!(bea["disabled"], false);
    }

    #[tokio::test]
    async fn create_user_duplicate_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Ada",
                        "password": PASSWORD,
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
        assert_eq!(code_of(&response.body), "username_taken");
        assert!(!response.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "username_taken");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Ada");
        assert_eq!(row.status, 409);
        assert!(!audit_text(row).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        assert_eq!(users.len(), 1, "{users:?}");
        assert_eq!(users[0]["username"], "Ada");
    }

    #[tokio::test]
    async fn reset_password_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        viewer_session(&app, &admin).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let id_of = |name: &str| {
            users
                .iter()
                .find(|user| user["username"] == name)
                .expect("user")["id"]
                .as_i64()
                .expect("id")
        };
        let admin_id = id_of("Ada");
        let other_id = id_of("Bea");
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let submitted = "shortpw";

        let self_reset = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{admin_id}/reset-password"),
                Some(&json!({ "password": submitted }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(
            self_reset.status,
            StatusCode::BAD_REQUEST,
            "{}",
            self_reset.body
        );
        assert_eq!(code_of(&self_reset.body), "cannot_reset_self");
        assert!(!self_reset.body.contains(submitted));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "cannot_reset_self");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users/reset-password");
        assert_eq!(row.target, "Ada");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(submitted));

        let invalid = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{other_id}/reset-password"),
                Some(&json!({ "password": submitted }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(invalid.status, StatusCode::BAD_REQUEST, "{}", invalid.body);
        assert_eq!(code_of(&invalid.body), "password_invalid");
        assert!(!invalid.body.contains(submitted));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "password_invalid");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users/reset-password");
        assert_eq!(row.target, "Bea");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains(submitted));
        assert!(!audit_text(&rows[1]).contains(submitted));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(submitted));
    }

    #[tokio::test]
    async fn missing_user_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        assert_eq!(users.len(), 1, "{users:?}");
        assert_eq!(users[0]["username"], "Ada");
        let admin_id = users[0]["id"].as_i64().expect("id");
        let missing = admin_id.wrapping_add(1);
        let missing_target = missing.to_string();
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let patched = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{missing}"),
                Some(&json!({}).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(patched.status, StatusCode::NOT_FOUND, "{}", patched.body);
        assert_eq!(code_of(&patched.body), "not_found");
        assert!(!patched.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "not_found");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, missing_target);
        assert_eq!(row.status, 404);
        assert!(!audit_text(row).contains(PASSWORD));

        let removed = exchange(
            &app,
            request(
                "DELETE",
                &format!("/api/users/{missing}"),
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::NOT_FOUND, "{}", removed.body);
        assert_eq!(code_of(&removed.body), "not_found");
        assert!(!removed.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "not_found");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, missing_target);
        assert_eq!(row.status, 404);
        assert!(!audit_text(row).contains(PASSWORD));

        let reset = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{missing}/reset-password"),
                Some(&json!({ "password": PASSWORD }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(reset.status, StatusCode::NOT_FOUND, "{}", reset.body);
        assert_eq!(code_of(&reset.body), "not_found");
        assert!(!reset.body.contains(PASSWORD));
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 3, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "not_found");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users/reset-password");
        assert_eq!(row.target, missing_target);
        assert_eq!(row.status, 404);
        assert!(!audit_text(row).contains(PASSWORD));
        assert!(!audit_text(&rows[1]).contains(PASSWORD));
        assert!(!audit_text(&rows[2]).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));

        let after = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(after.status, StatusCode::OK, "{}", after.body);
        let users = user_items(&after.body);
        assert_eq!(users.len(), 1, "{users:?}");
        assert_eq!(users[0]["username"], "Ada");
    }

    #[tokio::test]
    async fn self_lock_rejections_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let id_of = |name: &str| {
            users
                .iter()
                .find(|user| user["username"] == name)
                .expect("user")["id"]
                .as_i64()
                .expect("id")
        };
        let admin_id = id_of("Ada");
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let disable = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{admin_id}"),
                Some(&json!({ "disabled": true }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(disable.status, StatusCode::BAD_REQUEST, "{}", disable.body);
        assert_eq!(code_of(&disable.body), "cannot_lock_self");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "cannot_lock_self");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Ada");
        assert_eq!(row.status, 400);

        let demote = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{admin_id}"),
                Some(&json!({ "role": "viewer" }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(demote.status, StatusCode::BAD_REQUEST, "{}", demote.body);
        assert_eq!(code_of(&demote.body), "cannot_lock_self");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 2, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "cannot_lock_self");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Ada");
        assert_eq!(row.status, 400);

        let removed = exchange(
            &app,
            request(
                "DELETE",
                &format!("/api/users/{admin_id}"),
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::BAD_REQUEST, "{}", removed.body);
        assert_eq!(code_of(&removed.body), "cannot_lock_self");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 3, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "cannot_lock_self");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Ada");
        assert_eq!(row.status, 400);

        let after = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(after.status, StatusCode::OK, "{}", after.body);
        let users = user_items(&after.body);
        let admin_user = users
            .iter()
            .find(|user| user["username"] == "Ada")
            .expect("user");
        assert_eq!(admin_user["role"], "admin");
        assert_eq!(admin_user["disabled"], false);
    }

    #[tokio::test]
    async fn user_write_denials_are_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let listed = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let users = user_items(&listed.body);
        let admin_id = users
            .iter()
            .find(|user| user["username"] == "Ada")
            .expect("admin")["id"]
            .as_i64()
            .expect("id");
        let admin_target = admin_id.to_string();
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": PASSWORD,
                        "role": "viewer"
                    })
                    .to_string(),
                ),
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
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Cara");
        assert_eq!(row.status, 403);
        assert!(!audit_text(row).contains(PASSWORD));

        let patched = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{admin_id}"),
                Some(&json!({}).to_string()),
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
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, admin_target);
        assert_eq!(row.status, 403);
        assert!(!audit_text(row).contains(PASSWORD));

        let removed = exchange(
            &app,
            request(
                "DELETE",
                &format!("/api/users/{admin_id}"),
                None,
                Some(&viewer),
            ),
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
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, admin_target);
        assert_eq!(row.status, 403);
        assert!(!audit_text(row).contains(PASSWORD));

        let reset = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{admin_id}/reset-password"),
                Some(&json!({ "password": PASSWORD }).to_string()),
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&reset, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 4, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users/reset-password");
        assert_eq!(row.target, admin_target);
        assert_eq!(row.status, 403);
        assert!(!audit_text(row).contains(PASSWORD));
        assert!(!audit_text(&rows[1]).contains(PASSWORD));
        assert!(!audit_text(&rows[2]).contains(PASSWORD));
        assert!(!audit_text(&rows[3]).contains(PASSWORD));
        let sink = app.log_sink.lock().expect("logs").join("\n");
        assert!(!sink.contains(PASSWORD));

        let after = exchange(&app, request("GET", "/api/users", None, Some(&admin))).await;
        assert_eq!(after.status, StatusCode::OK, "{}", after.body);
        let users = user_items(&after.body);
        let names: Vec<_> = users
            .iter()
            .map(|user| user["username"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["Ada", "Bea"]);
    }

    #[tokio::test]
    async fn create_user_success_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": PASSWORD,
                        "role": "viewer"
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "user_created");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Cara");
        assert_eq!(row.status, 201);
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn patch_user_success_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": PASSWORD,
                        "role": "viewer",
                        "can_download": false,
                        "can_share": false
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let cara_id = serde_json::from_str::<Value>(&created.body).unwrap()["id"]
            .as_i64()
            .expect("id");
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let patched = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{cara_id}"),
                Some(&json!({ "can_download": true, "can_share": false }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(patched.status, StatusCode::OK, "{}", patched.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "user_updated");
        assert_eq!(row.method, "PATCH");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Cara");
        assert_eq!(row.status, 200);
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn delete_user_success_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": PASSWORD,
                        "role": "viewer",
                        "can_download": false,
                        "can_share": false
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let cara_id = serde_json::from_str::<Value>(&created.body).unwrap()["id"]
            .as_i64()
            .expect("id");
        let before = crate::db::recent_audit(&app.db).await.unwrap();

        let deleted = exchange(
            &app,
            request(
                "DELETE",
                &format!("/api/users/{cara_id}"),
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "user_deleted");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/users");
        assert_eq!(row.target, "Cara");
        assert_eq!(row.status, 204);
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn reset_password_success_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": PASSWORD,
                        "role": "viewer",
                        "can_download": false,
                        "can_share": false
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let cara_id = serde_json::from_str::<Value>(&created.body).unwrap()["id"]
            .as_i64()
            .expect("id");
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let replacement = "replacement horse";

        let reset = exchange(
            &app,
            request(
                "POST",
                &format!("/api/users/{cara_id}/reset-password"),
                Some(&json!({ "password": replacement }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(reset.status, StatusCode::NO_CONTENT, "{}", reset.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "password_reset");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/users/reset-password");
        assert_eq!(row.target, "Cara");
        assert_eq!(row.status, 204);
        assert!(!audit_text(row).contains(replacement));
        assert!(!audit_text(row).contains(PASSWORD));
    }

    #[tokio::test]
    async fn revoking_download_invalidates_an_exchanged_unused_zip_token() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Dora",
                        "password": PASSWORD,
                        "role": "viewer",
                        "can_download": true,
                        "can_share": false
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let created_body: Value = serde_json::from_str(&created.body).unwrap();
        assert_eq!(created_body["can_download"], true);
        assert_eq!(created_body["can_share"], false);
        let user_id = created_body["id"].as_i64().expect("id");
        let viewer = sign_in(&app, "Dora", PASSWORD).await;

        let token = "exchanged-unused-zip";
        crate::db::insert_zip(&app.db, token, user_id, "bkt-1", r#"["a.txt"]"#)
            .await
            .unwrap();
        let stored = crate::db::load_zip(&app.db, token)
            .await
            .unwrap()
            .expect("unused token");
        assert_eq!(stored.user_id, user_id);
        assert_eq!(stored.bucket_id, "bkt-1");
        assert_eq!(stored.used, 0);

        let revoked = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{user_id}"),
                Some(&json!({ "can_download": false, "can_share": false }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(revoked.status, StatusCode::OK, "{}", revoked.body);
        let revoked_body: Value = serde_json::from_str(&revoked.body).unwrap();
        assert_eq!(revoked_body["can_download"], false);
        assert_eq!(revoked_body["can_share"], false);
        assert!(
            crate::db::load_zip(&app.db, token)
                .await
                .unwrap()
                .is_none()
        );

        let restored = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{user_id}"),
                Some(&json!({ "can_download": true, "can_share": false }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
        let restored_body: Value = serde_json::from_str(&restored.body).unwrap();
        assert_eq!(restored_body["can_download"], true);
        assert_eq!(restored_body["can_share"], false);

        let archive = exchange(
            &app,
            request(
                "GET",
                &format!("/api/buckets/bkt-1/archive?token={token}"),
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&archive, StatusCode::NOT_FOUND, "not_found", "Not found");
    }
