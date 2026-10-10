use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::Response;
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/dist"]
struct Assets;

pub async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some(response) = file_response(path) {
        return response;
    }
    // 带扩展名的缺失文件是构建问题，不要回退成首页。
    if path.contains('.') {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap();
    }
    file_response("index.html").unwrap_or_else(|| {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap()
    })
}

fn file_response(path: &str) -> Option<Response> {
    let file = Assets::get(path)?;
    let cache = if path.ends_with(".html") {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    Some(
        Response::builder()
            .header(
                header::CONTENT_TYPE,
                HeaderValue::from_static(content_type(path)),
            )
            .header(header::CACHE_CONTROL, HeaderValue::from_static(cache))
            .body(Body::from(file.data.into_owned()))
            .unwrap(),
    )
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_types_cover_the_vite_output() {
        assert!(content_type("index.html").starts_with("text/html"));
        assert!(content_type("assets/app.js").starts_with("text/javascript"));
        assert!(content_type("assets/app.css").starts_with("text/css"));
    }
}
