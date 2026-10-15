    // The Garage key a tenant is bound to through the user API (docs/security.md 3.20, "Binding").
    const OTHER_KEY: &str = "GKother";

    // GetKeyInfo knows two keys. Every other key is a 404, like a deleted key.
    fn bind_reply() -> impl Fn(&Seen) -> Vec<u8> + Send + Sync + 'static {
        let known = tenant_admin_reply(false);
        move |call| {
            let target = request_target(&call.line);
            let path = target.split('?').next().unwrap_or("");
            let key = query_value(target, "id").unwrap_or("");
            if path == "/v2/GetKeyInfo" && key != TENANT_KEY && key != OTHER_KEY {
                return json_http(
                    "404 Not Found",
                    &json!({ "code": "NoSuchAccessKey", "message": "gone" }),
                );
            }
            known(call)
        }
    }

    struct BindEnv {
        app: App,
        admin: Session,
        garage: TenantServer,
        _s3: TenantServer,
    }

    async fn bind_env() -> BindEnv {
        let garage = TenantServer::start(bind_reply()).await;
        let s3 = TenantServer::start(tenant_s3_reply(false)).await;
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
        BindEnv {
            app,
            admin,
            garage,
            _s3: s3,
        }
    }

    async fn create_account(env: &BindEnv, name: &str, extra: Value) -> Exchange {
        let mut body = json!({
            "username": name,
            "password": "tenant horse",
            "role": "viewer",
            "can_download": true,
        });
        for (field, value) in extra.as_object().unwrap() {
            body[field] = value.clone();
        }
        exchange(
            &env.app,
            request("POST", "/api/users", Some(&body.to_string()), Some(&env.admin)),
        )
        .await
    }

    async fn patch_account(env: &BindEnv, id: i64, body: Value) -> Exchange {
        exchange(
            &env.app,
            request(
                "PATCH",
                &format!("/api/users/{id}"),
                Some(&body.to_string()),
                Some(&env.admin),
            ),
        )
        .await
    }

    fn id_of(response: &Exchange) -> i64 {
        serde_json::from_str::<Value>(&response.body).unwrap()["id"]
            .as_i64()
            .unwrap()
    }

    fn key_of(response: &Exchange) -> Value {
        serde_json::from_str::<Value>(&response.body).unwrap()["access_key_id"].clone()
    }

    async fn stored_key(env: &BindEnv, id: i64) -> Option<String> {
        crate::db::find_user_by_id(&env.app.db, id)
            .await
            .unwrap()
            .unwrap()
            .access_key_id
    }

    async fn session_status(env: &BindEnv, session: &Session) -> StatusCode {
        exchange(&env.app, request("GET", "/api/buckets", None, Some(session)))
            .await
            .status
    }

    fn assert_bad_request(response: &Exchange, code: &str) {
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{}", response.body);
        assert_eq!(code_of(&response.body), code, "{}", response.body);
    }

    fn assert_no_secret(response: &Exchange) {
        assert!(!response.body.contains(TENANT_SECRET), "{}", response.body);
    }

    #[tokio::test]
    async fn a_viewer_created_with_a_key_is_listed_with_it_and_acts_as_a_tenant() {
        let env = bind_env().await;
        let created = create_account(&env, "Tess", json!({ "access_key_id": TENANT_KEY })).await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        assert_eq!(key_of(&created), json!(TENANT_KEY));
        assert_no_secret(&created);
        let id = id_of(&created);
        assert_eq!(stored_key(&env, id).await.as_deref(), Some(TENANT_KEY));

        let plain = create_account(&env, "Plain", json!({})).await;
        assert_eq!(plain.status, StatusCode::CREATED, "{}", plain.body);
        assert_eq!(key_of(&plain), Value::Null);

        let listed = exchange(&env.app, request("GET", "/api/users", None, Some(&env.admin))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_no_secret(&listed);
        let items = user_items(&listed.body);
        let keyed = |name: &str| {
            items
                .iter()
                .find(|user| user["username"] == name)
                .map(|user| user["access_key_id"].clone())
        };
        assert_eq!(keyed("Tess"), Some(json!(TENANT_KEY)));
        assert_eq!(keyed("Plain"), Some(Value::Null));
        assert_eq!(keyed("Ada"), Some(Value::Null));

        let tenant = sign_in(&env.app, "Tess", "tenant horse").await;
        let buckets = exchange(&env.app, request("GET", "/api/buckets", None, Some(&tenant))).await;
        assert_eq!(buckets.status, StatusCode::OK, "{}", buckets.body);
        assert_eq!(bucket_ids(&buckets.body), ["b1", "b2"]);
        assert_no_secret(&buckets);
    }

    #[tokio::test]
    async fn an_administrator_cannot_be_bound_to_a_key() {
        let env = bind_env().await;
        let created = create_account(
            &env,
            "Boss",
            json!({ "role": "admin", "access_key_id": TENANT_KEY }),
        )
        .await;
        assert_bad_request(&created, "tenant_admin");
        assert!(
            crate::db::find_user_by_name(&env.app.db, "Boss")
                .await
                .unwrap()
                .is_none()
        );

        let admin = create_account(&env, "Boss", json!({ "role": "admin" })).await;
        assert_eq!(admin.status, StatusCode::CREATED, "{}", admin.body);
        let bound = patch_account(&env, id_of(&admin), json!({ "access_key_id": TENANT_KEY })).await;
        assert_bad_request(&bound, "tenant_admin");
        assert_eq!(stored_key(&env, id_of(&admin)).await, None);
    }

    #[tokio::test]
    async fn promoting_a_bound_viewer_needs_the_key_removed_in_the_same_request() {
        let env = bind_env().await;
        let created = create_account(&env, "Tess", json!({ "access_key_id": TENANT_KEY })).await;
        let id = id_of(&created);

        let refused = patch_account(&env, id, json!({ "role": "admin" })).await;
        assert_bad_request(&refused, "tenant_admin");
        let stored = crate::db::find_user_by_id(&env.app.db, id).await.unwrap().unwrap();
        assert_eq!(stored.role, "viewer");
        assert_eq!(stored.access_key_id.as_deref(), Some(TENANT_KEY));

        let both = patch_account(&env, id, json!({ "role": "admin", "access_key_id": null })).await;
        assert_eq!(both.status, StatusCode::OK, "{}", both.body);
        assert_eq!(key_of(&both), Value::Null);
        let stored = crate::db::find_user_by_id(&env.app.db, id).await.unwrap().unwrap();
        assert_eq!(stored.role, "admin");
        assert_eq!(stored.access_key_id, None);
    }

    #[tokio::test]
    async fn a_key_garage_does_not_know_is_refused_and_not_stored() {
        let env = bind_env().await;
        let before = crate::db::recent_audit(&env.app.db).await.unwrap().len();
        let created = create_account(&env, "Tess", json!({ "access_key_id": "GKnope" })).await;
        assert_bad_request(&created, "key_not_found");
        assert!(
            crate::db::find_user_by_name(&env.app.db, "Tess")
                .await
                .unwrap()
                .is_none()
        );
        let rows = crate::db::recent_audit(&env.app.db).await.unwrap();
        assert_eq!(rows.len(), before + 1, "{rows:?}");
        assert_eq!(rows[0].reason, "key_not_found");
        assert_eq!(rows[0].status, 400);

        let plain = create_account(&env, "Plain", json!({})).await;
        let id = id_of(&plain);
        let patched = patch_account(&env, id, json!({ "access_key_id": "GKnope" })).await;
        assert_bad_request(&patched, "key_not_found");
        assert_eq!(stored_key(&env, id).await, None);
    }

    #[tokio::test]
    async fn malformed_key_ids_are_refused_without_asking_garage() {
        let env = bind_env().await;
        let too_long = "K".repeat(129);
        for bad in ["", " ", "has space", "tab\there", "ключ", too_long.as_str()] {
            let created = create_account(&env, "Tess", json!({ "access_key_id": bad })).await;
            assert_bad_request(&created, "invalid_access_key_id");
        }
        let plain = create_account(&env, "Plain", json!({})).await;
        let patched = patch_account(&env, id_of(&plain), json!({ "access_key_id": "" })).await;
        assert_bad_request(&patched, "invalid_access_key_id");
        let lines = env.garage.lines();
        assert!(
            lines.iter().all(|line| !line.contains("GetKeyInfo")),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn an_unreachable_garage_is_not_reported_as_a_missing_key() {
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
                        "username": "Tess",
                        "password": "tenant horse",
                        "role": "viewer",
                        "access_key_id": TENANT_KEY,
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::BAD_GATEWAY, "{}", created.body);
        assert_ne!(code_of(&created.body), "key_not_found");
        assert!(
            crate::db::find_user_by_name(&app.db, "Tess")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn share_still_requires_download_for_a_tenant() {
        let env = bind_env().await;
        let created = create_account(
            &env,
            "Tess",
            json!({ "access_key_id": TENANT_KEY, "can_download": false, "can_share": true }),
        )
        .await;
        assert_bad_request(&created, "share_requires_download");
    }

    #[tokio::test]
    async fn changing_or_removing_the_key_ends_every_session_and_is_audited() {
        let env = bind_env().await;
        let created = create_account(&env, "Tess", json!({ "access_key_id": TENANT_KEY })).await;
        let id = id_of(&created);
        let first = sign_in(&env.app, "Tess", "tenant horse").await;
        let second = sign_in(&env.app, "Tess", "tenant horse").await;
        assert_eq!(session_status(&env, &first).await, StatusCode::OK);
        assert_eq!(session_status(&env, &second).await, StatusCode::OK);

        // The same key again is not a change.
        let before = crate::db::recent_audit(&env.app.db).await.unwrap().len();
        let same = patch_account(&env, id, json!({ "access_key_id": TENANT_KEY })).await;
        assert_eq!(same.status, StatusCode::OK, "{}", same.body);
        assert_eq!(session_status(&env, &first).await, StatusCode::OK);
        assert_eq!(session_status(&env, &second).await, StatusCode::OK);
        let untouched = patch_account(&env, id, json!({ "can_share": true })).await;
        assert_eq!(untouched.status, StatusCode::OK, "{}", untouched.body);
        assert_eq!(key_of(&untouched), json!(TENANT_KEY));
        assert_eq!(session_status(&env, &first).await, StatusCode::OK);

        let rows_before = crate::db::recent_audit(&env.app.db).await.unwrap();
        assert_eq!(rows_before.len(), before + 2, "{rows_before:?}");
        let changed = patch_account(&env, id, json!({ "access_key_id": OTHER_KEY })).await;
        assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
        assert_eq!(key_of(&changed), json!(OTHER_KEY));
        assert_no_secret(&changed);
        assert_eq!(session_status(&env, &first).await, StatusCode::UNAUTHORIZED);
        assert_eq!(session_status(&env, &second).await, StatusCode::UNAUTHORIZED);
        let rows = crate::db::recent_audit(&env.app.db).await.unwrap();
        assert_eq!(rows.len(), rows_before.len() + 1, "{rows:?}");
        assert_eq!(rows[0].result, "success");
        assert_eq!(rows[0].method, "PATCH");
        assert_eq!(rows[0].target, "Tess");
        assert_eq!(rows[0].status, 200);

        let third = sign_in(&env.app, "Tess", "tenant horse").await;
        assert_eq!(session_status(&env, &third).await, StatusCode::OK);
        let removed = patch_account(&env, id, json!({ "access_key_id": null })).await;
        assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);
        assert_eq!(key_of(&removed), Value::Null);
        assert_eq!(stored_key(&env, id).await, None);
        assert_eq!(session_status(&env, &third).await, StatusCode::UNAUTHORIZED);
        let rows_after = crate::db::recent_audit(&env.app.db).await.unwrap();
        // The sign-in of the third session is audited too.
        assert_eq!(rows_after.len(), rows.len() + 2, "{rows_after:?}");
        assert_eq!(rows_after[0].reason, "user_updated");
        assert_eq!(rows_after[0].target, "Tess");

        let fourth = sign_in(&env.app, "Tess", "tenant horse").await;
        let bound = patch_account(&env, id, json!({ "access_key_id": TENANT_KEY })).await;
        assert_eq!(bound.status, StatusCode::OK, "{}", bound.body);
        assert_eq!(session_status(&env, &fourth).await, StatusCode::UNAUTHORIZED);
    }
