#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GarageMetrics {
    pub(crate) s3_requests: u64,
    pub(crate) s3_errors: u64,
    pub(crate) block_read_bytes: u64,
    pub(crate) block_write_bytes: u64,
}

pub(crate) fn parse_garage_metrics(text: &str) -> GarageMetrics {
    let mut metrics = GarageMetrics {
        s3_requests: 0,
        s3_errors: 0,
        block_read_bytes: 0,
        block_write_bytes: 0,
    };
    for line in text.lines() {
        let Some((family, value)) = sample(line) else {
            continue;
        };
        if family.ends_with("_bucket") || family.ends_with("_sum") || family.ends_with("_count") {
            continue;
        }
        let Some(count) = whole_count(value) else {
            continue;
        };
        match family {
            "api_s3_request_counter" => metrics.s3_requests += count,
            "api_s3_error_counter" => metrics.s3_errors += count,
            "block_bytes_written" => metrics.block_write_bytes += count,
            _ => {}
        }
    }
    metrics
}

fn sample(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let brace = line.find('{');
    let space = line.find(char::is_whitespace);
    let family_end = match (brace, space) {
        (Some(brace), Some(space)) => brace.min(space),
        (Some(brace), None) => brace,
        (None, Some(space)) => space,
        (None, None) => return None,
    };
    let family = &line[..family_end];
    if family.is_empty() {
        return None;
    }
    let rest = if line.as_bytes().get(family_end) == Some(&b'{') {
        let close = line[family_end..].find('}')?;
        &line[family_end + close + 1..]
    } else {
        &line[family_end..]
    };
    let value = rest.split_whitespace().next()?;
    Some((family, value))
}

fn whole_count(token: &str) -> Option<u64> {
    let value = token.parse::<f64>().ok()?;
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value >= u64::MAX as f64 {
        return None;
    }
    Some(value as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_prometheus_text_parses_as_zero() {
        for text in ["", "# HELP api_s3_request_counter x\n"] {
            assert_eq!(parse_garage_metrics(text), zeros());
        }

        let metrics = parse_garage_metrics(
            "\
api_s3_error_counter{api_endpoint=\"ListBuckets\",status_code=\"403\"} 1
api_s3_error_counter{api_endpoint=\"ListObjectsV2\",status_code=\"403\"} 16
api_s3_request_counter{api_endpoint=\"GetObject\"} 15
api_s3_request_counter{api_endpoint=\"PutObject\"} 14
api_s3_request_duration_count 99
block_bytes_written 81
block_bytes_read 5
",
        );
        assert_eq!(metrics.s3_requests, 29);
        assert_eq!(metrics.s3_errors, 17);
        assert_eq!(metrics.block_read_bytes, 0);
        assert_eq!(metrics.block_write_bytes, 81);
    }

    fn zeros() -> GarageMetrics {
        GarageMetrics {
            s3_requests: 0,
            s3_errors: 0,
            block_read_bytes: 0,
            block_write_bytes: 0,
        }
    }
}
