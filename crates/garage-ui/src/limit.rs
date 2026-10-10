use std::num::NonZeroU32;
use std::time::Duration;

use governor::clock::{Clock, DefaultClock};
use governor::state::keyed::DefaultKeyedStateStore;
use governor::{Quota, RateLimiter};

type Limiter = RateLimiter<String, DefaultKeyedStateStore<String>, DefaultClock>;

pub struct Limits {
    login: Limiter,
    init: Limiter,
    password: Limiter,
    clock: DefaultClock,
}

impl Limits {
    pub fn new(quota: Quota) -> Self {
        Self {
            login: RateLimiter::keyed(quota),
            init: RateLimiter::keyed(quota),
            password: RateLimiter::keyed(quota),
            clock: DefaultClock::default(),
        }
    }

    pub fn login(&self, ip: &str, username: &str) -> Result<(), Duration> {
        let key = format!("{ip}\n{}", username.to_lowercase());
        self.hit(&self.login, &key)
    }

    pub fn init(&self, ip: &str) -> Result<(), Duration> {
        self.hit(&self.init, ip)
    }

    pub fn password(&self, username: &str) -> Result<(), Duration> {
        self.hit(&self.password, &username.to_lowercase())
    }

    fn hit(&self, limiter: &Limiter, key: &str) -> Result<(), Duration> {
        match limiter.check_key(&key.to_string()) {
            Ok(_) => Ok(()),
            Err(not_until) => Err(not_until.wait_time_from(self.clock.now())),
        }
    }
}

pub fn production_quota() -> Quota {
    Quota::per_minute(NonZeroU32::new(10).expect("10"))
}

#[cfg(test)]
pub fn test_quota() -> Quota {
    Quota::with_period(Duration::from_millis(200))
        .expect("period")
        .allow_burst(NonZeroU32::new(10).expect("10"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_quota_allows_ten_then_blocks() {
        let limits = Limits::new(production_quota());
        for _ in 0..10 {
            assert!(limits.login("127.0.0.1", "Ada").is_ok());
        }
        assert!(limits.login("127.0.0.1", "ada").is_err());
        assert!(limits.login("127.0.0.1", "other").is_ok());
    }
}
