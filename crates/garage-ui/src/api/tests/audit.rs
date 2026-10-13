    #[tokio::test]
    async fn audit_list_returns_the_login_row() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (session, _) = login(&app).await;
        let _ = sign_in(&app, "Ada", PASSWORD).await;

        let listed = exchange(
            &app,
            request("GET", "/api/audit?user=Ada", None, Some(&session)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let page: Value = serde_json::from_str(&listed.body).unwrap();
        assert_eq!(page["hasMore"], false);
        let items = page["items"].as_array().expect("items");
        let stored_at: i64 = sqlx::query_scalar(
            "SELECT at FROM audit WHERE username = 'Ada' AND reason = 'login'",
        )
        .fetch_one(&app.db)
        .await
        .unwrap();
        let login_rows: Vec<_> = items
            .iter()
            .filter(|item| item["username"] == "Ada" && item["reason"] == "login")
            .collect();
        assert_eq!(login_rows.len(), 1, "{}", listed.body);
        let mut item = login_rows[0].clone();
        assert_eq!(item["at"], stored_at);
        item.as_object_mut().unwrap().remove("at");
        assert_eq!(
            item,
            json!({
                "username": "Ada",
                "ip": "127.0.0.1",
                "result": "success",
                "reason": "login",
                "method": "POST",
                "path": "/api/auth/login",
                "target": "",
                "status": 200
            })
        );

        let empty = exchange(
            &app,
            request("GET", "/api/audit?user=nobody", None, Some(&session)),
        )
        .await;
        assert_eq!(empty.status, StatusCode::OK, "{}", empty.body);
        assert_eq!(
            serde_json::from_str::<Value>(&empty.body).unwrap(),
            json!({ "items": [], "hasMore": false })
        );

        let viewer = viewer_session(&app, &session).await;
        let denied = exchange(&app, request("GET", "/api/audit", None, Some(&viewer))).await;
        assert_error(
            &denied,
            StatusCode::FORBIDDEN,
            "forbidden",
            "Not allowed",
        );
    }
