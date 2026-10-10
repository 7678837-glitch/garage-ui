use std::net::SocketAddr;
use std::time::Duration;

use anyhow::bail;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// 请求本机 `/healthz`。容器里没有 shell，健康检查只能再跑一次这个二进制。
pub async fn probe(addr: SocketAddr) -> anyhow::Result<()> {
    let mut stream = tokio::time::timeout(Duration::from_secs(4), TcpStream::connect(addr))
        .await
        .map_err(|_| anyhow::anyhow!("连接 {addr} 超时"))?
        .with_context_addr(addr)?;
    let request = format!(
        "GET /healthz HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n",
        host = addr.ip()
    );
    stream.write_all(request.as_bytes()).await?;
    let mut buf = vec![0_u8; 256];
    let read = tokio::time::timeout(Duration::from_secs(4), stream.read(&mut buf))
        .await
        .map_err(|_| anyhow::anyhow!("读取 {addr} 的响应超时"))??;
    let text = String::from_utf8_lossy(&buf[..read]);
    let code = status_code(&text).ok_or_else(|| anyhow::anyhow!("无法解析健康检查响应"))?;
    if code != 200 {
        bail!("健康检查返回 {code}");
    }
    Ok(())
}

trait WithAddr<T> {
    fn with_context_addr(self, addr: SocketAddr) -> anyhow::Result<T>;
}

impl<T, E> WithAddr<T> for Result<T, E>
where
    E: std::fmt::Display,
{
    fn with_context_addr(self, addr: SocketAddr) -> anyhow::Result<T> {
        self.map_err(|error| anyhow::anyhow!("连接 {addr} 失败: {error}"))
    }
}

fn status_code(response: &str) -> Option<u16> {
    let rest = response.strip_prefix("HTTP/1.1 ")?;
    rest.get(..3)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router;
    use tokio::net::TcpListener;

    #[test]
    fn parses_status_line() {
        assert_eq!(status_code("HTTP/1.1 200 OK\r\n"), Some(200));
        assert_eq!(status_code("nope"), None);
    }

    #[tokio::test]
    async fn probe_accepts_local_healthz() {
        let dir = crate::util::temp_dir();
        let app = crate::state::test_app(&dir).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(app)).await.unwrap();
        });
        probe(addr).await.unwrap();
        server.abort();
    }
}
