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
