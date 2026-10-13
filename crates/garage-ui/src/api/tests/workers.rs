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
