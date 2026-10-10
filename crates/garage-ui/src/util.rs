use std::io::Read;

pub fn random_bytes(len: usize) -> anyhow::Result<Vec<u8>> {
    let mut file =
        std::fs::File::open("/dev/urandom").map_err(|_| anyhow::anyhow!("读取系统随机源失败"))?;
    let mut buf = vec![0_u8; len];
    file.read_exact(&mut buf)
        .map_err(|_| anyhow::anyhow!("读取系统随机源失败"))?;
    Ok(buf)
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

/// 长度不同也把两侧都走完，避免用返回时机区分 token。
pub fn ct_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut diff = left.len() ^ right.len();
    let n = left.len().max(right.len());
    for index in 0..n {
        let a = *left.get(index).unwrap_or(&0);
        let b = *right.get(index).unwrap_or(&0);
        diff |= (a ^ b) as usize;
    }
    diff == 0
}

#[cfg(test)]
pub fn temp_dir() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "garage-ui-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).expect("temp dir");
    path
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

// 对象路由还没按段解码。下载头已经走 content_disposition_attachment。
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ObjectKeyError;

#[allow(dead_code)]
pub fn encode_object_key(key: &str) -> String {
    key.split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

#[allow(dead_code)]
pub fn decode_object_key(encoded: &str) -> Result<Vec<u8>, ObjectKeyError> {
    let mut out = Vec::new();
    for (index, segment) in encoded.split('/').enumerate() {
        if index > 0 {
            out.push(b'/');
        }
        decode_segment(segment, &mut out)?;
    }
    Ok(out)
}

#[allow(dead_code)]
pub fn folder_name_allowed(name: &str) -> bool {
    !name
        .chars()
        .any(|character| character == '/' || character.is_control())
}

pub fn content_disposition_attachment(filename: &str) -> String {
    let name = if filename.is_empty() {
        "object"
    } else {
        filename
    };
    format!("attachment; filename*=UTF-8''{}", rfc5987(name))
}

fn encode_segment(segment: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::new();
    for byte in segment.bytes() {
        if is_unreserved(byte) {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xf) as usize] as char);
        }
    }
    out
}

fn decode_segment(segment: &str, out: &mut Vec<u8>) -> Result<(), ObjectKeyError> {
    let bytes = segment.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(ObjectKeyError);
            }
            let hi = hex_value(bytes[index + 1])?;
            let lo = hex_value(bytes[index + 2])?;
            out.push((hi << 4) | lo);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    Ok(())
}

fn hex_value(byte: u8) -> Result<u8, ObjectKeyError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(ObjectKeyError),
    }
}

fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

fn rfc5987(name: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::new();
    for byte in name.bytes() {
        if is_rfc5987_attr(byte) {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xf) as usize] as char);
        }
    }
    out
}

fn is_rfc5987_attr(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'
        )
}

// 路由还没调用这些纯函数。这一阶段只在这里把 4.1、4.3、4.4 定下来。
#[allow(dead_code)]
pub mod bucket {
    use std::collections::HashSet;

    const PAGE_LIMIT: usize = 1000;

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct BucketRef {
        id: String,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum BucketAddressError {
        EmptyId,
        AliasIsNotAddress,
    }

    impl BucketRef {
        pub fn from_id(id: &str) -> Result<Self, BucketAddressError> {
            if id.is_empty() {
                return Err(BucketAddressError::EmptyId);
            }
            Ok(Self { id: id.to_string() })
        }

        /// 别名只用于展示，不能变成桶地址。字符里有没有 `&` 或 `=` 都一样。
        pub fn from_alias(_alias: &str) -> Result<Self, BucketAddressError> {
            Err(BucketAddressError::AliasIsNotAddress)
        }

        pub fn id(&self) -> &str {
            &self.id
        }
    }

    pub fn bucket_ref(id: &str, alias: Option<&str>) -> Result<BucketRef, BucketAddressError> {
        // 别名只参与展示。操作地址始终是桶 id。
        let _ = alias;
        BucketRef::from_id(id)
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct KeyError {
        key: String,
        message: String,
    }

    impl KeyError {
        pub fn new(key: impl Into<String>, message: impl Into<String>) -> Self {
            Self {
                key: key.into(),
                message: message.into(),
            }
        }

        pub fn key(&self) -> &str {
            &self.key
        }

        pub fn message(&self) -> &str {
            &self.message
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum DeleteStatus {
        AllSucceeded,
        PartialFailure,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct DeleteOutcome {
        deleted: u64,
        errors: Vec<KeyError>,
    }

    impl DeleteOutcome {
        pub fn deleted(&self) -> u64 {
            self.deleted
        }

        pub fn errors(&self) -> &[KeyError] {
            &self.errors
        }

        pub fn status(&self) -> DeleteStatus {
            if self.errors.is_empty() {
                DeleteStatus::AllSucceeded
            } else {
                DeleteStatus::PartialFailure
            }
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct PageTooLong {
        pub len: usize,
    }

    pub fn delete_prefix<L, D>(
        prefix: &str,
        mut list_page: L,
        mut delete_batch: D,
    ) -> Result<DeleteOutcome, PageTooLong>
    where
        L: FnMut(&str) -> Vec<String>,
        D: FnMut(&[String]) -> Vec<KeyError>,
    {
        let mut deleted = 0u64;
        let mut errors = Vec::new();
        loop {
            let keys = list_page(prefix);
            if keys.len() > PAGE_LIMIT {
                return Err(PageTooLong { len: keys.len() });
            }
            let short = keys.len() < PAGE_LIMIT;
            if !keys.is_empty() {
                let batch_errors = delete_batch(&keys);
                let failed_keys: HashSet<&str> =
                    batch_errors.iter().map(|err| err.key.as_str()).collect();
                let failed = keys
                    .iter()
                    .filter(|key| failed_keys.contains(key.as_str()))
                    .count() as u64;
                deleted += keys.len() as u64 - failed;
                errors.extend(batch_errors);
            }
            if short {
                break;
            }
        }
        Ok(DeleteOutcome { deleted, errors })
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct InvalidCapacity;

    /// 布局里的容量原文字节串。不解析成浮点，也不按显示单位换算。
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct Capacity {
        original: String,
    }

    impl Capacity {
        pub fn from_byte_string(original: &str) -> Result<Self, InvalidCapacity> {
            if !is_byte_integer(original) {
                return Err(InvalidCapacity);
            }
            Ok(Self {
                original: original.to_string(),
            })
        }

        pub fn as_str(&self) -> &str {
            &self.original
        }

        /// `edited` 为 None 表示表单没改容量。这时交回原字节串，不能按显示单位重算。
        pub fn submit(&self, edited: Option<&str>) -> Result<String, InvalidCapacity> {
            match edited {
                Some(value) if value != self.original => {
                    if !is_byte_integer(value) {
                        return Err(InvalidCapacity);
                    }
                    Ok(value.to_string())
                }
                _ => Ok(self.original.clone()),
            }
        }
    }

    fn is_byte_integer(value: &str) -> bool {
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn alias_with_ampersand_or_equals_still_addresses_by_id() {
            let id = "e6a14cc193f7a6a1b0c0d0e0f0112233";
            let alias = "photos&size=large";
            let reference = bucket_ref(id, Some(alias)).unwrap();
            assert_eq!(reference.id(), id);
            assert_eq!(
                BucketRef::from_alias(alias),
                Err(BucketAddressError::AliasIsNotAddress)
            );
            assert_eq!(
                BucketRef::from_alias(id),
                Err(BucketAddressError::AliasIsNotAddress)
            );
            assert_eq!(BucketRef::from_id(""), Err(BucketAddressError::EmptyId));
        }

        #[test]
        fn delete_prefix_lists_three_pages_and_deletes_2500() {
            let keys = numbered_keys(2500);
            let mut cursor = 0;
            let mut lists = 0;
            let mut batches = Vec::new();
            let mut seen_prefix = String::new();
            let outcome = delete_prefix(
                "docs/",
                |prefix| {
                    lists += 1;
                    seen_prefix = prefix.to_string();
                    let page = next_page(&keys, &mut cursor);
                    if !page.is_empty() {
                        batches.push(page.len());
                    }
                    page
                },
                |_| Vec::new(),
            )
            .unwrap();
            assert_eq!(lists, 3);
            assert_eq!(seen_prefix, "docs/");
            assert_eq!(batches, vec![1000, 1000, 500]);
            assert_eq!(outcome.deleted(), 2500);
            assert!(outcome.errors().is_empty());
            assert_eq!(outcome.status(), DeleteStatus::AllSucceeded);
        }

        #[test]
        fn delete_prefix_reports_three_failures_without_all_success() {
            let keys = numbered_keys(2500);
            let bad = ["k0000", "k1000", "k2499"];
            let mut cursor = 0;
            let mut lists = 0;
            let outcome = delete_prefix(
                "docs/",
                |_| {
                    lists += 1;
                    next_page(&keys, &mut cursor)
                },
                |page| {
                    page.iter()
                        .filter(|key| bad.contains(&key.as_str()))
                        .map(|key| KeyError::new(key.clone(), "injected"))
                        .collect()
                },
            )
            .unwrap();
            assert_eq!(lists, 3);
            assert_eq!(outcome.deleted(), 2497);
            assert_eq!(
                outcome
                    .errors()
                    .iter()
                    .map(|err| err.key())
                    .collect::<Vec<_>>(),
                vec!["k0000", "k1000", "k2499"]
            );
            assert_eq!(outcome.errors()[0].message(), "injected");
            assert_eq!(outcome.status(), DeleteStatus::PartialFailure);
        }

        #[test]
        fn delete_prefix_lists_past_a_full_page() {
            let keys = numbered_keys(2000);
            let mut cursor = 0;
            let mut lists = 0;
            let mut batches = Vec::new();
            let outcome = delete_prefix(
                "docs/",
                |_| {
                    lists += 1;
                    let page = next_page(&keys, &mut cursor);
                    if !page.is_empty() {
                        batches.push(page.len());
                    }
                    page
                },
                |_| Vec::new(),
            )
            .unwrap();
            assert_eq!(lists, 3);
            assert_eq!(batches, vec![1000, 1000]);
            assert_eq!(outcome.deleted(), 2000);
            assert_eq!(outcome.status(), DeleteStatus::AllSucceeded);
        }

        #[test]
        fn delete_prefix_rejects_a_page_over_1000() {
            let mut lists = 0;
            let mut deletes = 0;
            let result = delete_prefix(
                "docs/",
                |_| {
                    lists += 1;
                    if lists == 1 {
                        vec!["k".to_string(); 1001]
                    } else {
                        Vec::new()
                    }
                },
                |_| {
                    deletes += 1;
                    Vec::new()
                },
            );
            assert_eq!(result, Err(PageTooLong { len: 1001 }));
            assert_eq!(lists, 1);
            assert_eq!(deletes, 0);
        }

        #[test]
        fn unchanged_one_point_eight_tb_keeps_original_byte_string() {
            let original = "1800000000000";
            let capacity = Capacity::from_byte_string(original).unwrap();
            let submitted = capacity.submit(None).unwrap();
            assert_eq!(submitted.as_bytes(), original.as_bytes());
            assert_eq!(
                capacity.submit(Some(original)).unwrap().as_bytes(),
                original.as_bytes()
            );
            assert_eq!(capacity.as_str().as_bytes(), original.as_bytes());
            assert_eq!(Capacity::from_byte_string("1.8"), Err(InvalidCapacity));
            assert_eq!(capacity.submit(Some("1.8")), Err(InvalidCapacity));
        }

        #[test]
        fn changed_capacity_keeps_the_new_digit_string() {
            let capacity = Capacity::from_byte_string("1800000000000").unwrap();
            let submitted = capacity.submit(Some("1900000000000")).unwrap();
            assert_eq!(submitted.as_bytes(), b"1900000000000");
        }

        #[test]
        fn original_digit_string_is_not_reformatted() {
            // 2^53+1 和前导零一旦解析成数值再格式化，字节就会变。
            let original = "9007199254740993";
            let capacity = Capacity::from_byte_string(original).unwrap();
            assert_eq!(
                capacity.submit(None).unwrap().as_bytes(),
                original.as_bytes()
            );
            let padded = "01800000000000";
            let padded_capacity = Capacity::from_byte_string(padded).unwrap();
            assert_eq!(
                padded_capacity.submit(None).unwrap().as_bytes(),
                padded.as_bytes()
            );
        }

        fn numbered_keys(count: usize) -> Vec<String> {
            (0..count).map(|index| format!("k{index:04}")).collect()
        }

        fn next_page(keys: &[String], cursor: &mut usize) -> Vec<String> {
            let end = (*cursor + 1000).min(keys.len());
            let page = keys[*cursor..end].to_vec();
            *cursor = end;
            page
        }
    }
}

#[cfg(test)]
mod object_key_tests {
    use super::{
        content_disposition_attachment, decode_object_key, encode_object_key, folder_name_allowed,
    };

    #[test]
    fn path_segments_round_trip_the_spec_keys() {
        for key in ["a?b#c%20d=e", "报告.txt", "dir/报告.txt", "dir/a?b#c%20d=e"] {
            let encoded = encode_object_key(key);
            assert_eq!(decode_object_key(&encoded).unwrap(), key.as_bytes());
        }
        assert_eq!(encode_object_key("a?b#c%20d=e"), "a%3Fb%23c%2520d%3De");
        assert_eq!(
            decode_object_key("a%3Fb%23c%2520d%3De").unwrap(),
            b"a?b#c%20d=e"
        );
        assert_eq!(encode_object_key("报告.txt"), "%E6%8A%A5%E5%91%8A.txt");
        assert_eq!(
            decode_object_key("%E6%8A%A5%E5%91%8A.txt").unwrap(),
            "报告.txt".as_bytes()
        );
        assert_eq!(
            encode_object_key("dir/a?b#c%20d=e"),
            "dir/a%3Fb%23c%2520d%3De"
        );
        assert!(decode_object_key("%").is_err());
        assert!(decode_object_key("%2").is_err());
        assert!(decode_object_key("%GG").is_err());
    }

    #[test]
    fn folder_names_reject_controls_and_slashes_only() {
        for name in ["a?b#c%20d=e", "报告.txt", "a b", "=#?% "] {
            assert!(folder_name_allowed(name), "{name}");
        }
        assert!(!folder_name_allowed("a/b"));
        assert!(!folder_name_allowed("a\nb"));
        assert!(!folder_name_allowed("a\u{0000}b"));
        assert!(!folder_name_allowed("a\u{007f}b"));
        assert!(!folder_name_allowed("a\u{009f}b"));
    }

    #[test]
    fn download_names_use_rfc5987() {
        assert_eq!(
            content_disposition_attachment("a?b#c%20d=e"),
            "attachment; filename*=UTF-8''a%3Fb#c%2520d%3De"
        );
        assert_eq!(
            content_disposition_attachment("报告.txt"),
            "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt"
        );
        assert!(content_disposition_attachment("报告.txt").is_ascii());
    }
}
