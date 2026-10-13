
    async fn authed_status(app: &App, session: &Session) -> Value {
        let response = exchange(app, request("GET", "/api/auth/status", None, Some(session))).await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(!response.body.contains(TOKEN), "{}", response.body);
        serde_json::from_str(&response.body).unwrap()
    }

    #[tokio::test]
    async fn old_garage_blocks_writes_and_keeps_reads() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let anon = exchange(&app, request("GET", "/api/auth/status", None, None)).await;
        assert_eq!(anon.status, StatusCode::OK, "{}", anon.body);
        assert_eq!(mock.hits(), 0, "anonymous status probed Garage");
        let (session, _) = login(&app).await;
        assert_eq!(mock.hits(), 0, "login probed Garage");

        let first = authed_status(&app, &session).await;
        assert_eq!(first["garage_version"], "v2.2.0");
        assert_eq!(first["garage_write_blocked"], true);
        assert_eq!(mock.hits(), 1);
        let second = authed_status(&app, &session).await;
        assert_eq!(second["garage_version"], "v2.2.0");
        assert_eq!(second["garage_write_blocked"], true);
        assert_eq!(mock.hits(), 1, "second status opened another connection");

        app.clear_garage_link().await;
        let third = authed_status(&app, &session).await;
        assert_eq!(third["garage_write_blocked"], true);
        assert_eq!(mock.hits(), 2, "cleared cache did not probe again");

        for (method, path) in [
            ("POST", "/api/garage/v2/PreviewClusterLayoutChanges"),
            ("POST", "/api/garage/v2/GetWorkerInfo"),
            ("POST", "/api/garage/v2/ListWorkers"),
            ("GET", "/api/garage/v2/GetClusterHealth"),
        ] {
            let body = if method == "POST" { Some("{}") } else { None };
            let response = exchange(&app, request(method, path, body, Some(&session))).await;
            assert_eq!(
                response.status,
                StatusCode::OK,
                "{method} {path} {}",
                response.body
            );
            assert_ne!(code_of(&response.body), "garage_too_old");
        }
        assert_eq!(mock.hits(), 6);

        for path in [
            "/api/garage/v2/CreateBucket",
            "/api/garage/v2/UpdateClusterLayout",
        ] {
            let response = exchange(&app, request("POST", path, Some("{}"), Some(&session))).await;
            assert_eq!(
                response.status,
                StatusCode::CONFLICT,
                "{path} {}",
                response.body
            );
            assert_eq!(code_of(&response.body), "garage_too_old");
            assert!(!response.body.contains(TOKEN), "{path} {}", response.body);
        }
        assert_eq!(mock.hits(), 6, "a blocked write called upstream");
        let seen = mock.requests().join("\n");
        assert!(seen.contains("GET /v2/GetNodeInfo?node=self "));
        assert!(seen.contains("POST /v2/PreviewClusterLayoutChanges "));
        assert!(seen.contains("POST /v2/GetWorkerInfo "));
        assert!(seen.contains("POST /v2/ListWorkers "));
        assert!(seen.contains("GET /v2/GetClusterHealth "));
        assert!(!seen.contains("CreateBucket"));
        assert!(!seen.contains("UpdateClusterLayout"));
    }

    #[tokio::test]
    async fn old_garage_write_block_is_audited() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (session, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/garage/v2/CreateBucket",
                Some("{}"),
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::CONFLICT,
            "garage_too_old",
            "Garage v2.3.0 or newer is required",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "garage_too_old");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "v2/CreateBucket");
        assert_eq!(row.target, "CreateBucket");
        assert_eq!(row.status, 409);
        let seen = mock.requests().join("\n");
        assert!(!seen.contains("CreateBucket"), "{seen}");
        let health = exchange(
            &app,
            request("GET", "/api/garage/v2/GetClusterHealth", None, Some(&session)),
        )
        .await;
        assert_eq!(health.status, StatusCode::OK, "{}", health.body);
        let after_read = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(after_read.len(), rows.len(), "{after_read:?}");
    }

    #[tokio::test]
    async fn unconfigured_garage_write_is_audited() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let (session, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/garage/v2/CreateBucket",
                Some("{}"),
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage admin API is not configured",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "garage_unavailable");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "v2/CreateBucket");
        assert_eq!(row.target, "CreateBucket");
        assert_eq!(row.status, 502);
        let health = exchange(
            &app,
            request("GET", "/api/garage/v2/GetClusterHealth", None, Some(&session)),
        )
        .await;
        assert_eq!(health.status, StatusCode::BAD_GATEWAY, "{}", health.body);
        let after_read = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(after_read.len(), rows.len(), "{after_read:?}");
    }

    #[tokio::test]
    async fn garage_2_3_0_allows_a_write() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.3.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (session, _) = login(&app).await;
        let status = authed_status(&app, &session).await;
        assert_eq!(status["garage_version"], "v2.3.0");
        assert_eq!(status["garage_write_blocked"], false);
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/garage/v2/CreateBucket",
                Some("{}"),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(
            !response.body.contains("garage_too_old"),
            "{}",
            response.body
        );
        assert!(!response.body.contains(TOKEN), "{}", response.body);
        let seen = mock.requests().join("\n");
        assert!(seen.contains("POST /v2/CreateBucket "));
    }

    #[tokio::test]
    async fn missing_garage_version_does_not_block_writes() {
        let mock = GarageMock::start("{}").await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (session, _) = login(&app).await;
        let status = authed_status(&app, &session).await;
        assert_eq!(status["garage_version"], Value::Null);
        assert_eq!(status["garage_write_blocked"], false);
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/garage/v2/CreateBucket",
                Some("{}"),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(
            mock.requests()
                .join("\n")
                .contains("POST /v2/CreateBucket ")
        );
    }

    #[tokio::test]
    async fn changing_the_admin_url_probes_again() {
        let old = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let current = GarageMock::start(r#"{"garageVersion":"v2.3.0"}"#).await;
        let dir = crate::util::temp_dir();
        let mut app = app_for(&dir, &old.url).await;
        let (session, _) = login(&app).await;
        let first = authed_status(&app, &session).await;
        assert_eq!(first["garage_write_blocked"], true);
        let again = authed_status(&app, &session).await;
        assert_eq!(again["garage_version"], "v2.2.0");
        assert_eq!(old.hits(), 1);
        assert_eq!(current.hits(), 0);

        {
            let settings = std::sync::Arc::get_mut(&mut app.settings).expect("settings owners");
            settings.garage_admin_url = Some(current.url.clone());
        }
        let switched = authed_status(&app, &session).await;
        assert_eq!(switched["garage_version"], "v2.3.0");
        assert_eq!(switched["garage_write_blocked"], false);
        assert_eq!(old.hits(), 1, "the old admin URL was probed again");
        assert_eq!(current.hits(), 1);
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/garage/v2/CreateBucket",
                Some("{}"),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(
            current
                .requests()
                .join("\n")
                .contains("POST /v2/CreateBucket ")
        );
        assert!(!old.requests().join("\n").contains("CreateBucket"));
    }

    #[tokio::test]
    async fn cluster_health_returns_the_garage_body() {
        let body = r#"{ "status" : "healthy" , "storageNodesUp" : 2 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/health", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetClusterHealth"),
            "/v2/GetClusterHealth",
        );
    }

    #[tokio::test]
    async fn cluster_status_returns_the_garage_body() {
        let body = r#"{ "layoutVersion" : 4 , "nodes" : [ "n1" ] }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/status", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetClusterStatus"),
            "/v2/GetClusterStatus",
        );
    }

    #[tokio::test]
    async fn viewer_can_read_cluster_health() {
        let body = r#"{ "status" : "healthy" , "knownNodes" : 3 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/health", None, Some(&viewer)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetClusterHealth"),
            "/v2/GetClusterHealth",
        );
    }

    #[tokio::test]
    async fn cluster_reads_require_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        for path in ["/api/cluster/health", "/api/cluster/status"] {
            let anonymous = exchange(&app, request("GET", path, None, None)).await;
            assert_error(
                &anonymous,
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Login required",
            );
        }
        let (admin, _) = login(&app).await;
        for path in ["/api/cluster/health", "/api/cluster/status"] {
            let response = exchange(&app, request("GET", path, None, Some(&admin))).await;
            assert_error(
                &response,
                StatusCode::BAD_GATEWAY,
                "garage_unavailable",
                "Garage admin API is not configured",
            );
        }
    }

    #[tokio::test]
    async fn cluster_statistics_returns_the_garage_body() {
        let body = r#"{ "freeform" : "nodes=3 bytes=9007199254740993" , "totalObjectBytes" : 9007199254740993 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/statistics", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetClusterStatistics"),
            "/v2/GetClusterStatistics",
        );
    }

    #[tokio::test]
    async fn viewer_can_read_cluster_statistics() {
        let body = r#"{ "freeform" : "ok" , "bucketCount" : 9007199254740993 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/statistics", None, Some(&viewer)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetClusterStatistics"),
            "/v2/GetClusterStatistics",
        );
    }

    #[tokio::test]
    async fn cluster_statistics_requires_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let anonymous = exchange(&app, request("GET", "/api/cluster/statistics", None, None)).await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/cluster/statistics", None, Some(&admin)),
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
    async fn node_statistics_returns_the_garage_body() {
        let body = r#"{ "freeform" : "node bytes=9007199254740993" , "totalObjectBytes" : 9007199254740993 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/a%26b%3Dc/statistics",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetNodeStatistics"),
            "/v2/GetNodeStatistics?node=a%26b%3Dc",
        );
    }

    #[tokio::test]
    async fn viewer_can_read_node_statistics() {
        let body = r#"{ "freeform" : "ok" , "bucketCount" : 9007199254740993 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/a%26b%3Dc/statistics",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "GetNodeStatistics"),
            "/v2/GetNodeStatistics?node=a%26b%3Dc",
        );
        let bare = crate::util::temp_dir();
        let garage_less = state::test_app(&bare).await;
        let anonymous = exchange(
            &garage_less,
            request("GET", "/api/nodes/a%26b%3Dc/statistics", None, None),
        )
        .await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
    }

    fn assert_worker_post(calls: &[UpstreamCall], path: &str, body: Value) {
        assert_eq!(
            calls.len(),
            1,
            "{:?}",
            calls
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert!(calls[0].line.starts_with("POST "), "{}", calls[0].line);
        let target = calls[0].line.split_whitespace().nth(1).unwrap_or("");
        assert_eq!(target, path, "{}", calls[0].line);
        assert_eq!(
            serde_json::from_str::<Value>(&calls[0].body).unwrap(),
            body
        );
    }

    #[tokio::test]
    async fn set_worker_variable_reads_back_the_new_value() {
        let mock = Upstream::start(UpstreamReply::WorkerVariables).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let sent = r#"{"variable":"scrub_tranquility","value":"3"}"#;
        let put = exchange(
            &app,
            with_confirm(request(
                "PUT",
                "/api/nodes/n1/worker-variables",
                Some(sent),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(put.status, StatusCode::OK, "{}", put.body);
        assert_eq!(
            serde_json::from_str::<Value>(&put.body).unwrap(),
            json!({ "variable": "scrub_tranquility", "value": "3" })
        );
        assert_worker_post(
            &cluster_calls(&mock, "SetWorkerVariable"),
            "/v2/SetWorkerVariable?node=n1",
            json!({ "variable": "scrub_tranquility", "value": "3" }),
        );

        let got = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/n1/worker-variables?variable=scrub_tranquility",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(got.status, StatusCode::OK, "{}", got.body);
        assert_eq!(
            serde_json::from_str::<Value>(&got.body).unwrap(),
            json!({ "scrub_tranquility": "3" })
        );
        assert_worker_post(
            &cluster_calls(&mock, "GetWorkerVariable"),
            "/v2/GetWorkerVariable?node=n1",
            json!({ "variable": "scrub_tranquility" }),
        );

        let listed = exchange(
            &app,
            request("GET", "/api/nodes/n1/worker-variables", None, Some(&admin)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let gets = cluster_calls(&mock, "GetWorkerVariable");
        assert_eq!(
            gets.len(),
            2,
            "{:?}",
            gets.iter().map(|call| call.line.clone()).collect::<Vec<_>>()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&gets[1].body).unwrap(),
            json!({ "variable": null })
        );

        let sets_before_reject = cluster_calls(&mock, "SetWorkerVariable").len();
        for body in [
            r#"{"variable":"scrub_tranquility"}"#,
            r#"{"variable":"scrub_tranquility","value":"3","extra":true}"#,
            r#"{"variable":"scrub_tranquility","value":3}"#,
            r#"["scrub_tranquility","3"]"#,
            "null",
            "[]",
            r#""scrub_tranquility""#,
        ] {
            let rejected = exchange(
                &app,
                request(
                    "PUT",
                    "/api/nodes/n1/worker-variables",
                    Some(body),
                    Some(&admin),
                ),
            )
            .await;
            assert_eq!(
                rejected.status,
                StatusCode::BAD_REQUEST,
                "{body} -> {}",
                rejected.body
            );
            assert_error(
                &rejected,
                StatusCode::BAD_REQUEST,
                "invalid_variable",
                "variable and value are required",
            );
        }
        assert_eq!(
            cluster_calls(&mock, "SetWorkerVariable").len(),
            sets_before_reject
        );

        let viewer = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            with_confirm(request(
                "PUT",
                "/api/nodes/n1/worker-variables",
                Some(sent),
                Some(&viewer),
            )),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            cluster_calls(&mock, "SetWorkerVariable").len(),
            sets_before_reject
        );
        let viewer_get = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/n1/worker-variables?variable=scrub_tranquility",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(
            &viewer_get,
            StatusCode::FORBIDDEN,
            "forbidden",
            "Not allowed",
        );
        assert_eq!(cluster_calls(&mock, "GetWorkerVariable").len(), 2);

        let gone = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/gone/worker-variables?variable=scrub_tranquility",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_error(&gone, StatusCode::BAD_GATEWAY, "garage_error", "down");
    }

    #[tokio::test]
    async fn repair_tables_writes_an_audit_row() {
        let mock = Upstream::start(UpstreamReply::Ok(
            r#"{"success":{"n1":null},"error":{}}"#.to_string(),
        ))
        .await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let posted = exchange(
            &app,
            with_confirm(request(
                "POST",
                "/api/nodes/n1/repair",
                Some(r#"{"repairType":"tables"}"#),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(posted.status, StatusCode::OK, "{}", posted.body);
        assert_eq!(posted.body, "null");
        assert_worker_post(
            &cluster_calls(&mock, "LaunchRepairOperation"),
            "/v2/LaunchRepairOperation?node=n1",
            json!({ "repairType": "tables" }),
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "v2/LaunchRepairOperation");
        assert_eq!(row.target, "LaunchRepairOperation");
        assert_eq!(row.status, 200);

        let scrub = exchange(
            &app,
            with_confirm(request(
                "POST",
                "/api/nodes/n1/repair",
                Some(r#"{"repairType":{"scrub":"start"}}"#),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(scrub.status, StatusCode::OK, "{}", scrub.body);
        assert_eq!(scrub.body, "null");
        let launches = cluster_calls(&mock, "LaunchRepairOperation");
        assert_eq!(
            launches.len(),
            2,
            "{:?}",
            launches
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&launches[1].body).unwrap(),
            json!({ "repairType": { "scrub": "start" } })
        );

        let calls_before_reject = launches.len();
        let rows_before_reject = crate::db::recent_audit(&app.db).await.unwrap();
        for body in [
            r#"{}"#,
            r#"{"repairType":"tables","extra":true}"#,
            r#""tables""#,
            r#"["tables"]"#,
            r#"{"repairType":"nope"}"#,
            r#"{"repairType":{"scrub":"nope"}}"#,
        ] {
            let rejected = exchange(
                &app,
                request(
                    "POST",
                    "/api/nodes/n1/repair",
                    Some(body),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &rejected,
                StatusCode::BAD_REQUEST,
                "invalid_repair",
                "repairType is required",
            );
        }
        assert_eq!(
            cluster_calls(&mock, "LaunchRepairOperation").len(),
            calls_before_reject
        );
        assert_eq!(
            crate::db::recent_audit(&app.db).await.unwrap().len(),
            rows_before_reject.len()
        );

        let viewer = viewer_session(&app, &admin).await;
        let rows_before_viewer = crate::db::recent_audit(&app.db).await.unwrap();
        let denied = exchange(
            &app,
            with_confirm(request(
                "POST",
                "/api/nodes/n1/repair",
                Some(r#"{"repairType":"tables"}"#),
                Some(&viewer),
            )),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            cluster_calls(&mock, "LaunchRepairOperation").len(),
            calls_before_reject
        );
        assert_eq!(
            crate::db::recent_audit(&app.db).await.unwrap().len(),
            rows_before_viewer.len()
        );
    }

    #[tokio::test]
    async fn purge_blocks_rejects_a_viewer() {
        let mock = Upstream::start(UpstreamReply::Ok(
            r#"{"success":{"n1":{"blocksPurged":1,"objectsDeleted":0,"uploadsDeleted":0,"versionsDeleted":0,"blockRefsPurged":0}},"error":{}}"#
                .to_string(),
        ))
        .await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let posted = exchange(
            &app,
            with_confirm(request(
                "POST",
                "/api/nodes/n1/blocks/purge",
                Some(r#"["h1","h2"]"#),
                Some(&admin),
            )),
        )
        .await;
        assert_eq!(posted.status, StatusCode::OK, "{}", posted.body);
        assert_eq!(
            serde_json::from_str::<Value>(&posted.body).unwrap(),
            json!({
                "blocksPurged": 1,
                "objectsDeleted": 0,
                "uploadsDeleted": 0,
                "versionsDeleted": 0,
                "blockRefsPurged": 0
            })
        );
        assert_worker_post(
            &cluster_calls(&mock, "PurgeBlocks"),
            "/v2/PurgeBlocks?node=n1",
            json!(["h1", "h2"]),
        );

        let calls_before_reject = cluster_calls(&mock, "PurgeBlocks").len();
        for body in [r#"{}"#, "[]", "[1]", r#"[""]"#, r#"["h1",""]"#] {
            let rejected = exchange(
                &app,
                request(
                    "POST",
                    "/api/nodes/n1/blocks/purge",
                    Some(body),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(
                &rejected,
                StatusCode::BAD_REQUEST,
                "invalid_blocks",
                "block hashes are required",
            );
        }
        assert_eq!(
            cluster_calls(&mock, "PurgeBlocks").len(),
            calls_before_reject
        );

        let viewer = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            with_confirm(request(
                "POST",
                "/api/nodes/n1/blocks/purge",
                Some(r#"["h1"]"#),
                Some(&viewer),
            )),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            cluster_calls(&mock, "PurgeBlocks").len(),
            calls_before_reject
        );
    }

    #[tokio::test]
    async fn admin_connect_forwards_the_node_list_unchanged() {
        let upstream = br#"[ "joined" , "abcd@127.0.0.1:3901" ]"#;
        let capture = ConnectCapture::start(upstream).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &capture.url).await;
        let (admin, _) = login(&app).await;
        let sent = r#"["abcd@127.0.0.1:3901"]"#;
        let response = exchange(
            &app,
            request("POST", "/api/cluster/connect", Some(sent), Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body.as_bytes(), upstream);
        let connects: Vec<_> = capture
            .calls()
            .into_iter()
            .filter(|call| call.line.contains("ConnectClusterNodes"))
            .collect();
        assert_eq!(connects.len(), 1);
        let target = connects[0].line.split_whitespace().nth(1).unwrap_or("");
        assert_eq!(target, "/v2/ConnectClusterNodes", "{}", connects[0].line);
        assert!(
            connects[0].line.starts_with("POST "),
            "{}",
            connects[0].line
        );
        assert_eq!(connects[0].body, sent.as_bytes());
    }

    #[tokio::test]
    async fn viewer_connect_makes_no_connection() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"["joined"]"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/cluster/connect",
                Some(r#"["abcd@127.0.0.1:3901"]"#),
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
    async fn connect_denial_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let sent = r#"["abcd@127.0.0.1:3901"]"#;
        let response = exchange(
            &app,
            request("POST", "/api/cluster/connect", Some(sent), Some(&viewer)),
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
        assert_eq!(row.path, "/api/cluster/connect");
        assert_eq!(row.target, sent);
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn connect_requires_a_session_and_a_garage_url() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let anonymous = exchange(
            &app,
            request(
                "POST",
                "/api/cluster/connect",
                Some(r#"["abcd@127.0.0.1:3901"]"#),
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
                "POST",
                "/api/cluster/connect",
                Some(r#"["abcd@127.0.0.1:3901"]"#),
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
    async fn old_garage_blocks_cluster_connect() {
        let mock = GarageMock::start(r#"{"garageVersion":"v2.2.0"}"#).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/cluster/connect",
                Some(r#"["abcd@127.0.0.1:3901"]"#),
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
                .all(|line| !line.contains("ConnectClusterNodes"))
        );
    }

    #[tokio::test]
    async fn layout_stage_keeps_original_capacity_bytes() {
        let status = r#"{"layoutVersion":4,"nodes":[{"id":"keep-node","isUp":true,"draining":false,"role":{"zone":"dc1","capacity":1800000000000,"tags":["fast"]},"dataPartition":{"avail":7}},{"id":"edit-node","isUp":true,"draining":false,"role":{"zone":"dc2","capacity":2000000000000,"tags":["slow"]},"dataPartition":{"avail":1800000000000}}]}"#;
        let mock = Upstream::start(UpstreamReply::Ok(status.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let unchanged = exchange(
            &app,
            request(
                "POST",
                "/api/layout/stage",
                Some(r#"{"id":"keep-node","capacity":"1800000000000"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(unchanged.status, StatusCode::OK, "{}", unchanged.body);
        assert_eq!(unchanged.body, r#"{"updated":0}"#);
        assert!(
            mock.calls()
                .iter()
                .all(|call| !call.line.contains("UpdateClusterLayout")),
            "{:?}",
            mock.calls()
                .iter()
                .map(|call| call.line.clone())
                .collect::<Vec<_>>()
        );
        let changed = exchange(
            &app,
            request(
                "POST",
                "/api/layout/stage",
                Some(r#"{"id":"edit-node","capacity":"1900000000000"}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
        let updates = cluster_calls(&mock, "UpdateClusterLayout");
        assert_eq!(
            updates.len(),
            1,
            "{:?}",
            updates.iter().map(|call| call.line.clone()).collect::<Vec<_>>()
        );
        let body = &updates[0].body;
        assert!(body.contains("1900000000000"), "{body}");
        assert!(body.contains("edit-node"), "{body}");
        assert!(!body.contains("1800000000000"), "{body}");
        assert!(!body.contains("keep-node"), "{body}");
    }

    #[tokio::test]
    async fn preview_layout_returns_the_garage_body() {
        let body = r#"{ "stagedRoleChanges" : [ "n1" ] }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("POST", "/api/layout/preview", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        let previews = cluster_calls(&mock, "PreviewClusterLayoutChanges");
        assert_cluster_get(&previews, "/v2/PreviewClusterLayoutChanges");
        assert!(
            previews[0]
                .line
                .starts_with("POST /v2/PreviewClusterLayoutChanges "),
            "{}",
            previews[0].line
        );

        let failed = r#"{"message":"layout preview failed"}"#.to_string();
        let failed_mock =
            Upstream::start(UpstreamReply::Fixed("409 Conflict", failed.clone())).await;
        let failed_dir = crate::util::temp_dir();
        let failed_app = app_for(&failed_dir, &failed_mock.url).await;
        let (failed_admin, _) = login(&failed_app).await;
        let conflict = exchange(
            &failed_app,
            request(
                "POST",
                "/api/layout/preview",
                None,
                Some(&failed_admin),
            ),
        )
        .await;
        assert_eq!(conflict.status, StatusCode::CONFLICT, "{}", conflict.body);
        assert_eq!(conflict.body, failed);
        let failed_calls = cluster_calls(&failed_mock, "PreviewClusterLayoutChanges");
        assert_cluster_get(&failed_calls, "/v2/PreviewClusterLayoutChanges");
        assert!(
            failed_calls[0]
                .line
                .starts_with("POST /v2/PreviewClusterLayoutChanges "),
            "{}",
            failed_calls[0].line
        );

        let viewer = viewer_session(&app, &admin).await;
        let rows_before = crate::db::recent_audit(&app.db).await.unwrap();
        let denied = exchange(
            &app,
            request("POST", "/api/layout/preview", None, Some(&viewer)),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(
            cluster_calls(&mock, "PreviewClusterLayoutChanges").len(),
            previews.len()
        );
        assert_eq!(
            crate::db::recent_audit(&app.db).await.unwrap().len(),
            rows_before.len()
        );
    }

    #[tokio::test]
    async fn layout_history_returns_the_garage_body() {
        let body = r#"{ "versions" : [ { "version" : 4 } ] }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/layout/history", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        let history = cluster_calls(&mock, "GetClusterLayoutHistory");
        assert_cluster_get(&history, "/v2/GetClusterLayoutHistory");
        assert!(
            history[0]
                .line
                .starts_with("GET /v2/GetClusterLayoutHistory "),
            "{}",
            history[0].line
        );

        let failed = r#"{"message":"layout history failed"}"#.to_string();
        let failed_mock =
            Upstream::start(UpstreamReply::Fixed("409 Conflict", failed.clone())).await;
        let failed_dir = crate::util::temp_dir();
        let failed_app = app_for(&failed_dir, &failed_mock.url).await;
        let (failed_admin, _) = login(&failed_app).await;
        let conflict = exchange(
            &failed_app,
            request("GET", "/api/layout/history", None, Some(&failed_admin)),
        )
        .await;
        assert_eq!(conflict.status, StatusCode::CONFLICT, "{}", conflict.body);
        assert_eq!(conflict.body, failed);
        let failed_calls = cluster_calls(&failed_mock, "GetClusterLayoutHistory");
        assert_cluster_get(&failed_calls, "/v2/GetClusterLayoutHistory");
        assert!(
            failed_calls[0]
                .line
                .starts_with("GET /v2/GetClusterLayoutHistory "),
            "{}",
            failed_calls[0].line
        );

        let anonymous = exchange(
            &app,
            request("GET", "/api/layout/history", None, None),
        )
        .await;
        assert_error(
            &anonymous,
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login required",
        );
        assert_eq!(
            cluster_calls(&mock, "GetClusterLayoutHistory").len(),
            history.len()
        );
    }
