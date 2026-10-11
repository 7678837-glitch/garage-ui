use std::io::BufRead;

use clap::{Args, Parser, Subcommand};
use sqlx::SqlitePool;
use sqlx::error::DatabaseError;

#[derive(Debug, Parser)]
#[command(name = "garage-ui", version = crate::version())]
pub struct Cli {
    /// 检查本机 127.0.0.1:3909 的 /healthz，成功时退出码为 0。
    #[arg(long = "health")]
    pub health: bool,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// List local users.
    Users,
    /// Create an admin or replace a password.
    User(UserArgs),
}

#[derive(Debug, Args)]
pub struct UserArgs {
    #[command(subcommand)]
    pub action: UserCommand,
}

#[derive(Debug, Subcommand)]
pub enum UserCommand {
    /// Replace a password read from stdin.
    ResetPassword { username: String },
    /// Create an admin whose password is read from stdin.
    CreateAdmin { username: String },
}

pub fn parse() -> Cli {
    Cli::parse_from(normalize_args(std::env::args()))
}

fn normalize_args(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter()
        .map(|arg| {
            if arg == "-health" {
                "--health".to_string()
            } else {
                arg
            }
        })
        .collect()
}

pub async fn list() -> anyhow::Result<()> {
    let (pool, _) = open_db().await?;
    let text = format_users(&pool).await?;
    print!("{text}");
    Ok(())
}

pub async fn reset(username: String) -> anyhow::Result<()> {
    let (pool, cost) = open_db().await?;
    let password = read_password()?;
    reset_password(&pool, &username, &password, cost).await
}

pub async fn create(username: String) -> anyhow::Result<()> {
    let (pool, cost) = open_db().await?;
    let password = read_password()?;
    create_admin(&pool, &username, &password, cost).await
}

async fn open_db() -> anyhow::Result<(SqlitePool, u32)> {
    let loaded = crate::config::load_process()?;
    let dir = loaded.settings.data_dir;
    // sqlite 不会创建父目录。这里只建目录，不走 boot，也不听端口。
    std::fs::create_dir_all(&dir)
        .map_err(|_| anyhow::anyhow!("数据目录不可写: {}", dir.display()))?;
    let pool = crate::db::open(&dir.join("garage-ui.sqlite")).await?;
    Ok((pool, loaded.settings.bcrypt_cost))
}

async fn format_users(pool: &SqlitePool) -> anyhow::Result<String> {
    let users = crate::db::list_users(pool)
        .await
        .map_err(|_| anyhow::anyhow!("读取用户失败"))?;
    let mut text = String::new();
    for user in users {
        text.push_str(&user.username);
        text.push(' ');
        text.push_str(&user.role);
        if user.disabled {
            text.push_str(" disabled");
        }
        text.push('\n');
    }
    Ok(text)
}

async fn reset_password(
    pool: &SqlitePool,
    username: &str,
    password: &str,
    cost: u32,
) -> anyhow::Result<()> {
    crate::password::validate(password).map_err(|_| anyhow::anyhow!("密码不符合要求"))?;
    let user = crate::db::find_user_by_name(pool, username)
        .await
        .map_err(|_| anyhow::anyhow!("读取用户失败"))?
        .ok_or_else(|| anyhow::anyhow!("用户不存在"))?;
    let hash = crate::password::hash_async(password.to_string(), cost)
        .await
        .map_err(|_| anyhow::anyhow!("无法计算口令哈希"))?;
    crate::db::update_user(
        pool,
        user.id,
        &user.role,
        user.can_download,
        user.can_share,
        user.disabled,
        Some(&hash),
    )
    .await
    .map_err(|_| anyhow::anyhow!("写入用户失败"))?;
    crate::db::delete_user_sessions(pool, user.id)
        .await
        .map_err(|_| anyhow::anyhow!("清理会话失败"))?;
    Ok(())
}

async fn create_admin(
    pool: &SqlitePool,
    username: &str,
    password: &str,
    cost: u32,
) -> anyhow::Result<()> {
    crate::api::validate_username(username).map_err(|_| anyhow::anyhow!("用户名无效"))?;
    crate::password::validate(password).map_err(|_| anyhow::anyhow!("密码不符合要求"))?;
    let hash = crate::password::hash_async(password.to_string(), cost)
        .await
        .map_err(|_| anyhow::anyhow!("无法计算口令哈希"))?;
    crate::db::insert_user(pool, username, &hash, "admin", false, false)
        .await
        .map_err(|error| {
            if duplicate_user(&error) {
                anyhow::anyhow!("用户名已存在")
            } else {
                anyhow::anyhow!("写入用户失败")
            }
        })?;
    Ok(())
}

fn duplicate_user(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(DatabaseError::is_unique_violation)
}

fn read_password() -> anyhow::Result<String> {
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|_| anyhow::anyhow!("读取密码失败"))?;
    Ok(strip_password_line(&line).to_string())
}

// 只去掉 read_line 带来的行尾。密码里的空格是口令的一部分。
fn strip_password_line(line: &str) -> &str {
    let Some(stripped) = line.strip_suffix('\n') else {
        return line;
    };
    stripped.strip_suffix('\r').unwrap_or(stripped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn offline_user_cli_lists_resets_and_creates_without_an_argv_password() {
        let reset = Cli::try_parse_from(["garage-ui", "user", "reset-password", "ada"]).unwrap();
        assert!(matches!(
            reset.command,
            Some(Command::User(UserArgs {
                action: UserCommand::ResetPassword { ref username },
            })) if username == "ada"
        ));
        let created = Cli::try_parse_from(["garage-ui", "user", "create-admin", "ada"]).unwrap();
        assert!(matches!(
            created.command,
            Some(Command::User(UserArgs {
                action: UserCommand::CreateAdmin { ref username },
            })) if username == "ada"
        ));
        assert!(
            Cli::try_parse_from(["garage-ui", "user", "reset-password", "ada", "--password",])
                .is_err()
        );
        assert!(
            Cli::try_parse_from(["garage-ui", "user", "create-admin", "ada", "--password",])
                .is_err()
        );
        let users = Cli::try_parse_from(["garage-ui", "users"]).unwrap();
        assert!(matches!(users.command, Some(Command::Users)));
        let bare = Cli::try_parse_from(["garage-ui"]).unwrap();
        assert!(bare.command.is_none());
        assert!(!bare.health);
        let health = Cli::try_parse_from(["garage-ui", "--health"]).unwrap();
        assert!(health.health);
        assert!(health.command.is_none());
        let aliased = Cli::try_parse_from(normalize_args([
            "garage-ui".to_string(),
            "-health".to_string(),
        ]))
        .unwrap();
        assert!(aliased.health);

        let listed_dir = crate::util::temp_dir();
        let listed = crate::db::open(&listed_dir.join("garage-ui.sqlite"))
            .await
            .unwrap();
        let stored_hash = "sentinel-hash-not-for-stdout";
        crate::db::insert_user(&listed, "ada", stored_hash, "admin", true, true)
            .await
            .unwrap();
        let text = format_users(&listed).await.unwrap();
        assert_eq!(text, "ada admin\n");
        assert!(!text.contains(stored_hash));
        let viewer_id = crate::db::insert_user(&listed, "bea", stored_hash, "viewer", false, false)
            .await
            .unwrap();
        crate::db::update_user(&listed, viewer_id, "viewer", false, false, true, None)
            .await
            .unwrap();
        let text = format_users(&listed).await.unwrap();
        let viewer = text.lines().nth(1).unwrap();
        assert_eq!(viewer, "bea viewer disabled");
        assert!(viewer.ends_with(" disabled"));

        let dir = crate::util::temp_dir();
        let pool = crate::db::open(&dir.join("garage-ui.sqlite"))
            .await
            .unwrap();
        let created_password = "0123456789";
        create_admin(&pool, "ada", created_password, 4)
            .await
            .unwrap();
        let users = crate::db::list_users(&pool).await.unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].username, "ada");
        assert_eq!(users[0].role, "admin");
        assert!(!users[0].can_download);
        assert!(!users[0].can_share);
        assert!(!users[0].disabled);
        assert!(crate::password::verify(
            created_password,
            &users[0].password_hash
        ));
        let first_hash = users[0].password_hash.clone();
        let user_id = users[0].id;

        assert!(create_admin(&pool, "ada", "9876543210", 4).await.is_err());
        assert_eq!(crate::db::count_users(&pool).await.unwrap(), 1);
        let still = crate::db::find_user_by_name(&pool, "ada")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(still.password_hash, first_hash);

        assert!(create_admin(&pool, "bea", "123456789", 4).await.is_err());
        assert_eq!(crate::db::count_users(&pool).await.unwrap(), 1);
        assert!(
            crate::db::find_user_by_name(&pool, "bea")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            create_admin(&pool, "a b", created_password, 4)
                .await
                .is_err()
        );
        assert_eq!(crate::db::count_users(&pool).await.unwrap(), 1);

        crate::db::update_user(&pool, user_id, "viewer", true, true, true, None)
            .await
            .unwrap();
        crate::db::insert_session(&pool, "sess-1", user_id, "csrf", "key", 10, 99)
            .await
            .unwrap();
        assert!(reset_password(&pool, "ada", "123456789", 4).await.is_err());
        assert!(
            crate::db::load_session(&pool, "sess-1")
                .await
                .unwrap()
                .is_some()
        );
        let unchanged = crate::db::find_user_by_name(&pool, "ada")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.password_hash, first_hash);
        assert_eq!(unchanged.role, "viewer");
        assert!(unchanged.can_download);
        assert!(unchanged.can_share);
        assert!(unchanged.disabled);

        let replacement = "abcdefghiJ";
        reset_password(&pool, "ada", replacement, 4).await.unwrap();
        let reset = crate::db::find_user_by_name(&pool, "ada")
            .await
            .unwrap()
            .unwrap();
        assert_ne!(reset.password_hash, first_hash);
        assert!(crate::password::verify(replacement, &reset.password_hash));
        assert!(!crate::password::verify(
            created_password,
            &reset.password_hash
        ));
        assert_eq!(reset.role, "viewer");
        assert!(reset.can_download);
        assert!(reset.can_share);
        assert!(reset.disabled);
        assert!(
            crate::db::load_session(&pool, "sess-1")
                .await
                .unwrap()
                .is_none()
        );

        let hash_after = reset.password_hash;
        assert!(
            reset_password(&pool, "missing", created_password, 4)
                .await
                .is_err()
        );
        assert_eq!(crate::db::count_users(&pool).await.unwrap(), 1);
        let after_missing = crate::db::find_user_by_name(&pool, "ada")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after_missing.password_hash, hash_after);

        assert_eq!(strip_password_line("0123456789\n"), "0123456789");
        assert_eq!(strip_password_line("0123456789\r\n"), "0123456789");
        assert_eq!(strip_password_line("  0123456789 \n"), "  0123456789 ");
        assert_eq!(strip_password_line("0123456789"), "0123456789");
    }
}
