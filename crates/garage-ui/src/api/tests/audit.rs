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
    let stored_at: i64 =
        sqlx::query_scalar("SELECT at FROM audit WHERE username = 'Ada' AND reason = 'login'")
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
    assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
}

#[tokio::test]
async fn audit_export_returns_the_login_row() {
    let dir = crate::util::temp_dir();
    let app = app_for(&dir, "http://127.0.0.1:9").await;
    let (session, _) = login(&app).await;
    let _ = sign_in(&app, "Ada", PASSWORD).await;

    let exported = exchange(
        &app,
        request("GET", "/api/audit/export?user=Ada", None, Some(&session)),
    )
    .await;
    assert_eq!(exported.status, StatusCode::OK, "{}", exported.body);
    assert_eq!(header_text(&exported, "content-type"), Some("text/csv"));
    let mut lines = exported.body.lines();
    assert_eq!(
        lines.next(),
        Some("at,username,ip,result,reason,method,path,target,status")
    );
    let login_line = lines.find(|line| {
        let fields: Vec<&str> = line.split(',').collect();
        fields.len() == 9
            && fields[1] == "Ada"
            && fields[4] == "login"
            && fields[5] == "POST"
            && fields[6] == "/api/auth/login"
            && fields[7].is_empty()
            && fields[8] == "200"
    });
    assert!(login_line.is_some(), "{}", exported.body);

    let nobody = exchange(
        &app,
        request("GET", "/api/audit/export?user=nobody", None, Some(&session)),
    )
    .await;
    assert_eq!(nobody.status, StatusCode::OK, "{}", nobody.body);
    assert_eq!(
        nobody.body,
        "at,username,ip,result,reason,method,path,target,status\n"
    );

    let viewer = viewer_session(&app, &session).await;
    let denied = exchange(
        &app,
        request("GET", "/api/audit/export", None, Some(&viewer)),
    )
    .await;
    assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
}

#[tokio::test]
async fn audit_export_neutralizes_formula_cells_without_changing_evidence() {
    use sqlx::Row;

    let dir = crate::util::temp_dir();
    let app = app_for(&dir, "http://127.0.0.1:9").await;
    let (session, _) = login(&app).await;
    let cases = [
        ("=1+1", "'=1+1"),
        ("+1", "'+1"),
        ("-1", "'-1"),
        ("@SUM(A1)", "'@SUM(A1)"),
        ("  =1", "'  =1"),
        ("\t+1", "'\t+1"),
        ("\r-1", "\"'\r-1\""),
        ("\n@SUM(A1)", "\"'\n@SUM(A1)\""),
        ("\u{0}=1", "'\u{0}=1"),
        ("\tordinary", "'\tordinary"),
        ("＝1", "'＝1"),
        ("＋1", "'＋1"),
        ("－1", "'－1"),
        ("＠SUM(A1)", "'＠SUM(A1)"),
        (
            "=HYPERLINK(\"https://example.invalid\",\"open\")",
            "\"'=HYPERLINK(\"\"https://example.invalid\"\",\"\"open\"\")\"",
        ),
        ("normal,\"text\"", "\"normal,\"\"text\"\"\""),
        ("value=1", "value=1"),
    ];
    let mut expected = String::from("at,username,ip,result,reason,method,path,target,status\n");
    for (index, (raw, escaped)) in cases.iter().enumerate() {
        let at = 10 + index as i64;
        sqlx::query(
            "INSERT INTO audit (at, username, ip, result, reason, method, path, target, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 200)",
        )
        .bind(at)
        .bind(raw)
        .bind(raw)
        .bind(raw)
        .bind(raw)
        .bind(raw)
        .bind(raw)
        .bind(raw)
        .execute(&app.db)
        .await
        .unwrap();
        expected.push_str(&format!("{at},{},200\n", [*escaped; 7].join(",")));
    }
    let exported = exchange(
        &app,
        request(
            "GET",
            "/api/audit/export?from=10&to=30",
            None,
            Some(&session),
        ),
    )
    .await;
    assert_eq!(exported.status, StatusCode::OK, "{}", exported.body);
    assert_eq!(exported.body, expected);
    let rows = sqlx::query("SELECT username, ip, result, reason, method, path, target FROM audit WHERE at BETWEEN 10 AND 30 ORDER BY id")
            .fetch_all(&app.db)
            .await
            .unwrap();
    assert_eq!(rows.len(), cases.len());
    for (row, (raw, _)) in rows.iter().zip(cases) {
        for column in [
            "username", "ip", "result", "reason", "method", "path", "target",
        ] {
            assert_eq!(
                row.get::<String, _>(column),
                raw,
                "raw {column} evidence changed"
            );
        }
    }
}

#[tokio::test]
async fn audit_list_paginates_after_filtering_and_reports_remaining_rows() {
    let dir = crate::util::temp_dir();
    let app = app_for(&dir, "http://127.0.0.1:9").await;
    let (session, _) = login(&app).await;
    for (at, username, target) in [
        (9, "filter-user", "bucket"),
        (10, "other-user", "bucket"),
        (11, "filter-user", "bucket"),
        (12, "filter-user", "other-bucket"),
        (13, "filter-user", "bucket"),
        (14, "filter-user", "bucket"),
        (15, "filter-user", "bucket"),
    ] {
        sqlx::query("INSERT INTO audit (at, username, ip, result, reason, target) VALUES (?, ?, '', 'success', 'test', ?)")
                .bind(at)
                .bind(username)
                .bind(target)
                .execute(&app.db)
                .await
                .unwrap();
    }
    for (offset, limit, timestamps, more) in [
        ("0", 2, vec![11, 13], true),
        ("1", 2, vec![13, 14], false),
        ("3", 2, vec![], false),
        ("0", 0, vec![], true),
        ("3", 0, vec![], false),
        ("18446744073709551615", 2, vec![], false),
    ] {
        let uri = format!(
            "/api/audit?user=filter-user&action=bucket&from=10&to=14&offset={offset}&limit={limit}"
        );
        let listed = exchange(&app, request("GET", &uri, None, Some(&session))).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let page: Value = serde_json::from_str(&listed.body).unwrap();
        let actual: Vec<i64> = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["at"].as_i64().unwrap())
            .collect();
        assert_eq!(actual, timestamps, "{uri}");
        assert_eq!(page["hasMore"], more, "{uri}");
    }
}

#[tokio::test]
async fn audit_export_yields_bounded_chunks_across_the_entire_filtered_history() {
    let dir = crate::util::temp_dir();
    let app = app_for(&dir, "http://127.0.0.1:9").await;
    let (session, _) = login(&app).await;
    sqlx::query(
            "WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 2001)
             INSERT INTO audit (at, username, ip, result, reason, target)
             SELECT n, 'chunk-user', '', 'success', 'test', 'bucket' FROM sequence",
        )
        .execute(&app.db)
        .await
        .unwrap();
    let response = router(app.clone())
        .oneshot(request(
            "GET",
            "/api/audit/export?user=chunk-user&action=bucket&from=2&to=2000",
            None,
            Some(&session),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let mut data = Vec::new();
    let mut chunks = 0;
    while let Some(frame) =
        std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_frame(cx)).await
    {
        let bytes = frame.unwrap().into_data().unwrap();
        assert!(
            bytes.len() <= 64 * 1024,
            "oversized CSV body frame: {} bytes",
            bytes.len()
        );
        data.extend_from_slice(&bytes);
        chunks += 1;
    }
    assert!(chunks > 1, "history must span multiple body frames");
    let text = String::from_utf8(data).unwrap();
    let lines: Vec<_> = text.lines().collect();
    assert_eq!(lines.len(), 2000);
    assert_eq!(
        lines[0],
        "at,username,ip,result,reason,method,path,target,status"
    );
    for (index, line) in lines[1..].iter().enumerate() {
        assert_eq!(
            *line,
            format!("{},chunk-user,,success,test,,,bucket,0", index + 2)
        );
    }
}
