    const METHODS: [&str; 9] = [
        "get", "head", "delete", "options", "patch", "post", "put", "trace", "connect",
    ];

    fn api_calls(router: &impl std::fmt::Debug) -> Vec<(String, String)> {
        let text = format!("{router:?}");
        let path_router = section_until(&text, "path_router:", "fallback_router:");
        let paths = path_table(section_brace(path_router, "paths:"));
        let mut calls = Vec::new();
        for (id, path) in paths {
            if !path.starts_with("/api") {
                continue;
            }
            let needle = format!("RouteId({id}): MethodRouter");
            let start = path_router
                .find(&needle)
                .unwrap_or_else(|| panic!("router has {path} but no method table"));
            let block = section_brace(&path_router[start..], "MethodRouter {");
            let mut methods = Vec::new();
            for name in METHODS {
                if field_is_set(block, name) {
                    methods.push(name.to_uppercase());
                }
            }
            if methods.is_empty() {
                assert!(
                    field_is_set(block, "fallback"),
                    "{path} has no method in the router"
                );
                methods.push("GET".to_string());
            }
            for method in methods {
                calls.push((method, path.clone()));
            }
        }
        calls.sort();
        calls.dedup();
        assert!(
            calls
                .iter()
                .any(|(method, path)| method == "POST" && path == "/api/setup"),
            "setup route missing from the router"
        );
        assert!(
            calls
                .iter()
                .any(|(method, path)| method == "GET" && path == "/api/auth/status"),
            "status route missing from the router"
        );
        assert!(
            calls
                .iter()
                .any(|(method, path)| method == "GET" && path == "/api/keys"),
            "keys route missing from the router"
        );
        assert!(
            calls.len() >= 60,
            "expected the crate routers to expose at least 60 calls, found {}",
            calls.len()
        );
        calls
    }

    fn section_until<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
        let from = text
            .find(start)
            .unwrap_or_else(|| panic!("missing {start}"));
        let rest = &text[from..];
        let to = rest.find(end).unwrap_or_else(|| panic!("missing {end}"));
        &rest[..to]
    }

    fn section_brace<'a>(text: &'a str, marker: &str) -> &'a str {
        let from = text
            .find(marker)
            .unwrap_or_else(|| panic!("missing {marker}"));
        let rest = &text[from..];
        let open = rest
            .find('{')
            .unwrap_or_else(|| panic!("{marker} has no block"));
        take_brace(&rest[open..])
    }

    fn take_brace(text: &str) -> &str {
        let mut depth = 0_i32;
        for (index, ch) in text.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &text[..=index];
                    }
                }
                _ => {}
            }
        }
        panic!("unclosed router block");
    }

    fn path_table(block: &str) -> Vec<(u32, String)> {
        let mut rest = block;
        let mut paths = Vec::new();
        while let Some(at) = rest.find("RouteId(") {
            rest = &rest[at + "RouteId(".len()..];
            let end = rest.find(')').expect("route id");
            let id: u32 = rest[..end].parse().expect("route id number");
            rest = &rest[end..];
            let quote = rest.find('"').expect("route path");
            rest = &rest[quote + 1..];
            let end_quote = rest.find('"').expect("route path end");
            paths.push((id, rest[..end_quote].to_string()));
            rest = &rest[end_quote + 1..];
        }
        paths
    }

    fn field_is_set(block: &str, name: &str) -> bool {
        let marker = format!("{name}: ");
        let Some(at) = block.find(&marker) else {
            return false;
        };
        !block[at + marker.len()..].starts_with("None")
    }

    fn request_path(pattern: &str) -> String {
        let mut path = String::new();
        let mut rest = pattern;
        while let Some(start) = rest.find('{') {
            path.push_str(&rest[..start]);
            let end = rest[start..]
                .find('}')
                .unwrap_or_else(|| panic!("unclosed parameter in {pattern}"));
            path.push('x');
            rest = &rest[start + end + 1..];
        }
        path.push_str(rest);
        path
    }

    fn expect_closed(method: &str, path: &str, response: &Exchange) {
        assert_eq!(
            response.status,
            StatusCode::UNAUTHORIZED,
            "{method} {path} {}",
            response.body
        );
        let body: Value = serde_json::from_str(&response.body)
            .unwrap_or_else(|_| panic!("{method} {path} {}", response.body));
        assert_eq!(
            body,
            json!({ "code": "unauthenticated", "message": "Login required" }),
            "{method} {path}"
        );
    }

    #[tokio::test]
    async fn uninitialized_apis_return_401_except_setup_and_status() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let calls = api_calls(&super::routes(app.clone()));
        for (method, pattern) in calls {
            let path = request_path(&pattern);
            if method == "POST" && pattern == "/api/setup" {
                let response = exchange(
                    &app,
                    request(
                        "POST",
                        &path,
                        Some(&json!({ "username": "bad name", "password": PASSWORD }).to_string()),
                        None,
                    ),
                )
                .await;
                assert_error(
                    &response,
                    StatusCode::BAD_REQUEST,
                    "invalid_username",
                    "Username is invalid",
                );
                continue;
            }
            if method == "GET" && pattern == "/api/auth/status" {
                let response = exchange(&app, request("GET", &path, None, None)).await;
                assert_eq!(response.status, StatusCode::OK, "{}", response.body);
                assert_eq!(
                    serde_json::from_str::<Value>(&response.body).unwrap(),
                    json!({
                        "initialized": false,
                        "authenticated": false,
                        "username": null,
                        "role": null,
                        "can_download": null,
                        "can_share": null,
                        "garage_version": null,
                        "garage_write_blocked": false,
                        "tls_insecure": false,
                    })
                );
                continue;
            }
            let response = exchange(&app, request(&method, &path, None, None)).await;
            expect_closed(&method, &path, &response);
        }
    }

    #[tokio::test]
    async fn deleted_data_directory_replaces_the_session_key_and_rejects_the_old_session() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let first_key = std::fs::read(dir.join("session.key")).expect("session.key");
        let created = exchange(
            &app,
            request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                None,
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.body);
        let session = session_from(&created.headers);
        app.db.close().await;
        drop(app);
        std::fs::remove_dir_all(&dir).expect("delete data directory");
        std::fs::create_dir(&dir).expect("empty data directory");
        let restarted = crate::state::test_app(&dir).await;
        let second_key = std::fs::read(dir.join("session.key")).expect("new session.key");
        assert_ne!(first_key, second_key);
        let stale = exchange(
            &restarted,
            request("GET", "/api/keys", None, Some(&session)),
        )
        .await;
        assert_eq!(stale.status, StatusCode::UNAUTHORIZED, "{}", stale.body);
        assert_eq!(
            serde_json::from_str::<Value>(&stale.body).unwrap(),
            json!({ "code": "unauthenticated", "message": "Login required" })
        );
    }

    #[test]
    fn exact_setup_and_status_paths_are_the_only_open_routes_before_setup() {
        let closed = [
            ("POST", "/api/garage/v2/api/setup"),
            ("GET", "/api/garage/v2/api/auth/status"),
            ("GET", "/api/buckets/bkt/inspect?key=notes%2Fapi%2Fauth%2Fstatus"),
            ("POST", "/api/setup/extra"),
            ("GET", "/admin/api/auth/status"),
            ("HEAD", "/api/auth/status"),
        ];
        for (method, path) in closed {
            let http = method.parse::<axum::http::Method>().expect(method);
            assert!(
                !super::open_before_setup(&http, path),
                "{method} {path} counted as open"
            );
        }
        let open = [
            ("POST", "/api/setup"),
            ("GET", "/api/auth/status"),
            ("POST", "/api/setup/"),
            ("GET", "/api/auth/status/"),
            ("POST", "/api/setup?next=1"),
            ("GET", "/api/auth/status?next=1"),
            ("POST", "/api/setup/?next=1"),
            ("GET", "/api/auth/status/?next=1"),
        ];
        for (method, path) in open {
            let http = method.parse::<axum::http::Method>().expect(method);
            assert!(
                super::open_before_setup(&http, path),
                "{method} {path} counted as closed"
            );
        }
    }
