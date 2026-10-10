mod access;
mod api;
mod assets;
mod bind;
mod config;
mod db;
mod error;
mod health;
mod http;
mod limit;
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
pub use http::{router, shutdown_wait};
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
