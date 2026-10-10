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
    let hashed = tokio::task::spawn_blocking(move || hash(&password, cost))
        .await
        .map_err(|_| ())?;
    hashed.map_err(|_| ())
}

pub async fn verify_async(password: String, hashed: String) -> bool {
    tokio::task::spawn_blocking(move || verify(&password, &hashed))
        .await
        .unwrap_or(false)
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
}
