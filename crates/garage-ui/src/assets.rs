use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::Response;
use rust_embed::Embed;

use crate::state::App;

#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/dist"]
struct Assets;

pub async fn asset(State(app): State<App>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some(response) = file_response(path, &app.settings.base_tag) {
        return response;
    }
    // 带扩展名的缺失文件是构建问题，不要回退成首页。
    if path.contains('.') {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap();
    }
    file_response("index.html", &app.settings.base_tag).unwrap_or_else(|| {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap()
    })
}

fn file_response(path: &str, base_tag: &str) -> Option<Response> {
    let file = Assets::get(path)?;
    let body = if path == "index.html" {
        Body::from(inject_base(&file.data, base_tag))
    } else {
        Body::from(file.data.into_owned())
    };
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
            .body(body)
            .unwrap(),
    )
}

fn inject_base(bytes: &[u8], base_tag: &str) -> Vec<u8> {
    let Ok(html) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    const MARK: &str = "<!--garage-ui-base-->";
    if let Some(index) = html.find(MARK) {
        let mut out = String::with_capacity(html.len() + base_tag.len());
        out.push_str(&html[..index]);
        out.push_str(base_tag);
        out.push_str(&html[index + MARK.len()..]);
        return out.into_bytes();
    }
    let Some(index) = html.find("<head>") else {
        return bytes.to_vec();
    };
    let at = index + "<head>".len();
    let mut out = String::with_capacity(html.len() + base_tag.len());
    out.push_str(&html[..at]);
    out.push_str(base_tag);
    out.push_str(&html[at..]);
    out.into_bytes()
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

    #[test]
    fn index_is_not_cached_and_a_hashed_asset_is_immutable() {
        let index = file_response("index.html", "<base href=\"/\">").expect("index.html");
        assert_eq!(cache_control(&index), Some("no-cache"));

        let hashed = Assets::iter()
            .find(|path| {
                let name = path.rsplit('/').next().unwrap_or(path.as_ref());
                path.starts_with("assets/")
                    && name.contains('-')
                    && (name.ends_with(".js") || name.ends_with(".css"))
            })
            .expect("hashed js or css under assets/");
        let asset = file_response(hashed.as_ref(), "<base href=\"/\">").expect("hashed asset");
        assert_eq!(
            cache_control(&asset),
            Some("public, max-age=31536000, immutable"),
            "{hashed}"
        );
    }

    fn cache_control(response: &Response) -> Option<&str> {
        response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok())
    }
}
