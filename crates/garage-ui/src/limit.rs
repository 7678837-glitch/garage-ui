use std::future::Future;
use std::num::{NonZeroU32, NonZeroUsize};
use std::sync::Arc;
use std::time::Duration;

use governor::clock::{Clock, DefaultClock};
use governor::state::keyed::DefaultKeyedStateStore;
use governor::{Quota, RateLimiter};
use tokio::sync::Semaphore;

type Limiter = RateLimiter<String, DefaultKeyedStateStore<String>, DefaultClock>;

pub struct Limits {
    login: Limiter,
    init: Limiter,
    password: Limiter,
    share: Limiter,
    clock: DefaultClock,
}

impl Limits {
    pub fn new(quota: Quota) -> Self {
        Self {
            login: RateLimiter::keyed(quota),
            init: RateLimiter::keyed(quota),
            password: RateLimiter::keyed(quota),
            share: RateLimiter::keyed(quota),
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

    pub fn share(&self, username: &str) -> Result<(), Duration> {
        self.hit(&self.share, &username.to_lowercase())
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

pub const DEFAULT_FANOUT_IN_FLIGHT: NonZeroUsize = NonZeroUsize::new(8).expect("8");

pub async fn fan_out<T, R, F, Fut>(limit: NonZeroUsize, items: Vec<T>, f: F) -> Vec<R>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = R> + Send + 'static,
{
    let permits = Arc::new(Semaphore::new(limit.get()));
    let f = Arc::new(f);
    let mut joins = Vec::with_capacity(items.len());
    for item in items {
        let permits = Arc::clone(&permits);
        let f = Arc::clone(&f);
        joins.push(tokio::spawn(async move {
            let _permit = permits
                .acquire_owned()
                .await
                .expect("fan-out semaphore stays open");
            f(item).await
        }));
    }
    let mut out = Vec::with_capacity(joins.len());
    for join in joins {
        out.push(join.await.expect("fan-out task"));
    }
    out
}

#[cfg(test)]
pub fn test_quota() -> Quota {
    Quota::with_period(Duration::from_millis(200))
        .expect("period")
        .allow_burst(NonZeroU32::new(10).expect("10"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Instant;

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

    #[tokio::test]
    async fn one_thousand_calls_stay_at_or_under_eight() {
        let (high, got) = wave(DEFAULT_FANOUT_IN_FLIGHT, 1000).await;
        assert!(high <= 8, "high water {high}");
        assert_eq!(got, (0..1000).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn limit_two_stays_at_or_under_two() {
        let limit = NonZeroUsize::new(2).expect("2");
        let (high, got) = wave(limit, 1000).await;
        assert!(high <= 2, "high water {high}");
        assert_eq!(got, (0..1000).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn limit_one_runs_calls_one_at_a_time() {
        let limit = NonZeroUsize::new(1).expect("1");
        let (high, got) = wave(limit, 1000).await;
        assert_eq!(high, 1);
        assert_eq!(got, (0..1000).collect::<Vec<_>>());
    }

    async fn wave(limit: NonZeroUsize, count: usize) -> (usize, Vec<usize>) {
        let inflight = Arc::new(AtomicUsize::new(0));
        let high = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(AtomicBool::new(false));
        let inflight_task = Arc::clone(&inflight);
        let high_task = Arc::clone(&high);
        let release_task = Arc::clone(&release);
        let driver = tokio::spawn(async move {
            fan_out(limit, (0..count).collect::<Vec<usize>>(), move |item| {
                let inflight = Arc::clone(&inflight_task);
                let high = Arc::clone(&high_task);
                let release = Arc::clone(&release_task);
                async move {
                    let now = inflight.fetch_add(1, Ordering::SeqCst) + 1;
                    high.fetch_max(now, Ordering::SeqCst);
                    while !release.load(Ordering::SeqCst) {
                        tokio::task::yield_now().await;
                    }
                    inflight.fetch_sub(1, Ordering::SeqCst);
                    let skew = limit.get() - 1 - (item % limit.get());
                    for _ in 0..skew {
                        tokio::task::yield_now().await;
                    }
                    item
                }
            })
            .await
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let now = inflight.load(Ordering::SeqCst);
            assert!(
                now <= limit.get(),
                "in flight {now} exceeds {}",
                limit.get()
            );
            if now == limit.get() {
                tokio::task::yield_now().await;
                let again = inflight.load(Ordering::SeqCst);
                assert!(
                    again <= limit.get(),
                    "in flight {again} exceeds {}",
                    limit.get()
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "in flight stayed at {now}, limit {}",
                limit.get()
            );
            tokio::task::yield_now().await;
        }
        release.store(true, Ordering::SeqCst);
        let got = driver.await.expect("driver");
        (high.load(Ordering::SeqCst), got)
    }
}
