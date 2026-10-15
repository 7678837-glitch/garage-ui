use std::sync::LazyLock;

use tokio::sync::Semaphore;

pub const PRODUCTION_BCRYPT_COST: u32 = 12;

pub fn validate(password: &str) -> Result<(), &'static str> {
    if password.chars().all(char::is_whitespace)
        || password.chars().count() < 10
        || password.len() > 72
    {
        return Err("password_invalid");
    }
    Ok(())
}

pub fn hash(password: &str, cost: u32) -> Result<String, bcrypt::BcryptError> {
    bcrypt::hash(password, cost)
}

pub fn verify(password: &str, hashed: &str) -> bool {
    bcrypt::verify(password, hashed).unwrap_or(false)
}

pub async fn hash_async(password: String, cost: u32) -> Result<String, ()> {
    let hashed = blocking(move || hash(&password, cost)).await?;
    hashed.map_err(|_| ())
}

pub async fn verify_async(password: String, hashed: String) -> bool {
    blocking(move || verify(&password, &hashed))
        .await
        .unwrap_or(false)
}

// bcrypt is CPU-bound; without a bound, unauthenticated login requests could
// occupy the whole blocking pool.
static BCRYPT_SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(slot_count()));

fn slot_count() -> usize {
    std::thread::available_parallelism().map_or(1, usize::from)
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, ()> {
    blocking_in(&BCRYPT_SLOTS, work).await
}

async fn blocking_in<T: Send + 'static>(
    slots: &Semaphore,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ()> {
    let _slot = slots.acquire().await.map_err(|_| ())?;
    tokio::task::spawn_blocking(work).await.map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_cost_is_twelve() {
        assert_eq!(PRODUCTION_BCRYPT_COST, 12);
    }

    #[test]
    fn rejects_short_long_and_blank_passwords() {
        assert!(validate("123456789").is_err());
        assert!(validate("          ").is_err());
        assert!(validate(&"a".repeat(73)).is_err());
        assert!(validate("correct horse").is_ok());
    }

    #[tokio::test]
    async fn concurrent_bcrypt_work_never_exceeds_the_cpu_count() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        static RUNNING: AtomicUsize = AtomicUsize::new(0);
        static HIGH: AtomicUsize = AtomicUsize::new(0);
        // A private semaphore of the production size keeps the shared one free for
        // the time-sensitive rate-limit tests running in parallel.
        let limit = slot_count();
        let slots = Arc::new(Semaphore::new(limit));
        let mut calls = Vec::new();
        for _ in 0..limit * 4 + 4 {
            let slots = Arc::clone(&slots);
            calls.push(tokio::spawn(async move {
                blocking_in(&slots, || {
                    let now = RUNNING.fetch_add(1, Ordering::SeqCst) + 1;
                    HIGH.fetch_max(now, Ordering::SeqCst);
                    // Hold the slot so concurrent callers overlap.
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    RUNNING.fetch_sub(1, Ordering::SeqCst);
                })
                .await
            }));
        }
        for call in calls {
            call.await.unwrap().unwrap();
        }
        let high = HIGH.load(Ordering::SeqCst);
        assert!(high <= limit, "high water {high} exceeds {limit}");
    }
}
