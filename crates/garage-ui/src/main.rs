use std::net::SocketAddr;

use anyhow::Context;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing_subscriber::EnvFilter;

use garage_ui::cli::{self, Command, UserArgs, UserCommand};
use garage_ui::{PORT, boot, listen_addr, probe, serve_http, shutdown_wait};

fn main() -> anyhow::Result<()> {
    let cli = cli::parse();
    init_tracing();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to start tokio")?;
    // The health check must not open the database. Probe before any subcommand.
    if cli.health {
        return runtime.block_on(probe(SocketAddr::from(([127, 0, 0, 1], PORT))));
    }
    match cli.command {
        None => runtime.block_on(serve()),
        Some(Command::Users) => runtime.block_on(cli::list()),
        Some(Command::User(UserArgs { action })) => match action {
            UserCommand::ResetPassword { username } => runtime.block_on(cli::reset(username)),
            UserCommand::CreateAdmin { username } => runtime.block_on(cli::create(username)),
        },
    }
}

async fn serve() -> anyhow::Result<()> {
    let app = boot().await?;
    let host = std::env::var("HOST").ok();
    let addr = listen_addr(host.as_deref())?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to listen on {addr}"))?;
    tracing::info!(%addr, version = garage_ui::version(), "listening");
    let (tx, rx) = watch::channel(false);
    let signal_task = tokio::spawn(async move {
        wait_for_stop_signal().await;
        let _ = tx.send(true);
    });
    let server = serve_http(listener, app, shutdown_requested(rx.clone()));
    tokio::select! {
        result = server => {
            result.context("HTTP server stopped")?;
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
                tracing::error!(%error, "failed to listen for SIGTERM");
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
