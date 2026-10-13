    #[tokio::test]
    async fn node_workers_returns_that_nodes_workers() {
        let listed = json!([{
            "id": 7,
            "name": "block_resync",
            "state": "busy",
            "errors": 9007199254740993u64,
            "consecutiveErrors": 1,
            "freeform": ["queue=2"],
            "progress": "1/4",
            "lastError": { "message": "rpc timeout", "secsAgo": 4 }
        }]);
        let mock = Upstream::start(UpstreamReply::Ok(
            json!({
                "success": {
                    "n1": listed.clone(),
                    "n2": [{
                        "id": 9,
                        "name": "block_rc",
                        "state": "done",
                        "errors": 0,
                        "consecutiveErrors": 0,
                        "freeform": []
                    }]
                },
                "error": {}
            })
            .to_string(),
        ))
        .await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/nodes/n1/workers", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            listed
        );
        let calls = cluster_calls(&mock, "ListWorkers");
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
        assert_eq!(target, "/v2/ListWorkers?node=n1", "{}", calls[0].line);
        assert_eq!(
            serde_json::from_str::<Value>(&calls[0].body).unwrap(),
            json!({})
        );
    }

    #[tokio::test]
    async fn node_workers_busy_filter_posts_busy_only() {
        let listed = json!([{
            "id": 7,
            "name": "block_resync",
            "state": "busy",
            "errors": 0,
            "consecutiveErrors": 0,
            "freeform": []
        }]);
        let mock = Upstream::start(UpstreamReply::Ok(
            json!({
                "success": { "n1": listed },
                "error": {}
            })
            .to_string(),
        ))
        .await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/nodes/n1/workers?busy=1", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let calls = cluster_calls(&mock, "ListWorkers");
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
        assert_eq!(target, "/v2/ListWorkers?node=n1", "{}", calls[0].line);
        assert_eq!(
            serde_json::from_str::<Value>(&calls[0].body).unwrap(),
            json!({ "busyOnly": true })
        );

        let errors = exchange(
            &app,
            request("GET", "/api/nodes/n1/workers?errors=1", None, Some(&admin)),
        )
        .await;
        assert_eq!(errors.status, StatusCode::OK, "{}", errors.body);
        let calls = cluster_calls(&mock, "ListWorkers");
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[1].line.split_whitespace().nth(1).unwrap_or(""),
            "/v2/ListWorkers?node=n1"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&calls[1].body).unwrap(),
            json!({ "errorOnly": true })
        );

        let both = exchange(
            &app,
            request(
                "GET",
                "/api/nodes/n1/workers?busy=1&errors=1",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(both.status, StatusCode::OK, "{}", both.body);
        let calls = cluster_calls(&mock, "ListWorkers");
        assert_eq!(calls.len(), 3);
        assert_eq!(
            serde_json::from_str::<Value>(&calls[2].body).unwrap(),
            json!({ "busyOnly": true, "errorOnly": true })
        );

        let before = cluster_calls(&mock, "ListWorkers").len();
        for uri in [
            "/api/nodes/n1/workers?busy=0",
            "/api/nodes/n1/workers?errors=true",
            "/api/nodes/n1/workers?busy=1&errors=0",
        ] {
            let rejected = exchange(&app, request("GET", uri, None, Some(&admin))).await;
            assert_error(
                &rejected,
                StatusCode::BAD_REQUEST,
                "invalid_filter",
                "busy and errors must be 1",
            );
        }
        assert_eq!(cluster_calls(&mock, "ListWorkers").len(), before);
    }

    #[tokio::test]
    async fn node_worker_returns_that_worker() {
        let worker = json!({
            "id": 7,
            "name": "block_resync",
            "state": "busy",
            "errors": 9007199254740993u64,
            "consecutiveErrors": 1,
            "freeform": ["queue=2"],
            "progress": "1/4",
            "lastError": { "message": "rpc timeout", "secsAgo": 4 }
        });
        let mock = Upstream::start(UpstreamReply::Ok(
            json!({
                "success": {
                    "n1": worker.clone(),
                    "n2": {
                        "id": 9,
                        "name": "block_rc",
                        "state": "done",
                        "errors": 0,
                        "consecutiveErrors": 0,
                        "freeform": []
                    }
                },
                "error": {}
            })
            .to_string(),
        ))
        .await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/nodes/n1/workers/7", None, Some(&admin)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            worker
        );
        let calls = cluster_calls(&mock, "GetWorkerInfo");
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
        assert_eq!(target, "/v2/GetWorkerInfo?node=n1", "{}", calls[0].line);
        assert_eq!(
            serde_json::from_str::<Value>(&calls[0].body).unwrap(),
            json!({ "id": 7 })
        );
    }

    #[tokio::test]
    async fn every_node_lists_workers_for_star() {
        let n1 = json!([{
            "id": 7,
            "name": "block_resync",
            "state": "busy",
            "errors": 1,
            "consecutiveErrors": 0,
            "freeform": []
        }]);
        let n2 = json!([{
            "id": 8,
            "name": "block_rc",
            "state": "done",
            "errors": 0,
            "consecutiveErrors": 0,
            "freeform": []
        }]);
        let success = json!({ "n1": n1, "n2": n2 });
        let mock = Upstream::start(UpstreamReply::Ok(
            json!({
                "success": success,
                "error": {}
            })
            .to_string(),
        ))
        .await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let listed = exchange(
            &app,
            request("GET", "/api/nodes/%2A/workers", None, Some(&admin)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            success
        );
        let calls = cluster_calls(&mock, "ListWorkers");
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
        assert_eq!(target, "/v2/ListWorkers?node=%2A", "{}", calls[0].line);
        assert_eq!(
            serde_json::from_str::<Value>(&calls[0].body).unwrap(),
            json!({})
        );

        let one = exchange(
            &app,
            request("GET", "/api/nodes/n1/workers", None, Some(&admin)),
        )
        .await;
        assert_eq!(one.status, StatusCode::OK, "{}", one.body);
        assert_eq!(serde_json::from_str::<Value>(&one.body).unwrap(), n1);
        let calls = cluster_calls(&mock, "ListWorkers");
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[1].line.split_whitespace().nth(1).unwrap_or(""),
            "/v2/ListWorkers?node=n1"
        );
    }
