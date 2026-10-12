mod access;
mod api;
mod assets;
mod bind;
pub mod cli;
mod config;
mod db;
mod error;
mod health;
mod http;
mod limit;
mod objects;
mod password;
mod preview;
mod proxy;
mod redact;
mod session;
mod state;
mod util;

#[cfg(test)]
mod accept;

pub use bind::listen_addr;
pub use health::probe;
pub use http::{router, serve_http, shutdown_wait};
pub use state::boot;

pub const PORT: u16 = 3909;

pub fn version() -> &'static str {
    env!("GARAGE_UI_VERSION")
}

pub fn commit() -> &'static str {
    env!("GARAGE_UI_COMMIT")
}

pub fn build_time() -> &'static str {
    env!("GARAGE_UI_BUILD_TIME")
}

#[cfg(test)]
#[test]
fn server_timeouts_follow_the_env() {
    let _guard = timeout_env_guard();
    let server = http::Server::from_env();
    assert_eq!(
        server.header_read_timeout,
        std::time::Duration::from_secs(10)
    );
    assert_eq!(server.idle_timeout, std::time::Duration::from_secs(60));
    let rendered = format!("{:?}", server.builder);
    assert!(
        rendered.contains("h1_header_read_timeout: Configured(Some(10s))"),
        "{rendered}"
    );
    assert!(!rendered.contains("request_timeout"), "{rendered}");

    set_timeout_env("15", "90");
    let server = http::Server::from_env();
    assert_eq!(
        server.header_read_timeout,
        std::time::Duration::from_secs(15)
    );
    assert_eq!(server.idle_timeout, std::time::Duration::from_secs(90));
    let rendered = format!("{:?}", server.builder);
    assert!(
        rendered.contains("h1_header_read_timeout: Configured(Some(15s))"),
        "{rendered}"
    );
    assert!(!rendered.contains("request_timeout"), "{rendered}");
}

#[cfg(test)]
fn timeout_env_guard() -> TimeoutEnvGuard {
    let guard = TimeoutEnvGuard {
        header: std::env::var("GARAGE_HEADER_READ_TIMEOUT_SECS").ok(),
        idle: std::env::var("GARAGE_IDLE_TIMEOUT_SECS").ok(),
    };
    // SAFETY: this test owns the process env for these two names and restores them on drop.
    // `cargo test --exact` runs this test alone.
    unsafe {
        std::env::remove_var("GARAGE_HEADER_READ_TIMEOUT_SECS");
        std::env::remove_var("GARAGE_IDLE_TIMEOUT_SECS");
    }
    guard
}

#[cfg(test)]
fn set_timeout_env(header_secs: &str, idle_secs: &str) {
    // SAFETY: same as `timeout_env_guard`. The guard restores both names.
    unsafe {
        std::env::set_var("GARAGE_HEADER_READ_TIMEOUT_SECS", header_secs);
        std::env::set_var("GARAGE_IDLE_TIMEOUT_SECS", idle_secs);
    }
}

#[cfg(test)]
struct TimeoutEnvGuard {
    header: Option<String>,
    idle: Option<String>,
}

#[cfg(test)]
impl Drop for TimeoutEnvGuard {
    fn drop(&mut self) {
        restore_timeout_env("GARAGE_HEADER_READ_TIMEOUT_SECS", self.header.as_deref());
        restore_timeout_env("GARAGE_IDLE_TIMEOUT_SECS", self.idle.as_deref());
    }
}

#[cfg(test)]
fn restore_timeout_env(name: &str, value: Option<&str>) {
    // SAFETY: restores the values captured before this test mutated the process env.
    unsafe {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
}
