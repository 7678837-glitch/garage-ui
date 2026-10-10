use std::net::SocketAddr;

use anyhow::Context;
use clap::Parser;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing_subscriber::EnvFilter;

use garage_ui::{PORT, boot, listen_addr, probe, router, shutdown_wait};

#[derive(Parser)]
#[command(name = "garage-ui", version = garage_ui::version())]
struct Cli {
    /// 检查本机 127.0.0.1:3909 的 /healthz，成功时退出码为 0。
    #[arg(long = "health")]
    health: bool,
}

fn main() -> anyhow::Result<()> {
    let mut args: Vec<String> = std::env::args().collect();
    // 规格沿用单横线 `-health`，clap 的长参数是 `--health`。
    for arg in &mut args {
        if arg == "-health" {
            *arg = "--health".to_string();
        }
    }
    let cli = Cli::parse_from(args);
    init_tracing();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("启动 tokio 失败")?;
    if cli.health {
        return runtime.block_on(probe(SocketAddr::from(([127, 0, 0, 1], PORT))));
    }
    runtime.block_on(serve())
}

async fn serve() -> anyhow::Result<()> {
    let app = boot().await?;
    let host = std::env::var("HOST").ok();
    let addr = listen_addr(host.as_deref())?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("监听 {addr} 失败"))?;
    tracing::info!(%addr, version = garage_ui::version(), "listening");
    let (tx, rx) = watch::channel(false);
    let signal_task = tokio::spawn(async move {
        wait_for_stop_signal().await;
        let _ = tx.send(true);
    });
    // axum 0.8.9 的 Serve 没有读头或空闲超时接口。整请求超时会截断以后的上传和下载。
    let server = axum::serve(
        listener,
        router(app).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_requested(rx.clone()));
    tokio::select! {
        result = server => {
            result.context("HTTP 服务退出")?;
        }
        _ = shutdown_deadline(rx) => {
            tracing::info!(wait_secs = shutdown_wait().as_secs(), "shutdown wait elapsed");
        }
    }
    signal_task.abort();
    Ok(())
}

async fn shutdown_requested(mut rx: watch::Receiver<bool>) {
    let _ = rx.wait_for(|stop| *stop).await;
    tracing::info!(wait_secs = shutdown_wait().as_secs(), "shutting down");
}

async fn shutdown_deadline(mut rx: watch::Receiver<bool>) {
    let _ = rx.wait_for(|stop| *stop).await;
    tokio::time::sleep(shutdown_wait()).await;
}

async fn wait_for_stop_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "无法监听 SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .with_writer(std::io::stdout)
        .with_current_span(false)
        .with_span_list(false)
        .init();
}
