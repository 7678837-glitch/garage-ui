    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use axum::body::{Body, HttpBody};
    use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
    use axum::response::IntoResponse;
    use serde_json::{Value, json};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    use crate::error::ApiError;
    use crate::limit::test_quota;
    use crate::objects;
    use crate::router;
    use crate::state::{self, App};

    const PASSWORD: &str = "correct horse";
    const TOKEN: &str = "admin-token-value1";

    struct Session {
        id: String,
        csrf: String,
    }

    struct Exchange {
        status: StatusCode,
        headers: HeaderMap,
        body: String,
    }

    struct GarageMock {
        url: String,
        hits: Arc<AtomicUsize>,
        requests: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for GarageMock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl GarageMock {
        async fn start(node_info: &str) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let hits = Arc::new(AtomicUsize::new(0));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let hits_task = Arc::clone(&hits);
            let requests_task = Arc::clone(&requests);
            let node_info = node_info.to_string();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    hits_task.fetch_add(1, Ordering::SeqCst);
                    let mut buf = Vec::new();
                    let mut tmp = [0_u8; 1024];
                    while let Ok(read) = socket.read(&mut tmp).await {
                        if read == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..read]);
                        if buf.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let text = String::from_utf8_lossy(&buf);
                    let line = text.lines().next().unwrap_or("").to_string();
                    requests_task.lock().expect("requests").push(line.clone());
                    let body = if line.contains("/v2/GetNodeInfo?") {
                        node_info.clone()
                    } else {
                        r#"{"ok":true}"#.to_string()
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    if socket.write_all(response.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = socket.shutdown().await;
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                hits,
                requests,
                task,
            }
        }

        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("requests").clone()
        }
    }

    fn cookie_header(session: &Session) -> String {
        format!(
            "garage_session={}; garage_csrf={}",
            session.id, session.csrf
        )
    }

    fn session_from(headers: &HeaderMap) -> Session {
        let mut id = None;
        let mut csrf = None;
        for value in headers.get_all("set-cookie") {
            let text = value.to_str().expect("cookie");
            let pair = text.split(';').next().expect("pair");
            let (name, val) = pair.split_once('=').expect("equals");
            if name == "garage_session" {
                id = Some(val.to_string());
            }
            if name == "garage_csrf" {
                csrf = Some(val.to_string());
            }
        }
        Session {
            id: id.expect("session cookie"),
            csrf: csrf.expect("csrf cookie"),
        }
    }

    fn request(
        method: &str,
        uri: &str,
        body: Option<&str>,
        session: Option<&Session>,
    ) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(session) = session {
            builder = builder
                .header("cookie", cookie_header(session))
                .header("x-csrf-token", &session.csrf);
        }
        if let Some(body) = body {
            builder = builder.header("content-type", "application/json");
            return builder.body(Body::from(body.to_string())).unwrap();
        }
        builder.body(Body::empty()).unwrap()
    }

    async fn exchange(app: &App, request: Request<Body>) -> Exchange {
        let response = router(app.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        Exchange {
            status,
            headers,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    async fn login(app: &App) -> (Session, HeaderMap) {
        let response = router(app.clone())
            .oneshot(request(
                "POST",
                "/api/setup",
                Some(&json!({ "username": "Ada", "password": PASSWORD }).to_string()),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers().clone();
        (session_from(&headers), headers)
    }

    async fn app_for(dir: &std::path::Path, url: &str) -> App {
        state::test_app_with(
            dir,
            &[("GARAGE_ADMIN_URL", url), ("GARAGE_ADMIN_TOKEN", TOKEN)],
            test_quota(),
        )
        .await
    }

    fn code_of(body: &str) -> String {
        serde_json::from_str::<Value>(body).unwrap()["code"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }

    struct Download {
        status: StatusCode,
        body: String,
        disposition: String,
    }

    async fn download(app: &App, session: &Session, name: &str) -> Download {
        let response = router(app.clone())
            .oneshot(request(
                "GET",
                &format!("/api/objects/download?name={name}"),
                None,
                Some(session),
            ))
            .await
            .unwrap();
        let status = response.status();
        let disposition = response
            .headers()
            .get("content-disposition")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        Download {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
            disposition,
        }
    }

    struct CatalogMock {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for CatalogMock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl CatalogMock {
        async fn start() -> Self {
            Self::open(None).await
        }

        async fn start_buckets(count: usize) -> Self {
            Self::open(Some(count)).await
        }

        async fn open(buckets: Option<usize>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let requests_task = Arc::clone(&requests);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        break;
                    };
                    let _ = serve_catalog(socket, Arc::clone(&requests_task), buckets).await;
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                requests,
                task,
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("requests").clone()
        }
    }

    async fn serve_catalog(
        mut socket: tokio::net::TcpStream,
        requests: Arc<Mutex<Vec<String>>>,
        buckets: Option<usize>,
    ) -> std::io::Result<()> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..read]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() > 65536 {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf);
        let line = text.lines().next().unwrap_or("").to_string();
        requests.lock().expect("requests").push(line.clone());
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let path = target.split('?').next().unwrap_or("");
        let (status, body) = match path {
            "/v2/ListBucketsInfo" => (
                "200 OK",
                match buckets {
                    Some(count) => counted_bucket_page(count, target),
                    None => catalog_json(&["b0", "b1", "b2"], target),
                },
            ),
            "/v2/ListKeysInfo" => ("200 OK", catalog_json(&["k0", "k1", "k2"], target)),
            _ => ("404 Not Found", r#"{"error":"not found"}"#.to_string()),
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await?;
        let _ = socket.shutdown().await;
        Ok(())
    }

    fn counted_bucket_id(index: usize) -> String {
        format!("{index:05}")
    }

    fn counted_bucket_page(count: usize, target: &str) -> String {
        let limit = query_value(target, "limit")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(count);
        let start = query_value(target, "offset")
            .and_then(|id| (0..count).find(|index| counted_bucket_id(*index) == id))
            .unwrap_or(0);
        let end = start.saturating_add(limit).min(count);
        let items: Vec<_> = (start..end)
            .map(|index| json!({ "id": counted_bucket_id(index) }))
            .collect();
        serde_json::to_string(&items).unwrap()
    }

    fn catalog_json(ids: &[&str], target: &str) -> String {
        let limit = query_value(target, "limit")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(ids.len());
        let start = query_value(target, "offset")
            .and_then(|id| ids.iter().position(|item| *item == id))
            .unwrap_or(0);
        let end = start.saturating_add(limit).min(ids.len());
        let items: Vec<_> = ids[start..end]
            .iter()
            .map(|id| json!({ "id": id }))
            .collect();
        serde_json::to_string(&items).unwrap()
    }

    fn query_value<'a>(target: &'a str, key: &str) -> Option<&'a str> {
        let query = target.split_once('?')?.1;
        query.split('&').find_map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (name == key).then_some(value)
        })
    }

    fn assert_error(response: &Exchange, status: StatusCode, code: &str, message: &str) {
        assert_eq!(response.status, status, "{}", response.body);
        assert_eq!(
            serde_json::from_str::<Value>(&response.body).unwrap(),
            json!({ "code": code, "message": message })
        );
    }

    async fn sign_in(app: &App, username: &str, password: &str) -> Session {
        let response = router(app.clone())
            .oneshot(request(
                "POST",
                "/api/auth/login",
                Some(&json!({ "username": username, "password": password }).to_string()),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        session_from(response.headers())
    }

    #[derive(Clone)]
    struct UpstreamCall {
        line: String,
        body: String,
    }

    struct Upstream {
        url: String,
        hits: Arc<AtomicUsize>,
        calls: Arc<Mutex<Vec<UpstreamCall>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Upstream {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    #[derive(Clone)]
    enum UpstreamReply {
        Ok(String),
        Fixed(&'static str, String),
        WorkerVariables,
    }

    impl Upstream {
        async fn start(reply: UpstreamReply) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let hits = Arc::new(AtomicUsize::new(0));
            let calls = Arc::new(Mutex::new(Vec::new()));
            let hits_task = Arc::clone(&hits);
            let calls_task = Arc::clone(&calls);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    hits_task.fetch_add(1, Ordering::SeqCst);
                    let Ok((line, body)) = read_upstream(&mut socket).await else {
                        break;
                    };
                    calls_task.lock().expect("calls").push(UpstreamCall {
                        line: line.clone(),
                        body,
                    });
                    let (status, response_body) = upstream_reply(&line, &reply);
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{response_body}",
                        response_body.len()
                    );
                    if socket.write_all(response.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = socket.shutdown().await;
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                hits,
                calls,
                task,
            }
        }

        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }

        fn calls(&self) -> Vec<UpstreamCall> {
            self.calls.lock().expect("calls").clone()
        }
    }

    fn upstream_reply(line: &str, reply: &UpstreamReply) -> (String, String) {
        if line.contains("/v2/GetNodeInfo?") {
            return (
                "200 OK".to_string(),
                r#"{"garageVersion":"v2.3.0"}"#.to_string(),
            );
        }
        if let UpstreamReply::WorkerVariables = reply {
            if line.contains("/v2/SetWorkerVariable?") {
                return (
                    "200 OK".to_string(),
                    r#"{"success":{"n1":{"variable":"scrub_tranquility","value":"3"}},"error":{"gone":"down"}}"#
                        .to_string(),
                );
            }
            if line.contains("/v2/GetWorkerVariable?") {
                return (
                    "200 OK".to_string(),
                    r#"{"success":{"n1":{"scrub_tranquility":"3"}},"error":{"gone":"down"}}"#
                        .to_string(),
                );
            }
        }
        match reply {
            UpstreamReply::Ok(body) => ("200 OK".to_string(), body.clone()),
            UpstreamReply::Fixed(status, body) => ((*status).to_string(), body.clone()),
            UpstreamReply::WorkerVariables => (
                "500 Internal Server Error".to_string(),
                r#"{"error":"unexpected worker call"}"#.to_string(),
            ),
        }
    }

    async fn read_upstream(
        socket: &mut tokio::net::TcpStream,
    ) -> std::io::Result<(String, String)> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 2048];
        let header_end = loop {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "headers",
                ));
            }
            buf.extend_from_slice(&tmp[..read]);
            if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                break pos + 4;
            }
        };
        let header_text = String::from_utf8_lossy(&buf[..header_end]).into_owned();
        let length = header_text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap_or(0))
        });
        let mut body = buf[header_end..].to_vec();
        if let Some(length) = length {
            while body.len() < length {
                let read = socket.read(&mut tmp).await?;
                if read == 0 {
                    break;
                }
                body.extend_from_slice(&tmp[..read]);
            }
            body.truncate(length);
        }
        let line = header_text.lines().next().unwrap_or("").to_string();
        Ok((line, String::from_utf8_lossy(&body).into_owned()))
    }

    async fn viewer_session(app: &App, admin: &Session) -> Session {
        let created = exchange(
            app,
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
                Some(admin),
            ),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
        sign_in(app, "Bea", "viewer horse").await
    }

    fn bucket_info_calls(mock: &Upstream) -> Vec<UpstreamCall> {
        mock.calls()
            .into_iter()
            .filter(|call| call.line.contains("GetBucketInfo"))
            .collect()
    }

    struct ListStatus {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for ListStatus {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    #[derive(Clone, Copy)]
    enum ListReply {
        Fixed(&'static str, &'static str, &'static str),
        InfoThenPage,
    }

    impl ListStatus {
        async fn start(reply: ListReply) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&requests);
            let info_calls = Arc::new(AtomicUsize::new(0));
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let recorded = Arc::clone(&recorded);
                    let info_calls = Arc::clone(&info_calls);
                    tokio::spawn(async move {
                        let Ok(line) = read_request_line(&mut socket).await else {
                            return;
                        };
                        recorded.lock().expect("requests").push(line.clone());
                        let path = line.split_whitespace().nth(1).unwrap_or("");
                        let path = path.split('?').next().unwrap_or("");
                        let (status, content_type, body) = list_reply(path, &reply, &info_calls);
                        let _ = write_plain(&mut socket, status, content_type, body).await;
                    });
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                requests,
                task,
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("requests").clone()
        }
    }

    fn list_reply(
        path: &str,
        reply: &ListReply,
        info_calls: &AtomicUsize,
    ) -> (&'static str, &'static str, &'static str) {
        match path {
            "/v2/ListBucketsInfo" => match reply {
                ListReply::InfoThenPage => {
                    let call = info_calls.fetch_add(1, Ordering::SeqCst);
                    if call == 0 {
                        ("403 Forbidden", "text/plain", "denied by policy")
                    } else {
                        ("200 OK", "application/json", r#"[{"id":"b0"}]"#)
                    }
                }
                ListReply::Fixed(status, content_type, body) => (status, content_type, body),
            },
            "/v2/ListBuckets" => ("500 Internal Server Error", "text/plain", "id list"),
            _ => ("500 Internal Server Error", "text/plain", "unexpected"),
        }
    }

    async fn read_request_line(socket: &mut tokio::net::TcpStream) -> std::io::Result<String> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..read]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() > 65536 {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf);
        Ok(text.lines().next().unwrap_or("").to_string())
    }

    async fn write_plain(
        socket: &mut tokio::net::TcpStream,
        status: &str,
        content_type: &str,
        body: &str,
    ) -> std::io::Result<()> {
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await?;
        let _ = socket.shutdown().await;
        Ok(())
    }

    fn cluster_calls(mock: &Upstream, endpoint: &str) -> Vec<UpstreamCall> {
        mock.calls()
            .into_iter()
            .filter(|call| call.line.contains(endpoint))
            .collect()
    }

    fn assert_cluster_get(calls: &[UpstreamCall], path: &str) {
        let lines: Vec<_> = calls.iter().map(|call| call.line.as_str()).collect();
        assert_eq!(lines.len(), 1, "{lines:?}");
        let target = lines[0].split_whitespace().nth(1).unwrap_or("");
        assert_eq!(target, path, "{}", lines[0]);
        assert!(calls[0].body.is_empty(), "{}", calls[0].body);
    }

    #[derive(Clone)]
    struct CapturedCall {
        line: String,
        body: Vec<u8>,
    }

    struct ConnectCapture {
        url: String,
        calls: Arc<Mutex<Vec<CapturedCall>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for ConnectCapture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl ConnectCapture {
        async fn start(reply: &'static [u8]) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let calls = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&calls);
            let reply = reply.to_vec();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let recorded = Arc::clone(&recorded);
                    let reply = reply.clone();
                    tokio::spawn(async move {
                        let Ok((line, body)) = read_upstream(&mut socket).await else {
                            return;
                        };
                        recorded.lock().expect("calls").push(CapturedCall {
                            line: line.clone(),
                            body: body.into_bytes(),
                        });
                        let body = if line.contains("/v2/GetNodeInfo?") {
                            br#"{"garageVersion":"v2.3.0"}"#.to_vec()
                        } else {
                            reply
                        };
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let mut response = header.into_bytes();
                        response.extend_from_slice(&body);
                        let _ = socket.write_all(&response).await;
                        let _ = socket.shutdown().await;
                    });
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                calls,
                task,
            }
        }

        fn calls(&self) -> Vec<CapturedCall> {
            self.calls.lock().expect("calls").clone()
        }
    }

    struct InfoSocket {
        url: String,
        hits: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for InfoSocket {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl InfoSocket {
        async fn start(info_status: u16) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let hits = Arc::new(AtomicUsize::new(0));
            let hits_task = Arc::clone(&hits);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        break;
                    };
                    hits_task.fetch_add(1, Ordering::SeqCst);
                    let _ = answer_info(socket, info_status).await;
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                hits,
                task,
            }
        }

        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }
    }

    async fn answer_info(
        mut socket: tokio::net::TcpStream,
        info_status: u16,
    ) -> std::io::Result<()> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            let read = socket.read(&mut tmp).await?;
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..read]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() > 65536 {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf);
        let line = text.lines().next().unwrap_or("");
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let path = target.split('?').next().unwrap_or("");
        let (status, body) = info_reply(path, info_status);
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await?;
        let _ = socket.shutdown().await;
        Ok(())
    }

    fn info_reply(path: &str, info_status: u16) -> (&'static str, String) {
        if path.ends_with("ListBucketsInfo") || path.ends_with("ListKeysInfo") {
            if info_status == 404 {
                return ("404 Not Found", r#"{"error":"missing"}"#.to_string());
            }
            return ("200 OK", r#"[{"id":"item-1"}]"#.to_string());
        }
        if path.ends_with("ListBuckets") || path.ends_with("ListKeys") {
            return ("200 OK", r#"[{"id":"item-1"}]"#.to_string());
        }
        if path.ends_with("GetBucketInfo") || path.ends_with("GetKeyInfo") {
            return ("200 OK", r#"{"id":"item-1"}"#.to_string());
        }
        ("404 Not Found", r#"{"error":"missing"}"#.to_string())
    }

    struct PartHold {
        released: AtomicBool,
        notify: tokio::sync::Notify,
    }

    struct GetHold {
        key: String,
        release: AtomicBool,
        early: AtomicBool,
        notify: tokio::sync::Notify,
    }

    struct S3Mock {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        content_types: Arc<Mutex<Vec<Option<String>>>>,
        bodies: Arc<Mutex<Vec<String>>>,
        hold: Option<Arc<PartHold>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for S3Mock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl S3Mock {
        async fn start(reply: impl Fn(&str) -> String + Send + Sync + 'static) -> Self {
            Self::serve(move |line| reply(line).into_bytes(), None, None).await
        }

        async fn start_bytes(reply: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static) -> Self {
            Self::serve(reply, None, None).await
        }

        async fn start_holding_parts(
            reply: impl Fn(&str) -> String + Send + Sync + 'static,
        ) -> Self {
            let hold = Arc::new(PartHold {
                released: AtomicBool::new(false),
                notify: tokio::sync::Notify::new(),
            });
            Self::serve(move |line| reply(line).into_bytes(), Some(hold), None).await
        }

        async fn start_holding_get(
            reply: impl Fn(&str) -> String + Send + Sync + 'static,
            hold: Arc<GetHold>,
        ) -> Self {
            Self::serve(move |line| reply(line).into_bytes(), None, Some(hold)).await
        }

        fn release_parts(&self) {
            let Some(hold) = &self.hold else {
                return;
            };
            hold.released.store(true, Ordering::SeqCst);
            hold.notify.notify_waiters();
        }

        async fn serve(
            reply: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static,
            hold: Option<Arc<PartHold>>,
            get_hold: Option<Arc<GetHold>>,
        ) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let content_types = Arc::new(Mutex::new(Vec::new()));
            let bodies = Arc::new(Mutex::new(Vec::new()));
            let requests_task = Arc::clone(&requests);
            let content_types_task = Arc::clone(&content_types);
            let bodies_task = Arc::clone(&bodies);
            let reply = Arc::new(reply);
            let hold_task = hold.clone();
            let get_hold_task = get_hold.clone();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let requests_task = Arc::clone(&requests_task);
                    let content_types_task = Arc::clone(&content_types_task);
                    let bodies_task = Arc::clone(&bodies_task);
                    let reply = Arc::clone(&reply);
                    let hold = hold_task.clone();
                    let get_hold = get_hold_task.clone();
                    tokio::spawn(async move {
                        let mut buf = Vec::new();
                        let mut tmp = [0_u8; 4096];
                        let header_end = loop {
                            let Ok(Ok(read)) =
                                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut tmp))
                                    .await
                            else {
                                return;
                            };
                            if read == 0 {
                                return;
                            }
                            buf.extend_from_slice(&tmp[..read]);
                            if let Some(pos) =
                                buf.windows(4).position(|window| window == b"\r\n\r\n")
                            {
                                break pos;
                            }
                            if buf.len() > 64 * 1024 {
                                return;
                            }
                        };
                        let text = String::from_utf8_lossy(&buf[..header_end]);
                        let line = text.lines().next().unwrap_or("").to_string();
                        let recorded = match header_value(&text, "range") {
                            Some(range) => format!("{line} Range: {range}"),
                            None => line.clone(),
                        };
                        let content_type = header_value(&text, "content-type").map(str::to_string);
                        let length = header_value(&text, "content-length")
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(0);
                        let mut body = buf[header_end + 4..].to_vec();
                        while body.len() < length {
                            let Ok(Ok(read)) =
                                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut tmp))
                                    .await
                            else {
                                return;
                            };
                            if read == 0 {
                                break;
                            }
                            body.extend_from_slice(&tmp[..read]);
                        }
                        body.truncate(length);
                        requests_task
                            .lock()
                            .expect("s3 requests")
                            .push(recorded.clone());
                        content_types_task
                            .lock()
                            .expect("s3 content types")
                            .push(content_type);
                        bodies_task
                            .lock()
                            .expect("s3 bodies")
                            .push(String::from_utf8_lossy(&body).into_owned());
                        if s3_operation(&line) == "part"
                            && let Some(hold) = &hold
                            && !part_reply_ready(hold).await
                        {
                            let _ = socket
                                .write_all(
                                    b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                )
                                .await;
                            let _ = socket.shutdown().await;
                            return;
                        }
                        // The socket read above uses this same two-second bound. Giving up still sends the object.
                        if line.starts_with("GET ")
                            && let Some(hold) = &get_hold
                            && object_key_of(&line) == hold.key
                            && !get_reply_ready(hold).await
                        {
                            hold.early.store(true, Ordering::SeqCst);
                        }
                        let response = reply(&recorded);
                        let _ = socket.write_all(&response).await;
                        let _ = socket.shutdown().await;
                    });
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                requests,
                content_types,
                bodies,
                hold,
                task,
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("s3 requests").clone()
        }

        fn content_types(&self) -> Vec<Option<String>> {
            self.content_types.lock().expect("s3 content types").clone()
        }

        fn bodies(&self) -> Vec<String> {
            self.bodies.lock().expect("s3 bodies").clone()
        }
    }

    async fn part_reply_ready(hold: &PartHold) -> bool {
        let notified = hold.notify.notified();
        hold.released.load(Ordering::SeqCst)
            || tokio::time::timeout(Duration::from_secs(20), notified)
                .await
                .is_ok()
            || hold.released.load(Ordering::SeqCst)
    }

    async fn get_reply_ready(hold: &GetHold) -> bool {
        let notified = hold.notify.notified();
        hold.release.load(Ordering::SeqCst)
            || tokio::time::timeout(Duration::from_secs(2), notified)
                .await
                .is_ok()
            || hold.release.load(Ordering::SeqCst)
    }

    async fn object_app(dir: &std::path::Path, endpoint: &str, with_key: bool) -> App {
        if with_key {
            state::test_app_with(
                dir,
                &[
                    ("S3_ENDPOINT_URL", endpoint),
                    ("S3_REGION", "garage"),
                    ("S3_ACCESS_KEY_ID", "PROJECT"),
                    ("S3_SECRET_ACCESS_KEY", "project-secret-value"),
                ],
                test_quota(),
            )
            .await
        } else {
            state::test_app_with(
                dir,
                &[("S3_ENDPOINT_URL", endpoint), ("S3_REGION", "garage")],
                test_quota(),
            )
            .await
        }
    }

    fn http_xml(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn head_missing() -> String {
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nContent-Type: application/xml\r\nConnection: close\r\n\r\n"
            .to_string()
    }

    fn request_target(line: &str) -> &str {
        line.split_whitespace().nth(1).unwrap_or("")
    }

    fn percent_decode(value: &str) -> String {
        let bytes = value.as_bytes();
        let mut out = Vec::new();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%' && index + 2 < bytes.len() {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    index += 3;
                    continue;
                }
            }
            out.push(bytes[index]);
            index += 1;
        }
        String::from_utf8(out).expect("decoded path")
    }

    fn object_key_of(line: &str) -> String {
        let path = request_target(line).split('?').next().unwrap_or("");
        let trimmed = path.trim_start_matches('/');
        let Some((_, key)) = trimmed.split_once('/') else {
            return String::new();
        };
        percent_decode(key)
    }

    fn header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
        headers.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    fn s3_operation(line: &str) -> &'static str {
        let target = request_target(line);
        if line.starts_with("POST ") && target.contains("uploads") {
            "create"
        } else if line.starts_with("PUT ") && query_value(target, "partNumber").is_some() {
            "part"
        } else if line.starts_with("POST ") && query_value(target, "uploadId").is_some() {
            "complete"
        } else if line.starts_with("DELETE ") && query_value(target, "uploadId").is_some() {
            "abort"
        } else if line.starts_with("PUT ") {
            "put"
        } else {
            "other"
        }
    }

    fn delete_ok() -> String {
        "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
    }

    fn audit_text(row: &crate::db::AuditRow) -> String {
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
    }

    fn header_text<'a>(response: &'a Exchange, name: &str) -> Option<&'a str> {
        response
            .headers
            .get(name)
            .and_then(|value| value.to_str().ok())
    }

    struct DownloadLog(Arc<Mutex<Vec<u8>>>);

    impl Write for DownloadLog {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("download log").extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn with_confirm(mut call: Request<Body>) -> Request<Body> {
        call.headers_mut()
            .insert("x-confirm", HeaderValue::from_static("yes"));
        call
    }
