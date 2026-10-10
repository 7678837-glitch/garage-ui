use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use anyhow::Context;

use crate::PORT;

/// `HOST` 为空或未设置时监听回环地址。容器镜像用 `ENV HOST=0.0.0.0` 给出镜像内默认值。
pub fn listen_addr(host: Option<&str>) -> anyhow::Result<SocketAddr> {
    let ip = match host.map(str::trim).filter(|value| !value.is_empty()) {
        None => IpAddr::V4(Ipv4Addr::LOCALHOST),
        Some(value) => value
            .parse()
            .with_context(|| format!("HOST 无法解析为 IP 地址: {value}"))?,
    };
    Ok(SocketAddr::new(ip, PORT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_host_binds_loopback() {
        let addr = listen_addr(None).unwrap();
        assert_eq!(addr, SocketAddr::from(([127, 0, 0, 1], PORT)));
        assert_eq!(listen_addr(Some("")).unwrap(), addr);
        assert_eq!(listen_addr(Some("  ")).unwrap(), addr);
    }

    #[test]
    fn explicit_host_is_used() {
        let addr = listen_addr(Some("0.0.0.0")).unwrap();
        assert_eq!(addr.ip(), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert_eq!(addr.port(), PORT);
    }

    #[test]
    fn rejects_unparsed_host() {
        let error = listen_addr(Some("everywhere")).unwrap_err();
        assert!(error.to_string().contains("everywhere"));
    }
}
