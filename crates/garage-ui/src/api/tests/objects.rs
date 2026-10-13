
    #[tokio::test]
    async fn download_filename_uses_rfc5987() {
        let dir = crate::util::temp_dir();
        let app = state::test_app(&dir).await;
        let (session, _) = login(&app).await;
        for (name, filename) in [("report", "报告.txt"), ("odd", "a?b#c%20d=e")] {
            app.fixtures.lock().expect("fixtures").insert(
                name.into(),
                state::Fixture {
                    content_type: "application/octet-stream".into(),
                    filename: filename.into(),
                    body: b"bytes".to_vec(),
                },
            );
        }
        let report = download(&app, &session, "report").await;
        assert_eq!(report.status, StatusCode::OK);
        assert_eq!(report.body, "bytes");
        assert_eq!(
            report.disposition,
            "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt"
        );
        let odd = download(&app, &session, "odd").await;
        assert_eq!(odd.status, StatusCode::OK);
        assert_eq!(odd.body, "bytes");
        assert_eq!(
            odd.disposition,
            "attachment; filename*=UTF-8''a%3Fb#c%2520d%3De"
        );
    }

    #[tokio::test]
    async fn inspect_object_returns_the_garage_body() {
        let body = r#"{ "blocks" : 2 }"#;
        let mock = Upstream::start(UpstreamReply::Ok(body.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/a%26b%3Dc/inspect/photos/a%3Db",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, body);
        assert_cluster_get(
            &cluster_calls(&mock, "InspectObject"),
            "/v2/InspectObject?bucketId=a%26b%3Dc&key=photos%2Fa%3Db",
        );
    }

    #[tokio::test]
    async fn viewer_cannot_inspect_an_object() {
        let mock = Upstream::start(UpstreamReply::Ok(r#"{ "blocks" : 2 }"#.to_string())).await;
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, &mock.url).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/a%26b%3Dc/inspect/photos/a%3Db",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(mock.hits(), 0);
        let bare = crate::util::temp_dir();
        let garage_less = state::test_app(&bare).await;
        let anonymous = exchange(
            &garage_less,
            request(
                "GET",
                "/api/buckets/a%26b%3Dc/inspect/photos/a%3Db",
                None,
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
    }

    fn list_xml(
        truncated: bool,
        token: Option<&str>,
        objects: &[(&str, i64, &str)],
        prefixes: &[&str],
    ) -> String {
        let mut xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">"#,
        );
        xml.push_str(&format!(
            "<KeyCount>{}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>{}</IsTruncated>",
            objects.len() + prefixes.len(),
            if truncated { "true" } else { "false" }
        ));
        if let Some(token) = token {
            xml.push_str(&format!(
                "<NextContinuationToken>{token}</NextContinuationToken>"
            ));
        }
        for (key, size, etag) in objects {
            xml.push_str(&format!(
                "<Contents><Key>{key}</Key><LastModified>2026-10-11T00:00:00.000Z</LastModified><ETag>\"{etag}\"</ETag><Size>{size}</Size><StorageClass>STANDARD</StorageClass></Contents>"
            ));
        }
        for prefix in prefixes {
            xml.push_str(&format!(
                "<CommonPrefixes><Prefix>{prefix}</Prefix></CommonPrefixes>"
            ));
        }
        xml.push_str("</ListBucketResult>");
        http_xml(&xml)
    }

    fn head_ok() -> String {
        "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nETag: \"abc\"\r\nLast-Modified: Sun, 11 Oct 2026 00:00:00 GMT\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n"
            .to_string()
    }

    fn encode_key(key: &str) -> String {
        const PLAIN: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/";
        let mut out = String::new();
        for byte in key.as_bytes() {
            if PLAIN.contains(byte) {
                out.push(char::from(*byte));
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    }

    fn bucket_of(line: &str) -> String {
        let path = request_target(line).split('?').next().unwrap_or("");
        let trimmed = path.trim_start_matches('/');
        percent_decode(trimmed.split('/').next().unwrap_or(""))
    }

    fn put_ok(etag: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nETag: \"{etag}\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    fn put_bytes(
        uri: &str,
        body: &[u8],
        content_length: Option<&str>,
        session: &Session,
    ) -> Request<Body> {
        let mut builder = Request::builder()
            .method("PUT")
            .uri(uri)
            .header("cookie", cookie_header(session))
            .header("x-csrf-token", &session.csrf);
        if let Some(length) = content_length {
            builder = builder.header("content-length", length);
        }
        builder.body(Body::from(body.to_vec())).unwrap()
    }

    fn node_info_hits(mock: &GarageMock) -> usize {
        mock.requests()
            .iter()
            .filter(|line| line.contains("/v2/GetNodeInfo?"))
            .count()
    }

    #[tokio::test]
    async fn startup_config_configured_endpoint_beats_connection_parameters() {
        let kept =
            S3Mock::start(|_line| list_xml(false, None, &[("kept.txt", 1, "abc")], &[])).await;
        let other =
            S3Mock::start(|_line| list_xml(false, None, &[("stolen.txt", 1, "def")], &[])).await;
        let node = format!(
            r#"{{"garageVersion":"v2.4.1","connectionParameters":{{"s3Endpoint":"{}","s3Region":"from-node"}}}}"#,
            other.url
        );
        let admin = GarageMock::start(&node).await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", admin.url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("S3_ENDPOINT_URL", kept.url.as_str()),
                ("S3_REGION", "eu-kept"),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
            ],
            test_quota(),
        )
        .await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert!(response.body.contains("kept.txt"), "{}", response.body);
        assert!(!response.body.contains("stolen.txt"), "{}", response.body);
        assert!(!kept.requests().is_empty());
        assert!(other.requests().is_empty(), "{:?}", other.requests());
        assert_eq!(admin.hits(), 0);
        assert_eq!(node_info_hits(&admin), 0);
    }

    #[tokio::test]
    async fn startup_config_missing_endpoint_comes_from_node_info() {
        let s3 =
            S3Mock::start(|_line| list_xml(false, None, &[("from-node.txt", 2, "abc")], &[])).await;
        let node = format!(
            r#"{{"success":{{"node-a":{{"garageVersion":"v2.4.1","connectionParameters":{{"s3Endpoint":"{}","s3Region":"garage"}}}}}}}}"#,
            s3.url
        );
        let admin = GarageMock::start(&node).await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("GARAGE_ADMIN_URL", admin.url.as_str()),
                ("GARAGE_ADMIN_TOKEN", TOKEN),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
            ],
            test_quota(),
        )
        .await;
        let (session, _) = login(&app).await;
        let first = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(first.status, StatusCode::OK, "{}", first.body);
        assert!(first.body.contains("from-node.txt"), "{}", first.body);
        let second = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(second.status, StatusCode::OK, "{}", second.body);
        assert!(!s3.requests().is_empty());
        assert_eq!(node_info_hits(&admin), 1, "{:?}", admin.requests());
    }

    #[tokio::test]
    async fn object_list_pages_and_clamps_max_keys() {
        let mock = S3Mock::start(|line| {
            let target = request_target(line);
            if query_value(target, "continuation-token") == Some("page-2") {
                return list_xml(false, None, &[("photos/b.txt", 4, "def")], &[]);
            }
            if query_value(target, "max-keys") == Some("1000") {
                return list_xml(false, None, &[], &[]);
            }
            list_xml(
                true,
                Some("page-2"),
                &[("photos/a.txt", 12, "abc")],
                &["photos/"],
            )
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;

        let first = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(first.status, StatusCode::OK, "{}", first.body);
        assert_eq!(
            serde_json::from_str::<Value>(&first.body).unwrap(),
            json!({
                "prefix": "",
                "entries": [
                    {"kind": "prefix", "prefix": "photos/"},
                    {"kind": "object", "key": "photos/a.txt", "size": 12, "etag": "abc", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "next": "page-2"
            })
        );
        let seen = mock.requests();
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(
            query_value(request_target(&seen[0]), "max-keys"),
            Some("100")
        );
        assert!(
            request_target(&seen[0]).contains("delimiter=%2F")
                || request_target(&seen[0]).contains("delimiter=/")
        );

        let second = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects?next=page-2",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&second.body).unwrap(),
            json!({
                "prefix": "",
                "entries": [
                    {"kind": "object", "key": "photos/b.txt", "size": 4, "etag": "def", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "next": null
            })
        );
        let seen = mock.requests();
        assert_eq!(
            query_value(request_target(&seen[1]), "continuation-token"),
            Some("page-2")
        );
        assert_eq!(bucket_of(&seen[1]), "bkt-1");

        let clamped = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects?limit=5000",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(clamped.status, StatusCode::OK, "{}", clamped.body);
        let seen = mock.requests();
        assert_eq!(
            query_value(request_target(&seen[2]), "max-keys"),
            Some("1000")
        );
        assert_eq!(bucket_of(&seen[2]), "bkt-1");
    }

    #[tokio::test]
    async fn object_list_walks_5000_objects_page_by_page() {
        let pages: Vec<Vec<String>> = (0..5)
            .map(|page| {
                (0..1000)
                    .map(|index| format!("k{:04}", page * 1000 + index))
                    .collect()
            })
            .collect();
        let mock = S3Mock::start(move |line| {
            let token = query_value(request_target(line), "continuation-token");
            let index = match token {
                None => 0,
                Some("t2") => 1,
                Some("t3") => 2,
                Some("t4") => 3,
                Some("t5") => 4,
                other => panic!("unexpected continuation token {other:?}"),
            };
            let next = match index {
                0 => Some("t2"),
                1 => Some("t3"),
                2 => Some("t4"),
                3 => Some("t5"),
                _ => None,
            };
            list_page_xml(&pages[index], next)
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;

        let mut path = "/api/buckets/bkt-1/objects?limit=1000".to_string();
        let mut total = 0;
        let mut page_count = 0;
        loop {
            let response = exchange(&app, request("GET", &path, None, Some(&session))).await;
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            let body: Value = serde_json::from_str(&response.body).unwrap();
            let entries = body["entries"].as_array().expect("entries");
            let objects = entries
                .iter()
                .filter(|entry| entry["kind"] == "object")
                .count();
            assert_eq!(objects, 1000, "{}", response.body);
            total += objects;
            page_count += 1;
            assert!(page_count <= 5, "{}", response.body);
            if page_count == 1 {
                assert_eq!(entries[0]["key"], "k0000");
            }
            match body["next"].as_str() {
                None => {
                    assert_eq!(entries[999]["key"], "k4999");
                    break;
                }
                Some(token) => {
                    path = format!("/api/buckets/bkt-1/objects?limit=1000&next={token}");
                }
            }
        }
        assert_eq!(total, 5000);
        assert_eq!(page_count, 5);

        let seen = mock.requests();
        assert_eq!(seen.len(), 5, "{seen:?}");
        let tokens = [None, Some("t2"), Some("t3"), Some("t4"), Some("t5")];
        for (line, token) in seen.iter().zip(tokens) {
            let target = request_target(line);
            assert_eq!(query_value(target, "max-keys"), Some("1000"), "{target}");
            assert_eq!(query_value(target, "continuation-token"), token, "{target}");
            assert_eq!(bucket_of(line), "bkt-1");
        }
    }

    #[tokio::test]
    async fn object_list_without_a_project_key_does_not_call_s3() {
        let mock = S3Mock::start(|_| head_missing()).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, false).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PRECONDITION_FAILED,
            "no_usable_key",
            "This bucket has no usable read-write key",
        );
        assert!(mock.requests().is_empty());
    }

    fn s3_denied() -> String {
        let body = r#"<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>denied by policy</Message></Error>"#;
        format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn object_list_retries_once_when_s3_returns_403() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        let mock = S3Mock::start(move |line| {
            assert!(request_target(line).contains("list-type=2"), "{line}");
            let call = counted.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                s3_denied()
            } else {
                list_xml(false, None, &[("a.txt", 3, "abc")], &[])
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({
                "prefix": "",
                "entries": [
                    {"kind": "object", "key": "a.txt", "size": 3, "etag": "abc", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "next": null
            })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        for line in &seen {
            assert_eq!(bucket_of(line), "bkt-1");
            assert!(request_target(line).contains("list-type=2"), "{line}");
        }
    }

    #[tokio::test]
    async fn object_list_stays_403_when_s3_denies_twice() {
        let mock = S3Mock::start(|line| {
            assert!(request_target(line).contains("list-type=2"), "{line}");
            s3_denied()
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(response.status, StatusCode::FORBIDDEN, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "code": "s3_error", "message": "service error" })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        for line in &seen {
            assert_eq!(bucket_of(line), "bkt-1");
            assert!(request_target(line).contains("list-type=2"), "{line}");
        }
    }

    #[tokio::test]
    async fn object_put_returns_key_etag_and_size() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("PUT "), "{line}");
            put_ok("abc123")
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let body = b"hello";
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                body,
                Some("5"),
                &session,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::CREATED, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "abc123", "size": 5 })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("PUT "), "{}", seen[0]);
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(object_key_of(&seen[0]), "photos/a.txt");
        assert_eq!(mock.content_types(), vec![None]);
    }

    #[tokio::test]
    async fn object_put_forwards_text_plain_and_omits_an_empty_type() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("PUT "), "{line}");
            put_ok("abc123")
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let uri = "/api/buckets/bkt-1/objects/photos/a.txt";
        let mut typed = put_bytes(uri, b"hello", Some("5"), &session);
        typed
            .headers_mut()
            .insert("content-type", HeaderValue::from_static("text/plain"));
        let typed_response = exchange(&app, typed).await;
        assert_eq!(
            typed_response.status,
            StatusCode::CREATED,
            "{}",
            typed_response.body
        );
        assert_eq!(
            serde_json::from_str::<Value>(&typed_response.body).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "abc123", "size": 5 })
        );
        let mut empty = put_bytes(uri, b"hello", Some("5"), &session);
        empty
            .headers_mut()
            .insert("content-type", HeaderValue::from_static(""));
        let empty_response = exchange(&app, empty).await;
        assert_eq!(
            empty_response.status,
            StatusCode::CREATED,
            "{}",
            empty_response.body
        );
        assert_eq!(
            serde_json::from_str::<Value>(&empty_response.body).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "abc123", "size": 5 })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        for line in &seen {
            assert!(line.starts_with("PUT "), "{line}");
            assert_eq!(bucket_of(line), "bkt-1");
            assert_eq!(object_key_of(line), "photos/a.txt");
        }
        assert_eq!(
            mock.bodies(),
            vec!["hello".to_string(), "hello".to_string()]
        );
        assert_eq!(
            mock.content_types(),
            vec![Some("text/plain".to_string()), None]
        );
    }

    #[tokio::test]
    async fn object_put_rejects_bad_length_without_calling_s3() {
        let mock = S3Mock::start(|_| put_ok("abc")).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let uri = "/api/buckets/bkt-1/objects/photos/a.txt";
        let missing = exchange(&app, put_bytes(uri, b"hello", None, &session)).await;
        assert_error(
            &missing,
            StatusCode::BAD_REQUEST,
            "length_required",
            "Content-Length is required",
        );
        let invalid = exchange(&app, put_bytes(uri, b"hello", Some("nope"), &session)).await;
        assert_error(
            &invalid,
            StatusCode::BAD_REQUEST,
            "length_required",
            "Content-Length is required",
        );
        let too_big = exchange(&app, put_bytes(uri, b"hello", Some("9999999999"), &session)).await;
        assert_error(
            &too_big,
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Upload is too large",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_put_without_a_project_key_does_not_call_s3() {
        let mock = S3Mock::start(|_| put_ok("abc")).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, false).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                b"hello",
                Some("5"),
                &session,
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PRECONDITION_FAILED,
            "no_usable_key",
            "This bucket has no usable read-write key",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_put_without_an_endpoint_is_unavailable() {
        let mock = S3Mock::start(|_| put_ok("abc")).await;
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("S3_REGION", "garage"),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
            ],
            test_quota(),
        )
        .await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                b"hello",
                Some("5"),
                &session,
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_GATEWAY,
            "garage_unavailable",
            "Garage is unavailable",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_put_retries_once_when_s3_returns_403() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        let mock = S3Mock::start(move |line| {
            assert!(line.starts_with("PUT "), "{line}");
            let call = counted.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                s3_denied()
            } else {
                put_ok("abc123")
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                b"hello",
                Some("5"),
                &session,
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::CREATED, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "abc123", "size": 5 })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        for line in &seen {
            assert!(line.starts_with("PUT "), "{line}");
            assert_eq!(bucket_of(line), "bkt-1");
            assert_eq!(object_key_of(line), "photos/a.txt");
        }
    }

    #[tokio::test]
    async fn failed_upload_leaves_no_spool_file() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("PUT "), "{line}");
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string()
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/note.txt",
                b"note",
                Some("4"),
                &session,
            ),
        )
        .await;
        assert_ne!(response.status, StatusCode::CREATED);
        let seen = mock.requests();
        assert!(
            seen.iter().any(|line| line.starts_with("PUT ")),
            "mock saw no PUT"
        );
        let mut leftovers = Vec::new();
        let mut pending = vec![dir.clone()];
        while let Some(current) = pending.pop() {
            for entry in std::fs::read_dir(&current).expect("read data dir") {
                let entry = entry.expect("data dir entry");
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with(".put-") {
                    leftovers.push(name.into_owned());
                }
                if path.is_dir() {
                    pending.push(path);
                }
            }
        }
        assert!(leftovers.is_empty(), "spool files remain: {leftovers:?}");
    }

    fn initiate_xml() -> String {
        http_xml(
            r#"<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>bkt-1</Bucket><Key>photos/a.txt</Key><UploadId>up-1</UploadId></InitiateMultipartUploadResult>"#,
        )
    }

    fn complete_xml() -> String {
        http_xml(
            r#"<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>bkt-1</Bucket><Key>photos/a.txt</Key><ETag>"final-etag"</ETag></CompleteMultipartUploadResult>"#,
        )
    }

    fn multipart_reply(line: &str) -> String {
        match s3_operation(line) {
            "create" => initiate_xml(),
            "part" => {
                let number = query_value(request_target(line), "partNumber").unwrap_or("0");
                put_ok(&format!("part-{number}"))
            }
            "complete" => complete_xml(),
            "abort" => delete_ok(),
            _ => put_ok("single-etag"),
        }
    }

    async fn decided_put(
        app: &App,
        body: &[u8],
        size: u64,
        content_type: Option<&str>,
        threshold: u64,
        part_bytes: u64,
    ) -> Result<(StatusCode, objects::PutResult), ApiError> {
        let (status, stored) = super::put_object(
            app,
            "bkt-1",
            "photos/a.txt",
            size,
            content_type.map(str::to_string),
            Body::from(body.to_vec()),
            objects::PartPlan {
                threshold,
                part_bytes,
            },
        )
        .await?;
        Ok((status, stored.0))
    }

    #[tokio::test]
    async fn object_put_above_threshold_completes_multipart() {
        let mock = S3Mock::start(multipart_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (status, stored) = decided_put(&app, b"abcde", 5, Some("text/plain"), 2, 2)
            .await
            .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(
            serde_json::to_value(&stored).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "final-etag", "size": 5 })
        );
        let seen = mock.requests();
        let ops: Vec<_> = seen.iter().map(|line| s3_operation(line)).collect();
        assert_eq!(ops.first().copied(), Some("create"), "{seen:?}");
        assert_eq!(ops.last().copied(), Some("complete"), "{seen:?}");
        assert_eq!(ops.iter().filter(|op| **op == "part").count(), 3, "{ops:?}");
        assert!(ops.iter().all(|op| *op != "put"), "{ops:?}");
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(object_key_of(&seen[0]), "photos/a.txt");
        assert_eq!(mock.content_types()[0], Some("text/plain".to_string()));
        let mut part_bodies = std::collections::BTreeMap::new();
        let mut complete_body = String::new();
        for (line, body) in seen.iter().zip(mock.bodies()) {
            match s3_operation(line) {
                "part" => {
                    let number = query_value(request_target(line), "partNumber").unwrap();
                    part_bodies.insert(number.to_string(), body);
                }
                "complete" => complete_body = body,
                _ => {}
            }
        }
        assert_eq!(part_bodies.get("1").map(String::as_str), Some("ab"));
        assert_eq!(part_bodies.get("2").map(String::as_str), Some("cd"));
        assert_eq!(part_bodies.get("3").map(String::as_str), Some("e"));
        assert!(complete_body.contains("part-1"), "{complete_body}");
        assert!(complete_body.contains("part-2"), "{complete_body}");
        assert!(complete_body.contains("part-3"), "{complete_body}");
        assert!(
            complete_body.contains("<PartNumber>1</PartNumber>"),
            "{complete_body}"
        );
        assert!(
            complete_body.contains("<PartNumber>3</PartNumber>"),
            "{complete_body}"
        );
    }

    #[tokio::test]
    async fn object_put_aborts_when_a_part_fails() {
        let mock = S3Mock::start(|line| match s3_operation(line) {
            "create" => initiate_xml(),
            "part" => {
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string()
            }
            "abort" => delete_ok(),
            _ => complete_xml(),
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let Err(error) = decided_put(&app, b"abcde", 5, None, 2, 2).await else {
            panic!("part failure returned 201");
        };
        let response = error.into_response();
        assert_ne!(response.status(), StatusCode::CREATED);
        let ops: Vec<_> = mock
            .requests()
            .iter()
            .map(|line| s3_operation(line))
            .collect();
        assert!(ops.contains(&"abort"), "{ops:?}");
        assert!(!ops.contains(&"complete"), "{ops:?}");
        assert!(!ops.contains(&"put"), "{ops:?}");
    }

    #[tokio::test]
    async fn object_put_at_threshold_stays_one_put_object() {
        let mock = S3Mock::start(multipart_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (status, stored) = decided_put(&app, b"hello", 5, None, 5, 2).await.unwrap();
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(
            serde_json::to_value(&stored).unwrap(),
            json!({ "key": "photos/a.txt", "etag": "single-etag", "size": 5 })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert_eq!(s3_operation(&seen[0]), "put");
        let (status, stored) = decided_put(&app, b"hey", 3, None, 5, 2).await.unwrap();
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(stored.size, 3);
        let ops: Vec<_> = mock
            .requests()
            .iter()
            .map(|line| s3_operation(line))
            .collect();
        assert_eq!(ops, vec!["put", "put"]);
    }

    #[tokio::test]
    async fn object_put_aborts_when_the_body_is_short() {
        let mock = S3Mock::start(multipart_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let Err(error) = decided_put(&app, b"ab", 5, None, 2, 2).await else {
            panic!("short body returned 201");
        };
        assert_ne!(error.into_response().status(), StatusCode::CREATED);
        let ops: Vec<_> = mock
            .requests()
            .iter()
            .map(|line| s3_operation(line))
            .collect();
        assert_eq!(ops.first().copied(), Some("create"), "{ops:?}");
        assert!(ops.contains(&"abort"), "{ops:?}");
        assert!(!ops.contains(&"complete"), "{ops:?}");
    }

    fn part_request_count(mock: &S3Mock) -> usize {
        mock.requests()
            .iter()
            .filter(|line| s3_operation(line) == "part")
            .count()
    }

    #[tokio::test]
    async fn object_put_waits_when_the_process_buffer_is_full() {
        let mock = S3Mock::start_holding_parts(multipart_reply).await;
        let dir = crate::util::temp_dir();
        let mut app = object_app(&dir, &mock.url, true).await;
        app.upload_buffer = Arc::new(tokio::sync::Semaphore::new(4));
        let left = app.clone();
        let right = app.clone();
        let first = tokio::spawn(async move {
            super::put_object(
                &left,
                "bkt-1",
                "a.bin",
                8,
                None,
                Body::from(b"abcdefgh".to_vec()),
                objects::PartPlan {
                    threshold: 3,
                    part_bytes: 4,
                },
            )
            .await
        });
        let second = tokio::spawn(async move {
            super::put_object(
                &right,
                "bkt-1",
                "b.bin",
                8,
                None,
                Body::from(b"ijklmnop".to_vec()),
                objects::PartPlan {
                    threshold: 3,
                    part_bytes: 4,
                },
            )
            .await
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if part_request_count(&mock) >= 1 {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no part request: {:?}",
                mock.requests()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(part_request_count(&mock), 1, "{:?}", mock.requests());
        mock.release_parts();
        let (first, second) = tokio::time::timeout(Duration::from_secs(15), async {
            tokio::join!(first, second)
        })
        .await
        .expect("puts finished after release");
        let first = first.expect("a.bin task").expect("a.bin put");
        let second = second.expect("b.bin task").expect("b.bin put");
        assert_eq!(first.0, StatusCode::CREATED);
        assert_eq!(second.0, StatusCode::CREATED);
        assert!(!first.0.is_client_error());
        assert!(!second.0.is_client_error());
        assert_eq!(first.1.0.key, "a.bin");
        assert_eq!(second.1.0.key, "b.bin");
        assert_eq!(first.1.0.size, 8);
        assert_eq!(second.1.0.size, 8);
        assert_eq!(first.1.0.etag, "final-etag");
        assert_eq!(second.1.0.etag, "final-etag");
    }

    #[tokio::test]
    async fn object_delete_returns_204_for_one_key_and_a_missing_key() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("DELETE "), "{line}");
            if object_key_of(line) == "missing" {
                head_missing()
            } else {
                delete_ok()
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let removed = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/photos/a.txt",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
        assert_eq!(removed.body, "");
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("DELETE "), "{}", seen[0]);
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(object_key_of(&seen[0]), "photos/a.txt");

        let missing = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/missing",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(missing.status, StatusCode::NO_CONTENT, "{}", missing.body);
        assert_eq!(missing.body, "");
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!(bucket_of(&seen[1]), "bkt-1");
        assert_eq!(object_key_of(&seen[1]), "missing");
        assert!(seen[1].starts_with("DELETE "), "{}", seen[1]);
    }

    #[tokio::test]
    async fn alias_with_ampersand_and_equals_still_browses_uploads_and_deletes() {
        let admin_body = r#"{"id":"bkt-1","globalAliases":[],"localAliases":[{"accessKeyId":"GK-list","alias":"a&b=c"}]}"#;
        let admin = Upstream::start(UpstreamReply::Ok(admin_body.to_string())).await;
        let s3 = S3Mock::start(|line| {
            if line.starts_with("PUT ") {
                return put_ok("etag-1");
            }
            if line.starts_with("DELETE ") {
                return delete_ok();
            }
            list_xml(false, None, &[("note.txt", 5, "abc")], &[])
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

        let detail = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1", None, Some(&session)),
        )
        .await;
        assert_eq!(detail.status, StatusCode::OK, "{}", detail.body);
        assert_eq!(detail.body, admin_body);
        let details = bucket_info_calls(&admin);
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
                .contains("GET /v2/GetBucketInfo?id=bkt-1 "),
            "{}",
            details[0].line
        );

        let listed = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&session)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "prefix": "",
                "entries": [
                    {"kind": "object", "key": "note.txt", "size": 5, "etag": "abc", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "next": null
            })
        );

        let uploaded = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/note.txt",
                b"hello",
                Some("5"),
                &session,
            ),
        )
        .await;
        assert_eq!(uploaded.status, StatusCode::CREATED, "{}", uploaded.body);
        assert_eq!(
            serde_json::from_str::<Value>(&uploaded.body).unwrap(),
            json!({ "key": "note.txt", "etag": "etag-1", "size": 5 })
        );

        let removed = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/note.txt",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
        assert_eq!(removed.body, "");

        let seen = s3.requests();
        assert_eq!(seen.len(), 3, "{seen:?}");
        assert!(seen[0].starts_with("GET "), "{}", seen[0]);
        assert!(seen[1].starts_with("PUT "), "{}", seen[1]);
        assert!(seen[2].starts_with("DELETE "), "{}", seen[2]);
        for line in &seen {
            assert_eq!(bucket_of(line), "bkt-1", "{line}");
            assert!(!line.contains("a&b=c"), "{line}");
            assert!(!line.contains("a%26b%3Dc"), "{line}");
        }
        assert_eq!(object_key_of(&seen[1]), "note.txt");
        assert_eq!(object_key_of(&seen[2]), "note.txt");
    }

    fn recursive_pages(prefix: &str) -> Vec<Vec<String>> {
        let keys: Vec<String> = (0..2500)
            .map(|index| format!("{prefix}/k{index:04}"))
            .collect();
        vec![
            keys[..1000].to_vec(),
            keys[1000..2000].to_vec(),
            keys[2000..].to_vec(),
        ]
    }

    fn list_page_xml(page: &[String], next: Option<&str>) -> String {
        let objects: Vec<(&str, i64, &str)> =
            page.iter().map(|key| (key.as_str(), 1, "abc")).collect();
        list_xml(next.is_some(), next, &objects, &[])
    }

    fn delete_page_xml(page: &[String], fail: Option<(&str, &str)>) -> String {
        let deleted: Vec<&str> = page
            .iter()
            .map(String::as_str)
            .filter(|key| fail.is_none_or(|(bad, _)| *key != bad))
            .collect();
        let failed: Vec<(&str, &str)> = fail.into_iter().collect();
        delete_result(&deleted, &failed)
    }

    struct RecursiveRun {
        response: Exchange,
        requests: Vec<String>,
        bodies: Vec<String>,
        pages: Vec<Vec<String>>,
    }

    async fn run_recursive_delete(
        failures: [Option<(&'static str, &'static str)>; 3],
    ) -> RecursiveRun {
        let prefix = "docs/2024";
        let pages = recursive_pages(prefix);
        let pages_for_mock = pages.clone();
        let posts = Arc::new(AtomicUsize::new(0));
        let mock = S3Mock::start(move |line| {
            if line.starts_with("POST ") {
                let index = posts.fetch_add(1, Ordering::SeqCst);
                assert!(index < pages_for_mock.len(), "{line}");
                return delete_page_xml(&pages_for_mock[index], failures[index]);
            }
            assert!(line.starts_with("GET "), "{line}");
            let token = query_value(request_target(line), "continuation-token");
            let index = match token {
                None => 0,
                Some("page-2") => 1,
                Some("page-3") => 2,
                other => panic!("unexpected continuation token {other:?}"),
            };
            let next = match index {
                0 => Some("page-2"),
                1 => Some("page-3"),
                _ => None,
            };
            list_page_xml(&pages_for_mock[index], next)
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/docs/2024?recursive=true",
                None,
                Some(&session),
            ),
        )
        .await;
        let requests = mock.requests();
        let bodies = mock.bodies();
        RecursiveRun {
            response,
            requests,
            bodies,
            pages,
        }
    }

    fn assert_recursive_traffic(run: &RecursiveRun, prefix: &str) {
        assert_eq!(run.requests.len(), 6, "{:?}", run.requests);
        let mut lists = Vec::new();
        let mut deletes = Vec::new();
        for (line, body) in run.requests.iter().zip(run.bodies.iter()) {
            if line.starts_with("GET ") {
                lists.push((line, body));
            } else if line.starts_with("POST ") {
                deletes.push((line, body));
            } else {
                panic!("unexpected s3 request {line}");
            }
        }
        assert_eq!(lists.len(), 3, "{:?}", run.requests);
        assert_eq!(deletes.len(), 3, "{:?}", run.requests);
        let tokens = [None, Some("page-2"), Some("page-3")];
        for ((line, _), token) in lists.iter().zip(tokens) {
            let target = request_target(line);
            assert!(target.contains("list-type=2"), "{target}");
            let raw = query_value(target, "prefix").unwrap_or("");
            assert_eq!(percent_decode(raw), prefix, "{target}");
            assert_eq!(query_value(target, "max-keys"), Some("1000"), "{target}");
            assert_eq!(query_value(target, "delimiter"), None, "{target}");
            assert_eq!(query_value(target, "continuation-token"), token, "{target}");
            assert_eq!(bucket_of(line), "bkt-1");
        }
        for ((line, body), page) in deletes.iter().zip(run.pages.iter()) {
            assert!(request_target(line).contains("delete"), "{line}");
            assert_eq!(bucket_of(line), "bkt-1");
            assert!(body.contains(&format!("<Key>{}</Key>", page[0])), "{body}");
            assert!(
                body.contains(&format!("<Key>{}</Key>", page[page.len() - 1])),
                "{body}"
            );
            assert!(!body.contains("<Quiet>true</Quiet>"), "{body}");
        }
    }

    #[tokio::test]
    async fn object_delete_recursive_lists_three_pages_and_deletes_2500() {
        let run = run_recursive_delete([None, None, None]).await;
        assert_eq!(run.response.status, StatusCode::OK, "{}", run.response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&run.response.body).unwrap(),
            json!({ "deleted": 2500, "errors": [] })
        );
        assert_recursive_traffic(&run, "docs/2024");
    }

    #[tokio::test]
    async fn object_delete_recursive_keeps_three_key_errors() {
        let failures = [
            Some(("docs/2024/k0000", "injected-0")),
            Some(("docs/2024/k1000", "injected-1")),
            Some(("docs/2024/k2499", "injected-2")),
        ];
        let run = run_recursive_delete(failures).await;
        assert_eq!(run.response.status, StatusCode::OK, "{}", run.response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&run.response.body).unwrap(),
            json!({
                "deleted": 2497,
                "errors": [
                    {"key": "docs/2024/k0000", "message": "injected-0"},
                    {"key": "docs/2024/k1000", "message": "injected-1"},
                    {"key": "docs/2024/k2499", "message": "injected-2"}
                ]
            })
        );
        assert_recursive_traffic(&run, "docs/2024");
    }

    #[tokio::test]
    async fn object_delete_recursive_without_a_project_key_does_not_call_s3() {
        let mock = S3Mock::start(|_| delete_ok()).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, false).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/docs/2024?recursive=true",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PRECONDITION_FAILED,
            "no_usable_key",
            "This bucket has no usable read-write key",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_delete_without_a_project_key_does_not_call_s3() {
        let mock = S3Mock::start(|_| delete_ok()).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, false).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/photos/a.txt",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PRECONDITION_FAILED,
            "no_usable_key",
            "This bucket has no usable read-write key",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_delete_recursive_empty_prefix_returns_zero() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("GET "), "{line}");
            assert_eq!(
                percent_decode(query_value(request_target(line), "prefix").unwrap_or("")),
                "docs/2024"
            );
            list_xml(false, None, &[], &[])
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/docs/2024?recursive=true",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "deleted": 0, "errors": [] })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(
            mock.bodies().iter().all(|body| body.is_empty()),
            "{:?}",
            mock.bodies()
        );
    }

    #[tokio::test]
    async fn object_delete_recursive_false_stays_one_object() {
        let mock = S3Mock::start(|line| {
            assert!(line.starts_with("DELETE "), "{line}");
            delete_ok()
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/photos/a.txt?recursive=false",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::NO_CONTENT, "{}", response.body);
        assert_eq!(response.body, "");
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("DELETE "), "{}", seen[0]);
        assert_eq!(object_key_of(&seen[0]), "photos/a.txt");
    }

    fn delete_result(deleted: &[&str], failed: &[(&str, &str)]) -> String {
        let mut xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">"#,
        );
        for key in deleted {
            xml.push_str(&format!("<Deleted><Key>{key}</Key></Deleted>"));
        }
        for (key, message) in failed {
            xml.push_str(&format!(
                "<Error><Key>{key}</Key><Code>AccessDenied</Code><Message>{message}</Message></Error>"
            ));
        }
        xml.push_str("</DeleteResult>");
        http_xml(&xml)
    }

    #[tokio::test]
    async fn object_writes_leave_an_audit_row() {
        let mock = S3Mock::start(|line| {
            if line.starts_with("PUT ") {
                return put_ok("abc123");
            }
            if line.starts_with("DELETE ") {
                return delete_ok();
            }
            if line.starts_with("POST ") {
                return delete_result(&["left-photo", "right-photo", "docs/2024/notes.txt"], &[]);
            }
            if line.starts_with("GET ") {
                return list_xml(false, None, &[("docs/2024/notes.txt", 4, "abc")], &[]);
            }
            head_ok()
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before_viewer = crate::db::recent_audit(&app.db).await.unwrap();

        let denied = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/photos/a.txt",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_eq!(denied.status, StatusCode::FORBIDDEN, "{}", denied.body);
        assert!(mock.requests().is_empty());
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_viewer.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Bea");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "denied");
        assert_eq!(row.reason, "forbidden");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects/photos/a.txt");
        assert_eq!(row.target, "bkt-1/photos/a.txt");
        assert_eq!(row.status, 403);

        let body = b"hello";
        let before_put = rows.len();
        let put = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                body,
                Some("5"),
                &admin,
            ),
        )
        .await;
        assert_eq!(put.status, StatusCode::CREATED, "{}", put.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_put + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "PUT");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects/photos/a.txt");
        assert_eq!(row.target, "bkt-1/photos/a.txt");
        assert_eq!(row.status, 201);
        assert!(!audit_text(row).contains("hello"), "{}", audit_text(row));

        let before_delete = rows.len();
        let removed = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/photos/a.txt",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_delete + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects/photos/a.txt");
        assert_eq!(row.target, "bkt-1/photos/a.txt");
        assert_eq!(row.status, 204);

        let before_batch = rows.len();
        let s3_before_batch = mock.requests().len();
        let batch = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": ["left-photo", "right-photo"] }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(batch.status, StatusCode::OK, "{}", batch.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_batch + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects:delete");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 200);
        let text = audit_text(row);
        assert!(!text.contains("left-photo"), "{text}");
        assert!(!text.contains("right-photo"), "{text}");
        assert!(mock.requests().len() > s3_before_batch);

        let before_many = rows.len();
        let s3_before_many = mock.requests().len();
        let keys: Vec<_> = (0..1001).map(|index| format!("k{index}")).collect();
        let too_many = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": keys }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(
            too_many.status,
            StatusCode::BAD_REQUEST,
            "{}",
            too_many.body
        );
        assert_eq!(code_of(&too_many.body), "too_many_keys");
        assert_eq!(mock.requests().len(), s3_before_many);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_many + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "too_many_keys");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects:delete");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);
        let text = audit_text(row);
        assert!(!text.contains("k1000"), "{text}");
        assert!(!text.contains("k0"), "{text}");

        let before_recursive = rows.len();
        let recursive = exchange(
            &app,
            request(
                "DELETE",
                "/api/buckets/bkt-1/objects/docs/2024?recursive=true",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(recursive.status, StatusCode::OK, "{}", recursive.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_recursive + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.ip, "127.0.0.1");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "DELETE");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects/docs/2024");
        assert_eq!(row.target, "bkt-1/docs/2024");
        assert_eq!(row.status, 200);
        assert!(
            !audit_text(row).contains("notes.txt"),
            "{}",
            audit_text(row)
        );

        let before_get = rows.len();
        let fetched = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/photos/a.txt",
                None,
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(fetched.status, StatusCode::OK, "{}", fetched.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before_get);
    }

    #[tokio::test]
    async fn object_delete_many_rejects_1001_keys_without_an_s3_call() {
        let mock = S3Mock::start(|_| delete_result(&["a"], &[])).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let keys: Vec<_> = (0..1001).map(|index| format!("k{index}")).collect();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": keys }).to_string()),
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "too_many_keys",
            "At most 1000 keys can be deleted at once",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_delete_many_deletes_two_keys_in_one_call() {
        let mock = S3Mock::start(|_| delete_result(&["a", "b"], &[])).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": ["a", "b"] }).to_string()),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "deleted": ["a", "b"], "failed": [] })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("POST "), "{}", seen[0]);
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert!(request_target(&seen[0]).contains("delete"), "{}", seen[0]);
        let bodies = mock.bodies();
        assert_eq!(bodies.len(), 1, "{bodies:?}");
        assert!(bodies[0].contains("<Key>a</Key>"), "{}", bodies[0]);
        assert!(bodies[0].contains("<Key>b</Key>"), "{}", bodies[0]);
    }

    #[tokio::test]
    async fn object_delete_many_keeps_a_partial_error_in_failed() {
        let mock = S3Mock::start(|_| delete_result(&["a"], &[("b", "denied by policy")])).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": ["a", "b"] }).to_string()),
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({
                "deleted": ["a"],
                "failed": [{ "key": "b", "message": "denied by policy" }]
            })
        );
        assert_eq!(mock.requests().len(), 1, "{:?}", mock.requests());
    }

    fn object_bytes(content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nETag: \"abc\"\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn object_get_reply(line: &str) -> String {
        let key = object_key_of(line);
        if key == "missing" {
            return head_missing();
        }
        if line.starts_with("HEAD ") {
            return head_ok();
        }
        if key.ends_with(".html") {
            object_bytes("text/html", "<p>hi</p>")
        } else {
            object_bytes("text/plain", "hello plain")
        }
    }

    #[tokio::test]
    async fn object_get_without_a_query_stays_metadata_json() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_ne!(response.body, "hello plain");
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({
                "key": "note.txt",
                "size": 1,
                "etag": "abc",
                "lastModified": "2026-10-11T00:00:00Z",
                "contentType": "text/plain"
            })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("HEAD "), "{}", seen[0]);
    }

    #[tokio::test]
    async fn object_get_preview_of_html_is_an_attachment() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/page.html?preview=1",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, "<p>hi</p>");
        assert_eq!(
            header_text(&response, "content-type"),
            Some("application/octet-stream")
        );
        assert_eq!(
            header_text(&response, "content-disposition"),
            Some("attachment; filename*=UTF-8''page.html")
        );
        assert_eq!(
            header_text(&response, "x-content-type-options"),
            Some("nosniff")
        );
        assert_eq!(
            header_text(&response, "content-security-policy"),
            Some("sandbox; frame-ancestors 'self'")
        );
        assert_eq!(
            header_text(&response, "x-frame-options"),
            Some("SAMEORIGIN")
        );
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("GET "), "{}", seen[0]);
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(object_key_of(&seen[0]), "page.html");
    }

    #[tokio::test]
    async fn object_get_preview_of_plain_stays_inline() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, "hello plain");
        assert_eq!(header_text(&response, "content-type"), Some("text/plain"));
        assert!(response.headers.get("content-disposition").is_none());
        assert_eq!(
            header_text(&response, "x-content-type-options"),
            Some("nosniff")
        );
    }

    #[tokio::test]
    async fn object_get_download_of_plain_is_an_attachment() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/photos/note.txt?download=1",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        assert_eq!(response.body, "hello plain");
        assert_eq!(header_text(&response, "content-type"), Some("text/plain"));
        assert_eq!(
            header_text(&response, "content-disposition"),
            Some("attachment; filename*=UTF-8''note.txt")
        );
        assert_eq!(
            header_text(&response, "x-content-type-options"),
            Some("nosniff")
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("GET "), "{}", seen[0]);
        assert_eq!(object_key_of(&seen[0]), "photos/note.txt");
    }

    fn partial_object(body: &str, content_range: &str) -> String {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nContent-Range: {content_range}\r\nETag: \"abc\"\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn ranged_object_reply(line: &str) -> String {
        if line.starts_with("HEAD ") {
            return head_ok();
        }
        if line.contains("bytes=1-3") {
            return partial_object("ell", "bytes 1-3/11");
        }
        if line.contains("bytes=1-") {
            return partial_object("ello plain", "bytes 1-10/11");
        }
        object_bytes("text/plain", "hello plain")
    }

    fn ranged_get(uri: &str, range: &str, session: &Session) -> Request<Body> {
        Request::builder()
            .method("GET")
            .uri(uri)
            .header("cookie", cookie_header(session))
            .header("x-csrf-token", &session.csrf)
            .header("range", range)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn ranged_object_returns_the_requested_bytes() {
        let mock = S3Mock::start(ranged_object_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let preview = exchange(
            &app,
            ranged_get(
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                "bytes=1-3",
                &session,
            ),
        )
        .await;
        assert_eq!(
            preview.status,
            StatusCode::PARTIAL_CONTENT,
            "{}",
            preview.body
        );
        assert_eq!(preview.body, "ell");
        assert_eq!(
            header_text(&preview, "content-range"),
            Some("bytes 1-3/11")
        );
        assert_eq!(
            header_text(&preview, "x-content-type-options"),
            Some("nosniff")
        );
        assert_eq!(
            header_text(&preview, "cache-control"),
            Some("private, no-store")
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("GET "), "{}", seen[0]);
        assert!(seen[0].contains("x-id=GetObject"), "{}", seen[0]);
        assert!(seen[0].contains("bytes=1-3"), "{}", seen[0]);
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(object_key_of(&seen[0]), "note.txt");
        let download = exchange(
            &app,
            ranged_get(
                "/api/buckets/bkt-1/objects/note.txt?download=1",
                "bytes=1-",
                &session,
            ),
        )
        .await;
        assert_eq!(
            download.status,
            StatusCode::PARTIAL_CONTENT,
            "{}",
            download.body
        );
        assert_eq!(download.body, "ello plain");
        assert_eq!(
            header_text(&download, "content-range"),
            Some("bytes 1-10/11")
        );
        let seen = mock.requests();
        assert!(
            seen.iter()
                .any(|line| line.contains("bytes=1-") && !line.contains("bytes=1-3")),
            "{seen:?}"
        );
        let before = mock.requests();
        let rejected = exchange(
            &app,
            ranged_get(
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                "bytes=0-1, bytes=2-4",
                &session,
            ),
        )
        .await;
        assert_error(
            &rejected,
            StatusCode::RANGE_NOT_SATISFIABLE,
            "range_not_satisfiable",
            "range is invalid",
        );
        assert_eq!(mock.requests(), before, "{:?}", mock.requests());
        let meta = exchange(
            &app,
            ranged_get(
                "/api/buckets/bkt-1/objects/note.txt",
                "bytes=0-1",
                &session,
            ),
        )
        .await;
        assert_eq!(meta.status, StatusCode::OK, "{}", meta.body);
        assert_eq!(
            serde_json::from_str::<Value>(&meta.body).unwrap(),
            json!({
                "key": "note.txt",
                "size": 1,
                "etag": "abc",
                "lastModified": "2026-10-11T00:00:00Z",
                "contentType": "text/plain"
            })
        );
        let seen = mock.requests();
        let last = seen.last().expect("metadata request");
        assert!(last.starts_with("HEAD "), "{last}");
        assert!(
            !seen
                .iter()
                .any(|line| line.starts_with("GET ") && line.contains("bytes=0-1")),
            "{seen:?}"
        );
    }

    #[tokio::test]
    async fn download_drop_cancels_the_s3_get_within_one_second() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let closed = Arc::new(AtomicBool::new(false));
        let wake = Arc::new(tokio::sync::Notify::new());
        let closed_task = Arc::clone(&closed);
        let wake_task = Arc::clone(&wake);
        let mock = tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buf = Vec::new();
            let mut tmp = [0_u8; 4096];
            let header_end = loop {
                let Ok(read) = socket.read(&mut tmp).await else {
                    return;
                };
                if read == 0 {
                    return;
                }
                buf.extend_from_slice(&tmp[..read]);
                if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                    break pos;
                }
                if buf.len() > 64 * 1024 {
                    return;
                }
            };
            let text = String::from_utf8_lossy(&buf[..header_end]);
            let length = header_value(&text, "content-length")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let mut request_body = buf[header_end + 4..].to_vec();
            while request_body.len() < length {
                let Ok(read) = socket.read(&mut tmp).await else {
                    return;
                };
                if read == 0 {
                    return;
                }
                request_body.extend_from_slice(&tmp[..read]);
            }
            drop(request_body);
            let response = concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: text/plain\r\n",
                "Content-Length: 1048576\r\n",
                "ETag: \"abc\"\r\n",
                "\r\n",
                "partial"
            );
            if socket.write_all(response.as_bytes()).await.is_err() {
                return;
            }
            let _ = socket.flush().await;
            loop {
                match socket.read(&mut tmp).await {
                    Ok(0) | Err(_) => {
                        closed_task.store(true, Ordering::SeqCst);
                        wake_task.notify_waiters();
                        return;
                    }
                    Ok(_) => {}
                }
            }
        });
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &format!("http://127.0.0.1:{port}"), true).await;
        let (session, _) = login(&app).await;
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            router(app).oneshot(request(
                "GET",
                "/api/buckets/bkt-1/objects/photos/note.txt?download=1",
                None,
                Some(&session),
            )),
        )
        .await
        .expect("download headers")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            !closed.load(Ordering::SeqCst),
            "s3 socket closed before the download body was dropped"
        );
        let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&logs);
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_ansi(false)
            .with_writer(move || DownloadLog(Arc::clone(&sink)))
            .finish();
        tracing::subscriber::with_default(subscriber, || drop(response));
        let observed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let notified = wake.notified();
                if closed.load(Ordering::SeqCst) {
                    return;
                }
                notified.await;
            }
        })
        .await;
        mock.abort();
        assert!(
            observed.is_ok(),
            "s3 socket still open one second after the download body was dropped"
        );
        let text = String::from_utf8(logs.lock().expect("download log").clone()).unwrap();
        assert_eq!(text.matches("download cancelled").count(), 1);
        assert!(!text.contains("partial"));
    }

    #[tokio::test]
    async fn object_get_missing_key_is_404() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/missing?preview=1",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_error(&response, StatusCode::NOT_FOUND, "not_found", "Not found");
        let seen = mock.requests();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("GET "), "{}", seen[0]);
        assert_eq!(object_key_of(&seen[0]), "missing");
    }

    #[tokio::test]
    async fn object_get_without_a_project_key_does_not_call_s3() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, false).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?download=1",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PRECONDITION_FAILED,
            "no_usable_key",
            "This bucket has no usable read-write key",
        );
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_get_viewer_without_download_does_not_call_s3() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&response, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_get_rejects_an_invalid_view_without_calling_s3() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        for uri in [
            "/api/buckets/bkt-1/objects/note.txt?preview=1&download=1",
            "/api/buckets/bkt-1/objects/note.txt?preview=2",
            "/api/buckets/bkt-1/objects/note.txt?download=0",
        ] {
            let response = exchange(&app, request("GET", uri, None, Some(&session))).await;
            assert_error(
                &response,
                StatusCode::BAD_REQUEST,
                "invalid_view",
                "Choose preview or download",
            );
        }
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn object_routes_require_a_session_and_a_viewer_can_list() {
        let mock = S3Mock::start(|_| list_xml(false, None, &[("a.txt", 1, "abc")], &[])).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let anon = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, None),
        )
        .await;
        assert_eq!(anon.status, StatusCode::UNAUTHORIZED, "{}", anon.body);
        assert!(mock.requests().is_empty());

        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let listed_by_viewer = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&viewer)),
        )
        .await;
        assert_eq!(
            listed_by_viewer.status,
            StatusCode::OK,
            "{}",
            listed_by_viewer.body
        );
        assert_eq!(
            serde_json::from_str::<Value>(&listed_by_viewer.body).unwrap()["entries"][0]["key"],
            "a.txt"
        );
        assert_eq!(mock.requests().len(), 1);
        assert!(request_target(&mock.requests()[0]).contains("delimiter="));

        let created = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": "viewer horse",
                        "role": "viewer",
                        "can_download": true
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        let allowed = sign_in(&app, "Cara", "viewer horse").await;
        let listed = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/search?q=txt",
                None,
                Some(&allowed),
            ),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap()["matches"][0]["key"],
            "a.txt"
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!(bucket_of(&seen[1]), "bkt-1");
        assert!(!request_target(&seen[1]).contains("delimiter="));
    }

    fn browse_reply(line: &str) -> String {
        if request_target(line).contains("list-type=") {
            return list_xml(false, None, &[("note.txt", 11, "abc")], &[]);
        }
        object_get_reply(line)
    }

    #[tokio::test]
    async fn object_viewer_without_download_lists_metadata_and_blocks_transfer() {
        let mock = S3Mock::start(browse_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;

        let listed = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/objects", None, Some(&viewer)),
        )
        .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        assert_eq!(
            serde_json::from_str::<Value>(&listed.body).unwrap(),
            json!({
                "prefix": "",
                "entries": [
                    {"kind": "object", "key": "note.txt", "size": 11, "etag": "abc", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "next": null
            })
        );

        let found = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/search?q=txt",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_eq!(found.status, StatusCode::OK, "{}", found.body);
        assert_eq!(
            serde_json::from_str::<Value>(&found.body).unwrap(),
            json!({
                "matches": [
                    {"key": "note.txt", "size": 11, "etag": "abc", "lastModified": "2026-10-11T00:00:00Z"}
                ],
                "truncated": false,
                "reason": null
            })
        );

        let meta = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_eq!(meta.status, StatusCode::OK, "{}", meta.body);
        assert_eq!(
            serde_json::from_str::<Value>(&meta.body).unwrap(),
            json!({
                "key": "note.txt",
                "size": 1,
                "etag": "abc",
                "lastModified": "2026-10-11T00:00:00Z",
                "contentType": "text/plain"
            })
        );
        let calls_before_transfer = mock.requests().len();

        let preview = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&preview, StatusCode::FORBIDDEN, "forbidden", "Not allowed");

        let download = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?download=1",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&download, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert_eq!(mock.requests().len(), calls_before_transfer);
    }

    #[tokio::test]
    async fn object_viewer_preview_succeeds_after_download_is_granted() {
        let mock = S3Mock::start(object_get_reply).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
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
        let user_id = serde_json::from_str::<Value>(&created.body).unwrap()["id"]
            .as_i64()
            .unwrap();
        let viewer = sign_in(&app, "Bea", "viewer horse").await;
        let denied = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_error(&denied, StatusCode::FORBIDDEN, "forbidden", "Not allowed");
        assert!(mock.requests().is_empty());

        let patched = exchange(
            &app,
            request(
                "PATCH",
                &format!("/api/users/{user_id}"),
                Some(&json!({ "can_download": true }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(patched.status, StatusCode::OK, "{}", patched.body);
        assert_eq!(
            serde_json::from_str::<Value>(&patched.body).unwrap()["can_download"],
            true
        );

        let preview = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt?preview=1",
                None,
                Some(&viewer),
            ),
        )
        .await;
        assert_eq!(preview.status, StatusCode::OK, "{}", preview.body);
        assert_eq!(preview.body, "hello plain");
    }

    #[tokio::test]
    async fn object_search_rejects_a_short_query_and_stops_at_two_hundred() {
        let mock = S3Mock::start(|_| {
            let mut objects = String::new();
            for index in 0..250 {
                objects.push_str(&format!(
                    "<Contents><Key>m-{index:03}</Key><LastModified>2026-10-11T00:00:00.000Z</LastModified><ETag>\"abc\"</ETag><Size>12</Size></Contents>"
                ));
            }
            http_xml(&format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>more</NextContinuationToken><KeyCount>250</KeyCount>{objects}</ListBucketResult>"#
            ))
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let short = exchange(
            &app,
            request("GET", "/api/buckets/bkt-1/search?q=a", None, Some(&session)),
        )
        .await;
        assert_error(
            &short,
            StatusCode::BAD_REQUEST,
            "query_too_short",
            "Search needs at least 2 characters",
        );
        assert!(mock.requests().is_empty(), "a 1-character search called S3");

        let found = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/search?q=m-",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(found.status, StatusCode::OK, "{}", found.body);
        let body: Value = serde_json::from_str(&found.body).unwrap();
        assert_eq!(body["truncated"], true);
        assert_eq!(body["reason"], "result_limit");
        assert_eq!(body["matches"].as_array().unwrap().len(), 200);
        assert_eq!(body["matches"][0]["key"], "m-000");
        assert_eq!(body["matches"][199]["key"], "m-199");
        assert_eq!(body["matches"][199]["size"], 12);
        assert_eq!(body["matches"][199]["etag"], "abc");
        assert_eq!(body["matches"][199]["lastModified"], "2026-10-11T00:00:00Z");
        assert_eq!(mock.requests().len(), 1);
        assert_eq!(bucket_of(&mock.requests()[0]), "bkt-1");
    }

    #[tokio::test]
    async fn object_search_stops_after_twenty_pages() {
        let mock = S3Mock::start(|_| {
            list_xml(true, Some("more"), &[("note.txt", 1, "abc")], &[])
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let found = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/search?q=qx",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(found.status, StatusCode::OK, "{}", found.body);
        assert_eq!(
            serde_json::from_str::<Value>(&found.body).unwrap(),
            json!({
                "matches": [],
                "truncated": true,
                "reason": "page_limit"
            })
        );
        let seen = mock.requests();
        assert_eq!(seen.len(), 20, "{seen:?}");
        for (index, line) in seen.iter().enumerate() {
            let target = request_target(line);
            assert!(target.contains("list-type=2"), "{target}");
            assert_eq!(query_value(target, "max-keys"), Some("1000"), "{target}");
            assert_eq!(bucket_of(line), "bkt-1");
            let token = query_value(target, "continuation-token");
            if index == 0 {
                assert_eq!(token, None, "{target}");
            } else {
                assert_eq!(token, Some("more"), "{target}");
            }
        }
    }

    #[tokio::test]
    async fn object_search_stays_inside_the_prefix() {
        let mock = S3Mock::start(|line| {
            let raw = query_value(request_target(line), "prefix").unwrap_or("");
            if percent_decode(raw) == "photos/" {
                list_xml(false, None, &[("photos/ab.txt", 1, "abc")], &[])
            } else {
                list_xml(false, None, &[("other/ab.txt", 1, "abc")], &[])
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let found = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/search?q=ab&prefix=photos/",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(found.status, StatusCode::OK);
        let body: Value = serde_json::from_str(&found.body).unwrap();
        let matches = body["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["key"], "photos/ab.txt");
        assert_eq!(body["truncated"], false);
        assert_eq!(body["reason"], Value::Null);
        let seen = mock.requests();
        assert_eq!(seen.len(), 1);
        let target = request_target(&seen[0]);
        assert!(target.contains("list-type=2"), "{target}");
        assert_eq!(query_value(target, "max-keys"), Some("1000"), "{target}");
        assert_eq!(bucket_of(&seen[0]), "bkt-1");
        assert_eq!(
            percent_decode(query_value(target, "prefix").unwrap_or("")),
            "photos/"
        );
        assert!(query_value(target, "delimiter").is_none(), "{target}");
    }

    #[tokio::test]
    async fn object_metadata_round_trips_odd_keys_and_a_missing_object_is_404() {
        let mock = S3Mock::start(|line| {
            if request_target(line).contains("missing") {
                head_missing()
            } else {
                head_ok()
            }
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        for key in ["a?b#c%20d=e", "照片.txt"] {
            let response = exchange(
                &app,
                request(
                    "GET",
                    &format!("/api/buckets/bkt-1/objects/{}", encode_key(key)),
                    None,
                    Some(&session),
                ),
            )
            .await;
            assert_eq!(response.status, StatusCode::OK, "{key} {}", response.body);
            assert_eq!(
                serde_json::from_str::<Value>(&response.body).unwrap(),
                json!({
                    "key": key,
                    "size": 1,
                    "etag": "abc",
                    "lastModified": "2026-10-11T00:00:00Z",
                    "contentType": "text/plain"
                })
            );
        }
        let seen = mock.requests();
        assert_eq!(seen.len(), 2);
        for (line, key) in seen.iter().zip(["a?b#c%20d=e", "照片.txt"]) {
            let path = request_target(line).split('?').next().unwrap_or("");
            let decoded = percent_decode(path.trim_start_matches('/'));
            let (bucket, object_key) = decoded.split_once('/').unwrap();
            assert_eq!(bucket, "bkt-1");
            assert_eq!(object_key, key);
            assert!(line.starts_with("HEAD "), "{line}");
        }
        let missing = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/missing",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_error(&missing, StatusCode::NOT_FOUND, "not_found", "Not found");
    }

    #[tokio::test]
    async fn object_metadata_is_private_no_store() {
        let mock = S3Mock::start(|_| head_ok()).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/note.txt",
                None,
                Some(&session),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            header_text(&response, "cache-control"),
            Some("private, no-store")
        );
        let body: Value = serde_json::from_str(&response.body).expect("metadata json");
        assert_eq!(body["key"], "note.txt");
    }

    #[tokio::test]
    async fn thumbnail_response_write_once_after_head_object_fails() {
        let mock = S3Mock::start(|_| head_missing()).await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (session, _) = login(&app).await;
        let response = exchange(
            &app,
            request(
                "GET",
                "/api/buckets/bkt-1/objects/photo.png/thumbnail",
                None,
                Some(&session),
            ),
        )
        .await;
        let seen = mock.requests();
        assert!(
            seen.iter().any(|line| line.starts_with("HEAD ")),
            "HeadObject was not called: {seen:?}"
        );
        assert_eq!(object_key_of(&seen[0]), "photo.png");
        assert_eq!(response.status, StatusCode::NOT_FOUND);
        assert_eq!(
            response.body,
            r#"{"code":"not_found","message":"Not found"}"#
        );
    }

    async fn exchange_bytes(app: &App, request: Request<Body>) -> (StatusCode, Vec<u8>) {
        let response = router(app.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        (status, bytes.to_vec())
    }

    fn drive_letter_prefix(name: &str) -> bool {
        name.split(['/', '\\']).any(|segment| {
            let bytes = segment.as_bytes();
            bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
        })
    }

    fn collision_suffix(name: &str) -> bool {
        let file = name.rsplit('/').next().unwrap_or(name);
        if file.ends_with("-2") {
            return true;
        }
        file.rsplit_once('.')
            .is_some_and(|(stem, _)| stem.ends_with("-2"))
    }

    #[tokio::test]
    async fn archive_token_rejects_empty_or_missing_keys() {
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, "http://127.0.0.1:9", true).await;
        let (admin, _) = login(&app).await;
        for (body, code, message) in [
            ("{}", "invalid_keys", "keys must be an array of strings"),
            (
                r#"{"keys":[]}"#,
                "keys_required",
                "At least one key is required",
            ),
            (
                r#"{"keys":[1]}"#,
                "invalid_keys",
                "keys must be an array of strings",
            ),
        ] {
            let response = exchange(
                &app,
                request(
                    "POST",
                    "/api/buckets/bkt-1/archive-token",
                    Some(body),
                    Some(&admin),
                ),
            )
            .await;
            assert_error(&response, StatusCode::BAD_REQUEST, code, message);
            assert!(!response.body.contains("\"token\""), "{}", response.body);
        }
    }

    #[tokio::test]
    async fn archive_token_rejects_reuse_and_cleans_parent_segments() {
        let mock = S3Mock::start(|line| {
            let key = object_key_of(line);
            if key.contains("missing") {
                return head_missing();
            }
            if key.contains("..") {
                return object_bytes("application/octet-stream", "parent-secret");
            }
            object_bytes("application/octet-stream", "drive-secret")
        })
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let blocked = viewer_session(&app, &admin).await;
        let denied = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/archive-token",
                Some(&json!({ "keys": ["../secret.txt"] }).to_string()),
                Some(&blocked),
            ),
        )
        .await;
        assert_eq!(denied.status, StatusCode::FORBIDDEN, "{}", denied.body);

        let created_user = exchange(
            &app,
            request(
                "POST",
                "/api/users",
                Some(
                    &json!({
                        "username": "Cara",
                        "password": "viewer horse",
                        "role": "viewer",
                        "can_download": true
                    })
                    .to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(created_user.status, StatusCode::CREATED, "{}", created_user.body);
        let owner = sign_in(&app, "Cara", "viewer horse").await;
        let issued = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/archive-token",
                Some(
                    &json!({
                        "keys": ["../secret.txt", "C:/secret.txt", "missing.txt"]
                    })
                    .to_string(),
                ),
                Some(&owner),
            ),
        )
        .await;
        assert_eq!(issued.status, StatusCode::OK, "{}", issued.body);
        let token = serde_json::from_str::<Value>(&issued.body).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let archive_path = format!("/api/buckets/bkt-1/archive?token={token}");
        let other = exchange(&app, request("GET", &archive_path, None, Some(&admin))).await;
        assert_eq!(other.status, StatusCode::FORBIDDEN, "{}", other.body);

        let (status, bytes) = exchange_bytes(
            &app,
            request("GET", &archive_path, None, Some(&owner)),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("zip");
        let mut names = Vec::new();
        let mut errors = String::new();
        for index in 0..archive.len() {
            let mut file = archive.by_index(index).unwrap();
            let name = file.name().unwrap().into_owned();
            if name == "_errors.txt" {
                file.read_to_string(&mut errors).unwrap();
            }
            names.push(name);
        }
        let mut secret = archive.by_name("secret.txt").unwrap();
        let mut secret_body = String::new();
        secret.read_to_string(&mut secret_body).unwrap();
        assert_eq!(secret_body, "parent-secret");
        assert!(names.iter().any(|name| name == "secret.txt"), "{names:?}");
        assert!(names.iter().any(|name| collision_suffix(name)), "{names:?}");
        assert!(
            names
                .iter()
                .all(|name| !name.contains("..") && !drive_letter_prefix(name)),
            "{names:?}"
        );
        assert!(errors.contains("missing.txt"), "{errors}");
        assert!(
            names
                .iter()
                .filter(|name| name.as_str() != "_errors.txt")
                .all(|name| !name.contains("missing")),
            "{names:?}"
        );

        let again = exchange(&app, request("GET", &archive_path, None, Some(&owner))).await;
        assert_eq!(again.status, StatusCode::NOT_FOUND, "{}", again.body);
        assert!(!crate::zip::token_is_fresh(60));
        assert!(crate::zip::token_is_fresh(59));
    }

    #[tokio::test]
    async fn archive_starts_the_zip_before_the_second_object_is_fully_read() {
        let hold = Arc::new(GetHold {
            key: "a/two.txt".to_string(),
            release: AtomicBool::new(false),
            early: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        });
        let mock = S3Mock::start_holding_get(
            |line| {
                let body = if object_key_of(line) == "a/two.txt" {
                    "two-body"
                } else {
                    "one-body"
                };
                object_bytes("text/plain", body)
            },
            Arc::clone(&hold),
        )
        .await;
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, &mock.url, true).await;
        let (admin, _) = login(&app).await;
        let issued = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/archive-token",
                Some(&json!({ "keys": ["a/one.txt", "a/two.txt"] }).to_string()),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(issued.status, StatusCode::OK, "{}", issued.body);
        let token = serde_json::from_str::<Value>(&issued.body).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let archive_path = format!("/api/buckets/bkt-1/archive?token={token}");
        let response = router(app.clone())
            .oneshot(request("GET", &archive_path, None, Some(&admin)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let disposition = response
            .headers()
            .get("content-disposition")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let had_length = response.headers().get("content-length").is_some();
        let mut body = std::pin::pin!(response.into_body());
        let mut bytes = Vec::new();
        let mut released = false;
        while let Some(frame) =
            std::future::poll_fn(|cx| HttpBody::poll_frame(body.as_mut(), cx)).await
        {
            let frame = frame.expect("archive frame");
            let Ok(chunk) = frame.into_data() else {
                continue;
            };
            if !released && !chunk.is_empty() {
                released = true;
                hold.release.store(true, Ordering::SeqCst);
                hold.notify.notify_waiters();
            }
            bytes.extend_from_slice(&chunk);
        }
        assert!(released, "archive body had no data");
        assert!(
            !hold.early.load(Ordering::SeqCst),
            "two.txt was released before any archive body byte"
        );
        assert!(!had_length, "archive response buffered a content-length");
        assert_eq!(content_type, "application/zip");
        assert!(
            disposition.contains("archive.zip"),
            "{disposition}"
        );
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("zip");
        assert_eq!(archive.len(), 2);
        assert!(archive.by_name("_errors.txt").is_err());
        {
            let mut file = archive.by_name("one.txt").unwrap();
            assert_eq!(file.compression(), zip::CompressionMethod::Stored);
            let mut text = String::new();
            file.read_to_string(&mut text).unwrap();
            assert_eq!(text, "one-body");
        }
        let mut file = archive.by_name("two.txt").unwrap();
        assert_eq!(file.compression(), zip::CompressionMethod::Stored);
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(text, "two-body");
    }

    #[tokio::test]
    async fn share_denial_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/share",
                Some(
                    &json!({ "ttl_seconds": 3600, "bucket": "bkt-1", "key": "a.txt" }).to_string(),
                ),
                Some(&viewer),
            ),
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
        assert_eq!(row.path, "/api/share");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 403);
    }

    #[tokio::test]
    async fn share_rate_limit_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let body = json!({ "ttl_seconds": 3600, "bucket": "bkt-1", "key": "a.txt" }).to_string();
        for _ in 0..10 {
            let response = exchange(
                &app,
                request("POST", "/api/share", Some(&body), Some(&admin)),
            )
            .await;
            assert_eq!(response.status, StatusCode::NOT_IMPLEMENTED, "{}", response.body);
            assert_eq!(code_of(&response.body), "share_unavailable");
        }
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let blocked = exchange(
            &app,
            request("POST", "/api/share", Some(&body), Some(&admin)),
        )
        .await;
        assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS, "{}", blocked.body);
        assert_eq!(code_of(&blocked.body), "rate_limited");
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "rate_limited");
        assert_eq!(row.reason, "rate_limited");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/share");
        assert_eq!(row.target, "");
        assert_eq!(row.status, 429);
    }

    #[tokio::test]
    async fn share_success_is_audited() {
        let secret = "project-secret-value";
        let dir = crate::util::temp_dir();
        let app = state::test_app_with(
            &dir,
            &[
                ("PUBLIC_S3_URL", "http://127.0.0.1:3901"),
                ("S3_REGION", "garage"),
                ("S3_ACCESS_KEY_ID", "PROJECT"),
                ("S3_SECRET_ACCESS_KEY", secret),
            ],
            test_quota(),
        )
        .await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/share",
                Some(
                    &json!({ "ttl_seconds": 3600, "bucket": "bkt-1", "key": "a.txt" }).to_string(),
                ),
                Some(&admin),
            ),
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "success");
        assert_eq!(row.reason, "ok");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/share");
        assert_eq!(row.target, "bkt-1\na.txt\n3600");
        assert_eq!(row.status, 200);
        assert!(!audit_text(row).contains(secret));
    }

    #[tokio::test]
    async fn object_put_missing_length_is_audited() {
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, "http://127.0.0.1:9", true).await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                b"hello",
                None,
                &admin,
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "length_required",
            "Content-Length is required",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "length_required");
        assert_eq!(row.method, "PUT");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects/photos/a.txt");
        assert_eq!(row.target, "bkt-1/photos/a.txt");
        assert_eq!(row.status, 400);
        assert!(!audit_text(row).contains("hello"));
    }

    #[tokio::test]
    async fn object_put_too_large_is_audited() {
        let dir = crate::util::temp_dir();
        let app = object_app(&dir, "http://127.0.0.1:9", true).await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            put_bytes(
                "/api/buckets/bkt-1/objects/photos/a.txt",
                b"hello",
                Some("9999999999"),
                &admin,
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Upload is too large",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "payload_too_large");
        assert_eq!(row.method, "PUT");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects/photos/a.txt");
        assert_eq!(row.target, "bkt-1/photos/a.txt");
        assert_eq!(row.status, 413);
        assert!(!audit_text(row).contains("hello"));
    }

    #[tokio::test]
    async fn object_delete_many_denial_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let viewer = viewer_session(&app, &admin).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(&json!({ "keys": ["a.txt"] }).to_string()),
                Some(&viewer),
            ),
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
        assert_eq!(row.path, "/api/buckets/bkt-1/objects:delete");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 403);
        assert!(!audit_text(row).contains("a.txt"));
    }

    #[tokio::test]
    async fn object_delete_many_invalid_keys_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some("{}"),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "invalid_keys",
            "keys must be an array of strings",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "invalid_keys");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects:delete");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);
    }

    #[tokio::test]
    async fn object_delete_many_keys_required_is_audited() {
        let dir = crate::util::temp_dir();
        let app = app_for(&dir, "http://127.0.0.1:9").await;
        let (admin, _) = login(&app).await;
        let before = crate::db::recent_audit(&app.db).await.unwrap();
        let response = exchange(
            &app,
            request(
                "POST",
                "/api/buckets/bkt-1/objects:delete",
                Some(r#"{"keys":[]}"#),
                Some(&admin),
            ),
        )
        .await;
        assert_error(
            &response,
            StatusCode::BAD_REQUEST,
            "keys_required",
            "At least one key is required",
        );
        let rows = crate::db::recent_audit(&app.db).await.unwrap();
        assert_eq!(rows.len(), before.len() + 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.username, "Ada");
        assert_eq!(row.result, "error");
        assert_eq!(row.reason, "keys_required");
        assert_eq!(row.method, "POST");
        assert_eq!(row.path, "/api/buckets/bkt-1/objects:delete");
        assert_eq!(row.target, "bkt-1");
        assert_eq!(row.status, 400);
    }
