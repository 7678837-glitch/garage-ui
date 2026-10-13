pub struct PreviewPolicy {
    pub content_type: String,
    pub content_disposition: Option<String>,
    pub content_security_policy: &'static str,
}

pub fn preview_policy(content_type: &str, filename: &str) -> PreviewPolicy {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let inline = matches!(
        mime.as_str(),
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/avif"
            | "image/bmp"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
            | "text/plain"
            | "application/pdf"
            | "video/mp4"
            | "video/webm"
            | "audio/mpeg"
            | "audio/ogg"
            | "audio/wav"
    );
    if inline {
        return PreviewPolicy {
            content_type: mime.clone(),
            content_disposition: None,
            content_security_policy: if mime == "application/pdf" {
                "sandbox allow-scripts; frame-ancestors 'self'"
            } else {
                "sandbox; frame-ancestors 'self'"
            },
        };
    }
    let name = if filename.is_empty() {
        "object"
    } else {
        filename
    };
    PreviewPolicy {
        content_type: "application/octet-stream".to_string(),
        content_disposition: Some(format!("attachment; filename*=UTF-8''{}", rfc5987(name))),
        content_security_policy: "sandbox; frame-ancestors 'self'",
    }
}

fn rfc5987(name: &str) -> String {
    let mut out = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_types_are_attachments() {
        for content_type in ["text/html", "text/html; charset=utf-8", "image/svg+xml", ""] {
            let policy = preview_policy(content_type, "page.html");
            assert_eq!(policy.content_type, "application/octet-stream");
            let disposition = policy.content_disposition.unwrap();
            assert!(disposition.starts_with("attachment;"));
            assert!(disposition.contains("filename*=UTF-8''page.html"));
        }
    }

    #[test]
    fn bitmap_and_pdf_stay_inline() {
        let png = preview_policy("image/png; charset=binary", "a.png");
        assert_eq!(png.content_type, "image/png");
        assert!(png.content_disposition.is_none());
        assert_eq!(
            png.content_security_policy,
            "sandbox; frame-ancestors 'self'"
        );
        let pdf = preview_policy("application/pdf", "a.pdf");
        assert_eq!(
            pdf.content_security_policy,
            "sandbox allow-scripts; frame-ancestors 'self'"
        );
        assert!(!pdf.content_security_policy.contains("allow-same-origin"));
    }

    #[test]
    fn xml_and_javascript_are_attachments_and_common_images_stay_inline() {
        for content_type in [
            "text/xml",
            "application/xml",
            "text/javascript",
            "application/javascript",
        ] {
            let policy = preview_policy(content_type, "page.html");
            assert_eq!(policy.content_type, "application/octet-stream");
            let disposition = policy.content_disposition.expect(content_type);
            assert!(
                disposition.starts_with("attachment;"),
                "{content_type} {disposition}"
            );
            assert!(
                disposition.contains("filename*=UTF-8''page.html"),
                "{content_type} {disposition}"
            );
        }
        for content_type in ["image/jpeg", "image/gif", "image/webp"] {
            let policy = preview_policy(content_type, "photo.bin");
            assert_eq!(policy.content_type, content_type);
            assert!(policy.content_disposition.is_none(), "{content_type}");
        }
    }
}
