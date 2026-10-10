use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const PLANTED: &str = "planted-admin-token-9f3a";

fn work_dir() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "garage-ui-boot-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn reject(label: &str, env: &[(&str, &str)], phrase: &str) {
    let dir = work_dir();
    let mut command = Command::new(env!("CARGO_BIN_EXE_garage-ui"));
    command
        .env_clear()
        .env("DATA_DIR", &dir)
        .env("UNUSED_PLANT", PLANTED)
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        stdout.read_to_end(&mut buf).unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        stderr.read_to_end(&mut buf).unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(3) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out_thread.join();
            let _ = err_thread.join();
            panic!("{label}: process stayed up");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let out = out_thread.join().unwrap();
    let err = err_thread.join().unwrap();
    assert!(!status.success(), "{label}: exited 0");
    assert!(
        !out.contains(PLANTED) && !err.contains(PLANTED),
        "{label}: stdio contained the planted token"
    );
    assert!(
        out.contains(phrase) || err.contains(phrase),
        "{label}: missing {phrase}\nstdout={out}\nstderr={err}"
    );
}

#[test]
fn illegal_config_exits_without_secrets() {
    let dir = work_dir();
    let missing = dir.join("missing-admin-key");
    let session = dir.join("session.key");
    std::fs::write(&session, "YOUR_SESSION_KEY\n").unwrap();
    let missing_text = missing.display().to_string();
    let session_text = session.display().to_string();

    reject("auth disabled", &[("AUTH_DISABLED", "")], "不允许关闭鉴权");
    reject("disable auth", &[("DISABLE_AUTH", "")], "不允许关闭鉴权");
    reject("no auth", &[("GARAGE_UI_NO_AUTH", "")], "不允许关闭鉴权");
    reject(
        "placeholder admin token",
        &[
            ("GARAGE_ADMIN_TOKEN", "changeme"),
            ("GARAGE_METRICS_TOKEN", PLANTED),
        ],
        "密钥与文档占位符相同，拒绝启动",
    );
    reject(
        "short admin token",
        &[("GARAGE_ADMIN_TOKEN", "short")],
        "密钥长度不足，拒绝启动",
    );
    reject(
        "placeholder metrics token",
        &[
            ("GARAGE_ADMIN_TOKEN", PLANTED),
            ("GARAGE_METRICS_TOKEN", "YOUR_METRICS_TOKEN"),
        ],
        "密钥与文档占位符相同，拒绝启动",
    );
    reject(
        "cookie secure",
        &[("COOKIE_SECURE", "yes"), ("GARAGE_ADMIN_TOKEN", PLANTED)],
        "COOKIE_SECURE 无法解析，拒绝启动",
    );
    reject(
        "missing key file",
        &[
            ("API_ADMIN_KEY_FILE", missing_text.as_str()),
            ("GARAGE_ADMIN_TOKEN", PLANTED),
        ],
        "读取密钥文件失败",
    );
    reject(
        "placeholder session key",
        &[
            ("SESSION_KEY_FILE", session_text.as_str()),
            ("GARAGE_ADMIN_TOKEN", PLANTED),
        ],
        "密钥与文档占位符相同，拒绝启动",
    );
}
