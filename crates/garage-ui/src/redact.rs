pub fn redact(input: &str, secrets: &[String]) -> String {
    let mut out = input.to_string();
    for secret in secrets {
        if secret.len() >= 8 {
            out = out.replace(secret, "[redacted]");
        }
    }
    redact_bcrypt(&out)
}

fn redact_bcrypt(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = earliest_bcrypt(rest) {
        out.push_str(&rest[..index]);
        let take = bcrypt_len(&rest[index..]);
        out.push_str("[redacted]");
        rest = &rest[index + take..];
    }
    out.push_str(rest);
    out
}

fn earliest_bcrypt(input: &str) -> Option<usize> {
    ["$2a$", "$2b$", "$2y$"]
        .into_iter()
        .filter_map(|prefix| input.find(prefix))
        .min()
}

fn bcrypt_len(input: &str) -> usize {
    input
        .bytes()
        .take(60)
        .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'$' | b'.' | b'/'))
        .count()
        .max(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_configured_secrets_and_bcrypt_hashes() {
        let hash = "$2b$12$0123456789abcdef0123456789abcdef0123456789abcdef01234";
        let line = format!("password=correct-horse token=planted-admin-token-9f3a hash={hash}");
        let cleaned = redact(
            &line,
            &[
                "planted-admin-token-9f3a".to_string(),
                "correct-horse".to_string(),
            ],
        );
        assert!(!cleaned.contains("correct-horse"));
        assert!(!cleaned.contains("planted-admin-token-9f3a"));
        assert!(!cleaned.contains("$2b$"));
        assert!(cleaned.contains("[redacted]"));
    }
}
